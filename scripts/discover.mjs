#!/usr/bin/env node
// jobpilot discover — grow companies.yml from the resume instead of a fixed list.
//
//   node discover.mjs --queries                  # print web-search queries built from profile.md
//   node discover.mjs [--dry-run] [--max=N] URL… # extract boards from result URLs, verify, append
//   … | node discover.mjs [--dry-run] [--max=N]  # same, URLs read from stdin (any text; URLs are pulled out)
//
// A line may name the company after the URL — `<url> | PermitFlow` — since
// Lever and Ashby don't return a board name and slugs read poorly ("n8n").
//
// Greenhouse, Lever and Ashby have no cross-company search, so scan needs
// board slugs up front. Every posting URL carries its board's slug, though
// (jobs.lever.co/<slug>/…), so a web search for the user's target titles on
// those hosts turns into a list of companies hiring for exactly those roles.
// The search itself is done by the agent (the skill); this script is the
// deterministic half: URL → {provider, slug}, dedup against companies.yml,
// probe the public API, and append only boards with at least one open role
// that passes the user's title and location filters.

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { workspaceRoot, companiesPath } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { loadProfile } from './lib/profile.mjs';
import { buildTitleFilter, buildLocationFilter } from './lib/_filters.mjs';
import { probeBoard, appendEntries, saveCompanies, mapPool } from './verify-boards.mjs';
import * as greenhouse from './providers/greenhouse.mjs';

// Search-result hosts per provider. EU Lever (jobs.eu.lever.co) is left out:
// its postings live on api.eu.lever.co, which the Lever provider doesn't fetch.
const HOSTS = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
};
// Path segments that are ATS pages, not board slugs.
const NOT_SLUGS = new Set(['embed', 'v1', 'api', 'jobs', 'job', 'boards', 'search', 'apply', 'favicon.ico', 'robots.txt']);
const DEFAULT_MAX = 25;

// ── URL → board ─────────────────────────────────────────────────────────

