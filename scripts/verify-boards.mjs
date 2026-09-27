#!/usr/bin/env node
// jobpilot verify-boards — keep companies.yml honest.
//
//   node verify-boards.mjs                     # verify every board, report dead ones
//   node verify-boards.mjs --prune             # ... and rewrite companies.yml without them
//   node verify-boards.mjs --add "Ramp" "Deel" # probe slug variants for new companies, append live boards
//
// A board is DEAD only on a 404. A board with zero open jobs is EMPTY — the
// company exists and just isn't hiring today — and is never pruned. Network
// errors leave a board in place, reported as unknown. Edits to companies.yml
// keep its comments and layout. Adapted from the probe approach in career-ops
// discover-ats.mjs (MIT).

import { readFile, writeFile, rename } from 'node:fs/promises';
import yaml from 'js-yaml';
import { workspaceRoot, companiesPath } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import * as greenhouse from './providers/greenhouse.mjs';
import * as lever from './providers/lever.mjs';
import * as ashby from './providers/ashby.mjs';

const PROVIDERS = { greenhouse, lever, ashby };
const CONCURRENCY = 6;

/** Slug variants probed for a company name (plan: acme, acmeinc, acme-ai …). */
export function slugVariants(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const compact = base.replace(/-/g, '');
  if (!base) return [];
  const variants = [base, compact, `${base}inc`, `${compact}inc`, `${base}ai`, `${compact}ai`, `${base}hq`];
  return [...new Set(variants)];
}

export async function probeBoard(provider, slug, { fetchBoard = PROVIDERS[provider].fetchBoard } = {}) {
  try {
    const rows = await fetchBoard({ name: slug, slug });
    return { live: true, count: rows.length, rows };
  } catch (err) {
    if (err?.status === 404) return { live: false, reason: '404' };
    return { unknown: true, reason: err instanceof Error ? err.message : String(err) };
  }
}

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const startsWithWords = (haystack, needle) => needle.length > 0 && needle.every((w, i) => haystack[i] === w);

/**
 * Does this board belong to `name`? Slugs collide ("ramp" on one ATS can be
 * a different company), so a guessed slug is only trusted when Greenhouse's
 * board name matches word for word ("Ramp" ↔ "Ramp Health", never
 * "Rampart"), or a posting's description names the company as whole words.
 */
export async function boardMatchesName(provider, slug, name, rows, { fetchBoardName = greenhouse.fetchBoardName } = {}) {
  const want = words(name);
  if (want.length === 0) return false;
  if (provider === 'greenhouse') {
    try {
      const board = words(await fetchBoardName(slug));
      return startsWithWords(board, want) || startsWithWords(want, board);
    } catch {
      return false;
    }
  }
  const phrase = ` ${want.join(' ')} `;
  return rows.slice(0, 10).some((r) => ` ${words(r.description).join(' ')} `.includes(phrase));
}

/**
 * Probe slug variants × providers for a company name. Returns the first
 * board confirmed to belong to it, plus live-but-unconfirmed candidates the
 * user can check by hand.
 */
export async function discoverBoard(name, { providers = Object.keys(PROVIDERS), probe = probeBoard, matches = boardMatchesName } = {}) {
  const unconfirmed = [];
  for (const provider of providers) {
    for (const slug of slugVariants(name)) {
      const result = await probe(provider, slug);
      if (!result.live || result.count === 0) continue;
      if (await matches(provider, slug, name, result.rows)) {
        return { found: { name, provider, slug, count: result.count }, unconfirmed };
      }
      unconfirmed.push({ provider, slug, count: result.count });
    }
  }
  return { found: null, unconfirmed };
}

// ── Comment-preserving companies.yml edits ─────────────────────────────

function entryLine(entry) {
  const flow = yaml.dump(entry, { flowLevel: 0, lineWidth: -1 }).trim(); // {name: X, …}
  return `  - ${flow.replace(/^\{/, '{ ').replace(/\}$/, ' }')}`;
}

/** Append entries at the end of the `companies:` list, keeping everything
 * else (comments, filters, layout) byte-for-byte. */
export function appendEntries(text, entries) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^companies:\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#-]/.test(lines[i])) { end = i; break; } // next top-level key
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--; // keep trailing blank lines after the list
  lines.splice(end, 0, ...entries.map(entryLine));
  return lines.join('\n');
}

