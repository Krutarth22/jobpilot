#!/usr/bin/env node
// jobpilot scan — zero-token posting scanner over Greenhouse/Lever/Ashby.
//
//   node scan.mjs [--root=DIR] [--limit N]
//
// Reads companies.yml from the workspace, fetches every board's public API,
// filters by title and location, dedups against jobs.csv (by normalized URL),
// and appends new rows with status=new. No LLM involved: scanning costs zero
// tokens.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { workspaceRoot, readJobs, appendJobs, normalizeUrl, nextJobId } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { buildTitleFilter, buildLocationFilter } from './lib/_filters.mjs';
import * as greenhouse from './providers/greenhouse.mjs';
import * as lever from './providers/lever.mjs';
import * as ashby from './providers/ashby.mjs';

const PROVIDERS = { greenhouse, lever, ashby };

function parseArgs(argv) {
  const args = { root: undefined, limit: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--root=')) args.root = arg.slice(7);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice(8));
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

export function toCsvRows(newJobs, startId, today) {
  return newJobs.map((job, i) => ({
    id: String(startId + i),
    company: job.company || '',
    title: job.title || '',
    url: job.url,
    location: job.location || '',
    found: today,
    fit: '',
    status: 'new',
    notes: '',
  }));
}

export async function scan({ root: rootArg, limit } = {}) {
  if (rootArg) process.env.JOBPILOT_HOME = rootArg;
  const root = workspaceRoot({ create: true });
  const { config, companies } = await loadCompanies(root);
  const titlePasses = buildTitleFilter(config.title_filter);
  const locationPasses = buildLocationFilter(config.location_filter);

  const existing = new Set(readJobs(root).map((j) => j.url));
  const today = new Date().toISOString().slice(0, 10);

  let fetched = 0;
  let filtered = 0;
  let dupes = 0;
  let failed = 0;
  const newJobs = [];

  await mapPool(companies, 6, async (entry) => {
    const provider = PROVIDERS[entry.provider];
    try {
      const rows = await provider.fetchBoard(entry);
      fetched += rows.length;
      for (const row of rows) {
        if (!row.url) continue;
        if (!titlePasses(row.title) || !locationPasses(row.location)) { filtered++; continue; }
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
  const rows = toCsvRows(capped, nextJobId(readJobs(root)), today);
  appendJobs(root, rows);

  const summary = {
    boards: companies.length,
    failed,
    fetched,
    filteredByFilters: filtered,
    duplicates: dupes,
    added: rows.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (rows.length > 0) {
    for (const r of rows) console.log(`  + #${r.id} [${r.company}] ${r.title} — ${r.location || 'location n/a'}`);
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