/** `{provider, slug}` for a posting or board URL on a supported ATS, else null. */
export function parseBoardUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const provider = Object.keys(HOSTS).find((p) => HOSTS[p].includes(host));
  if (!provider) return null;

  let slug = '';
  // Greenhouse embeds: boards.greenhouse.io/embed/job_app?for=<slug>&token=…
  if (provider === 'greenhouse' && url.searchParams.get('for')) slug = url.searchParams.get('for');
  else {
    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    try {
      slug = decodeURIComponent(first);
    } catch {
      return null;
    }
  }
  slug = slug.trim();
  if (!slug || NOT_SLUGS.has(slug.toLowerCase()) || /[\s/?#]/.test(slug)) return null;
  return { provider, slug };
}

const boardKey = ({ provider, slug }) => `${provider}:${slug.toLowerCase()}`;

/** A company name given after ` | `; search results are untrusted, so keep it short and plain. */
function cleanName(raw) {
  const name = String(raw || '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= 60 && !/https?:/i.test(name) ? name : '';
}

/** Unique boards found in free text (search results, pasted links), with an
 * optional `| Name` after a URL. The first name given for a board wins. */
export function boardsFromText(text) {
  const seen = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const match of line.matchAll(/(https?:\/\/[^\s"'<>)\]|]+)(?:\s*\|\s*([^|\n]*?)(?=\s+https?:|\s*$))?/g)) {
      const board = parseBoardUrl(match[1].replace(/[.,;:]+$/, ''));
      if (!board) continue;
      const name = cleanName(match[2]);
      const prior = seen.get(boardKey(board));
      if (!prior) seen.set(boardKey(board), name ? { ...board, name } : board);
      else if (!prior.name && name) prior.name = name;
    }
  }
  return [...seen.values()];
}

/** "shield-ai" → "Shield Ai"; only used when the ATS doesn't name the board. */
export function nameFromSlug(slug) {
  return String(slug).split(/[-_.]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ── Queries ─────────────────────────────────────────────────────────────

/**
 * Web-search queries from the profile: each target title on each provider's
 * main posting host, narrowed by remote/cities when the profile states them.
 * No target titles → no queries (never guessed).
 */
export function buildQueries(profile, { maxTitles = 4 } = {}) {
  const titles = (profile.target_titles || []).map((t) => String(t).trim()).filter(Boolean).slice(0, maxTitles);
  if (titles.length === 0) return [];
  const loc = profile.locations || {};
  const place = loc.remote === 'required' || loc.remote === 'preferred' ? 'remote'
    : Array.isArray(loc.cities) && loc.cities.length > 0 ? String(loc.cities[0]) : '';
  const hosts = ['job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'];
  const queries = [];
  for (const title of titles) {
    for (const host of hosts) queries.push(`site:${host} "${title}"${place ? ` ${place}` : ''}`);
  }
  return queries;
}

// ── Verify + append ─────────────────────────────────────────────────────

/**
 * Probe candidate boards and keep the ones with at least one open role that
 * passes the user's filters. A board with no matching role isn't worth a
 * slot in companies.yml even if a search surfaced it once.
 */
export async function evaluateBoards(candidates, config, {
  probe = probeBoard,
  fetchBoardName = greenhouse.fetchBoardName,
  concurrency = 6,
} = {}) {
  const titlePasses = buildTitleFilter(config.title_filter);
  const locationPasses = buildLocationFilter(config.location_filter);
  return mapPool(candidates, concurrency, async (board) => {
    const result = await probe(board.provider, board.slug);
    if (result.live === false) return { ...board, status: 'dead', reason: result.reason };
    if (result.unknown) return { ...board, status: 'unknown', reason: result.reason };
    const matching = result.rows.filter((r) => titlePasses(r.title) && locationPasses(r.location)).length;
    if (matching === 0) return { ...board, status: 'no-match', open: result.count };
    let name = '';
    if (board.provider === 'greenhouse') {
      try { name = (await fetchBoardName(board.slug)).trim(); } catch { /* fall back to the slug */ }
    }
    return { ...board, status: 'ok', name: name || board.name || nameFromSlug(board.slug), open: result.count, matching };
  });
}

export async function discover(root, text, { dryRun = false, max = DEFAULT_MAX, ...opts } = {}) {
  const file = companiesPath(root);
  const yamlText = await readFile(file, 'utf8');
  const config = yaml.load(yamlText) || {};
  const companies = config.companies || [];
  const known = new Set(companies.filter((c) => c?.provider && c?.slug).map((c) => boardKey({ provider: String(c.provider), slug: String(c.slug) })));

  const found = boardsFromText(text);
  const fresh = found.filter((b) => !known.has(boardKey(b)));
  const results = await evaluateBoards(fresh, config, opts);

  // Most matching roles first; the cap keeps one broad search from flooding the list.
  const ok = results.filter((r) => r.status === 'ok').sort((a, b) => b.matching - a.matching || a.name.localeCompare(b.name));
  const added = ok.slice(0, max);
  const overCap = ok.slice(max);

  if (!dryRun && added.length > 0) {
    const entries = added.map(({ name, provider, slug }) => ({ name, provider, slug }));
    await saveCompanies(file, yamlText, appendEntries(yamlText, entries), [...companies, ...entries]);
  }

  return {
    urlsBoards: found.length,
    alreadyKnown: found.length - fresh.length,
    added: added.map(({ name, provider, slug, matching, open }) => ({ name, provider, slug, matching, open })),
    overCap: overCap.map(({ name, provider, slug, matching }) => ({ name, provider, slug, matching })),
    noMatch: results.filter((r) => r.status === 'no-match').map(({ provider, slug, open }) => ({ provider, slug, open })),
    dead: results.filter((r) => r.status === 'dead').map(({ provider, slug }) => ({ provider, slug })),
    unknown: results.filter((r) => r.status === 'unknown').map(({ provider, slug, reason }) => ({ provider, slug, reason })),
    dryRun,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { queries: false, dryRun: false, max: DEFAULT_MAX, urls: [] };
  for (const arg of argv) {
    if (arg === '--queries') args.queries = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--max=')) args.max = Number(arg.slice(6));
    else if (arg.startsWith('--root=')) process.env.JOBPILOT_HOME = arg.slice(7);
    else if (arg.startsWith('--')) throw new Error(`discover: unknown argument "${arg}"`);
    else args.urls.push(arg);
  }
  if (!Number.isInteger(args.max) || args.max < 1) throw new Error('discover: --max must be a positive integer');
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const args = parseArgs(argv);
  const root = workspaceRoot({ create: true });
  if (args.queries) {
    const queries = buildQueries(loadProfile(root).profile);
    if (queries.length === 0) throw new Error('discover: profile.md has no target_titles — run setup or add them first');
    for (const q of queries) console.log(q);
    return;
  }
  const text = args.urls.length > 0 ? args.urls.join('\n') : await readStdin();
  if (!text.trim()) throw new Error('discover: pass result URLs as arguments or on stdin (or --queries to get search queries)');
  const summary = await discover(root, text, { dryRun: args.dryRun, max: args.max });
  for (const a of summary.added) console.error(`${args.dryRun ? '🔍 would add' : '✅ added'} ${a.name} (${a.provider}:${a.slug}) — ${a.matching} matching of ${a.open} open`);
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