/** Remove single-line flow entries for the given provider:slug keys. */
export function removeEntries(text, deadKeys) {
  return text.split('\n').filter((line) => {
    const m = line.match(/^\s*-\s*\{.*\}\s*(#.*)?$/);
    if (!m) return true;
    try {
      const [entry] = yaml.load(line.trim());
      return !deadKeys.has(`${entry?.provider}:${entry?.slug}`);
    } catch {
      return true;
    }
  }).join('\n');
}

/** Write companies.yml via a text edit when it round-trips; fall back to a
 * full re-dump (which loses comments) only when the file isn't in the
 * one-entry-per-line style. */
export async function saveCompanies(file, text, edited, expected) {
  const ok = edited !== null && (yaml.load(edited)?.companies || []).length === expected.length;
  await rename(file, `${file}.bak`);
  if (ok) {
    await writeFile(file, edited);
  } else {
    const config = yaml.load(text);
    config.companies = expected;
    await writeFile(file, yaml.dump(config, { lineWidth: 120 }));
    console.error('⚠️  companies.yml is not one entry per line — rewrote it without comments (backup kept)');
  }
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function verifyAll(root, { prune = false } = {}) {
  const file = companiesPath(root);
  const text = await readFile(file, 'utf8');
  const config = yaml.load(text);
  const companies = (config.companies || []).filter((c) => c?.name && c?.slug && PROVIDERS[c.provider]);
  const results = await mapPool(companies, CONCURRENCY, async (entry) => ({ entry, result: await probeBoard(entry.provider, entry.slug) }));

  const dead = results.filter(({ result }) => result.live === false);
  const unknown = results.filter(({ result }) => result.unknown);
  const alive = results.filter(({ result }) => result.live);
  const empty = alive.filter(({ result }) => result.count === 0);

  for (const { entry, result } of dead) console.error(`💀 dead: ${entry.provider}:${entry.slug} (${entry.name}) — ${result.reason}`);
  for (const { entry } of empty) console.error(`💤 empty: ${entry.provider}:${entry.slug} (${entry.name}) — no open jobs today (kept)`);
  for (const { entry, result } of unknown) console.error(`❓ unknown: ${entry.provider}:${entry.slug} (${entry.name}) — ${result.reason}`);
  console.log(JSON.stringify({
    boards: companies.length,
    live: alive.length,
    empty: empty.length,
    dead: dead.length,
    unknown: unknown.length,
    pruned: prune ? dead.map(({ entry }) => entry.slug) : [],
  }, null, 2));

  if (prune && dead.length > 0) {
    const deadKeys = new Set(dead.map(({ entry }) => `${entry.provider}:${entry.slug}`));
    const kept = (config.companies || []).filter((c) => !deadKeys.has(`${c.provider}:${c.slug}`));
    await saveCompanies(file, text, removeEntries(text, deadKeys), kept);
    console.error(`✂️  pruned ${dead.length} board(s); backup at companies.yml.bak`);
  }
  return { dead: dead.length, unknown: unknown.length };
}

async function addCompanies(root, names) {
  const file = companiesPath(root);
  const text = await readFile(file, 'utf8');
  const config = yaml.load(text);
  const existing = new Set((config.companies || []).map((c) => String(c.name).toLowerCase()));
  const added = [];
  const unconfirmed = [];
  for (const name of names) {
    if (existing.has(name.toLowerCase())) { console.error(`⏭️  ${name}: already in companies.yml`); continue; }
    const { found, unconfirmed: maybes } = await discoverBoard(name);
    if (found) {
      added.push(found);
      console.error(`✅ ${name}: ${found.provider}:${found.slug} (${found.count} jobs)`);
    } else if (maybes.length > 0) {
      unconfirmed.push({ name, candidates: maybes });
      console.error(`❔ ${name}: live boards found but none confirmed as this company — ${maybes.map((m) => `${m.provider}:${m.slug}`).join(', ')} (not added; check by hand)`);
    } else {
      console.error(`❌ ${name}: no live Greenhouse/Lever/Ashby board found for slug variants ${slugVariants(name).join(', ')}`);
    }
  }
  if (added.length > 0) {
    const entries = added.map(({ name, provider, slug }) => ({ name, provider, slug }));
    await saveCompanies(file, text, appendEntries(text, entries), [...(config.companies || []), ...entries]);
    console.error(`💾 appended ${added.length} board(s); backup at companies.yml.bak`);
  }
  console.log(JSON.stringify({ added, unconfirmed }, null, 2));
}

async function main(argv) {
  const root = workspaceRoot({ create: true });
  const prune = argv.includes('--prune');
  const addIdx = argv.indexOf('--add');
  if (addIdx !== -1) {
    const names = argv.slice(addIdx + 1).filter((a) => !a.startsWith('--'));
    if (names.length === 0) { console.error('--add needs at least one company name'); process.exit(1); }
    await addCompanies(root, names);
  } else {
    await verifyAll(root, { prune });
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
