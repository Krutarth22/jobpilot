#!/usr/bin/env node
// jobpilot scan — zero-token posting scanner over Greenhouse/Lever/Ashby.
//
//   node scan.mjs [--root=DIR] [--limit=N] [--no-sweep] [--no-near-miss]
//
// Reads companies.yml from the workspace, fetches every board's public API,
// filters by title and location, dedups against jobs.csv (by normalized URL),
// and appends new rows with status=new. Keeps each provider's posting date and
// Ashby salary (B1), flags probable reposts (B3), sweeps closed postings (B4)
// and reports near-miss titles the title filter may be too narrow for (B5).
// No LLM involved: scanning costs zero tokens.

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  workspaceRoot, readJobs, appendJobs, normalizeUrl, nextJobId, updateJobs,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { buildTitleFilter, buildLocationFilter } from './lib/_filters.mjs';
import { loadProfile } from './lib/profile.mjs';
import { formatSalary } from './lib/signals.mjs';
import { findReposts, roleTokens } from './lib/repost.mjs';
import { sweepClosed } from './lib/sweep.mjs';
import * as greenhouse from './providers/greenhouse.mjs';
import * as lever from './providers/lever.mjs';
import * as ashby from './providers/ashby.mjs';

const PROVIDERS = { greenhouse, lever, ashby };

function parseArgs(argv) {
  const args = { root: undefined, limit: undefined, sweep: true, nearMiss: true };
  for (const arg of argv) {
    if (arg.startsWith('--root=')) args.root = arg.slice(7);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice(8));
    else if (arg === '--no-sweep') args.sweep = false;
    else if (arg === '--no-near-miss') args.nearMiss = false;
    else throw new Error(`scan: unknown argument "${arg}"`);
  }
  return args;
}

async function loadCompanies(root) {
  const text = await readFile(`${root}/companies.yml`, 'utf8');
  const config = yaml.load(text);
  if (!config || typeof config !== 'object') throw new Error('companies.yml is empty');
  const companies = (config.companies || [])
    .filter((c) => c && typeof c === 'object' && c.name && c.slug)
    .map((c) => ({ name: String(c.name), provider: String(c.provider || ''), slug: String(c.slug) }))
    .filter((c) => {
      if (!PROVIDERS[c.provider]) {
        console.error(`⚠️  skipping ${c.name}: unknown provider "${c.provider}" (use: ${Object.keys(PROVIDERS).join(', ')})`);
        return false;
      }
      return true;
    });
  return { config, companies };
}

/** Small-concurrency map that preserves input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── B1: keep dates and salary ───────────────────────────────────────────

function isoDate(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '';
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function toCsvRows(newJobs, startId, today, { existingRows = [], nowMs = Date.now() } = {}) {
  return newJobs.map((job, i) => {
    const repost = findReposts({ ...job, id: null }, existingRows);
    return {
      id: String(startId + i),
      company: job.company || '',
      title: job.title || '',
      url: job.url,
      location: job.location || '',
      found: today,
      posted: isoDate(job.postedAt),
      salary: job.salary ? formatSalary(job.salary) : '',
      fit: '',
      rank: '',
      breakdown: '',
      status: 'new',
      outcome: '',
      notes: repost.count > 0 ? `repost ×${repost.count + 1} (like #${repost.ids.join(',#')})` : '',
    };
  });
}

// ── B5: near-miss titles ────────────────────────────────────────────────

function tokenize(title) {
  return [...new Set(String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3))];
}

export function nearMissTitles(nearMiss, targetTitles, { limit = 10 } = {}) {
  const targetTokens = new Set((targetTitles || []).flatMap(tokenize));
  if (targetTokens.size === 0) return [];
  const scored = [];
  for (const { title, location } of nearMiss) {
    const tokens = tokenize(title);
    const shared = tokens.filter((t) => targetTokens.has(t));
    if (shared.length >= 2) scored.push({ title, location, shared });
  }
  scored.sort((a, b) => b.shared.length - a.shared.length || a.title.localeCompare(b.title));
  return scored.slice(0, limit);
}

// ── Scan ────────────────────────────────────────────────────────────────

export async function scan({ root: rootArg, limit, sweep = true, nearMiss = true } = {}) {
  if (rootArg) process.env.JOBPILOT_HOME = rootArg;
  const root = workspaceRoot({ create: true });
  const { config, companies } = await loadCompanies(root);
  const titlePasses = buildTitleFilter(config.title_filter);
  const locationPasses = buildLocationFilter(config.location_filter);
  const { profile } = loadProfile(root);

  const existingRows = readJobs(root);
  const existing = new Set(existingRows.map((j) => j.url));
  const today = new Date().toISOString().slice(0, 10);

  let fetched = 0;
  let filtered = 0;
  let dupes = 0;
  let failed = 0;
  const newJobs = [];
  const nearMissPool = [];

  await mapPool(companies, 6, async (entry) => {
    const provider = PROVIDERS[entry.provider];
    try {
      const rows = await provider.fetchBoard(entry);
      fetched += rows.length;
      for (const row of rows) {
        if (!row.url) continue;
        if (!locationPasses(row.location)) { filtered++; continue; }
        if (!titlePasses(row.title)) {
          // Passed location, failed title — candidate for the near-miss report.
          nearMissPool.push({ title: row.title, location: row.location || '' });
          filtered++;
          continue;
        }
        const key = normalizeUrl(row.url);
        if (existing.has(key)) { dupes++; continue; }
        existing.add(key);
        newJobs.push({ ...row, url: key });
      }
    } catch (err) {
      failed++;
      const cause = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  ${entry.provider}:${entry.slug} (${entry.name}) failed — ${cause}`);
    }
  });

  // Keep boards in companies.yml order, then title — deterministic row ids.
  const order = new Map(companies.map((c, i) => [c.name, i]));
  newJobs.sort((a, b) => (order.get(a.company) ?? 0) - (order.get(b.company) ?? 0) || a.title.localeCompare(b.title));

  const capped = Number.isInteger(limit) && limit > 0 ? newJobs.slice(0, limit) : newJobs;
  const rows = toCsvRows(capped, nextJobId(existingRows), today, { existingRows });
  appendJobs(root, rows);

  // B4: sweep closed postings automatically (bounded, best-effort).
  let swept;
  if (sweep) {
    try {
      swept = await sweepClosed(root, { limit: 40 });
    } catch (err) {
      console.error(`⚠️  sweep failed (continuing): ${err.message}`);
      swept = { checked: 0, closed: 0 };
    }
  }

  const summary = {
    boards: companies.length,
    failed,
    fetched,
    filteredByFilters: filtered,
    duplicates: dupes,
    added: rows.length,
    reposts: rows.filter((r) => r.notes.includes('repost')).length,
    swept: swept ? { checked: swept.checked, closed: swept.closed } : undefined,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (rows.length > 0) {
    for (const r of rows) console.log(`  + #${r.id} [${r.company}] ${r.title} — ${r.location || 'location n/a'}${r.posted ? ` (posted ${r.posted})` : ''}${r.salary ? ` [${r.salary}]` : ''}${r.notes ? ` ⚠️ ${r.notes}` : ''}`);
  }

  // B5: near-miss report — titles the filter may be too narrow for.
  if (nearMiss) {
    const nearMisses = nearMissTitles(nearMissPool, profile.target_titles || []);
    if (nearMisses.length > 0) {
      console.log(`\n🔎 Near misses (passed location, failed title filter, share ≥2 keywords with your targets):`);
      for (const nm of nearMisses) {
        console.log(`  ~ ${nm.title} — suggests filter keywords: ${nm.shared.join(' + ')}`);
      }
      summary.nearMisses = nearMisses;
    }
  }

  if (failed === companies.length && companies.length > 0) {
    throw new Error('scan: every board failed — check your network or companies.yml');
  }
  return summary;
}

if (isMainModule(import.meta.url)) {
  scan(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(`❌ scan failed: ${err.message}`);
    process.exit(1);
  });
}
