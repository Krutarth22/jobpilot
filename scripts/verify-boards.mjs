#!/usr/bin/env node
// jobpilot verify-boards — keep companies.yml honest.
//
//   node verify-boards.mjs                     # verify every board, report dead ones
//   node verify-boards.mjs --prune             # ... and rewrite companies.yml without them
//   node verify-boards.mjs --add "Ramp" "Deel" # probe slug variants for new companies, append live boards
//
// A board is DEAD only on a 404 (or a board that returns zero jobs); network
// errors leave it in place and reported as unknown. Adapted from the probe
// approach in career-ops discover-ats.mjs (MIT).

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

async function probeBoard(provider, slug) {
  try {
    const rows = await PROVIDERS[provider].fetchBoard({ name: slug, slug });
    return rows.length > 0 ? { live: true, count: rows.length } : { live: false, reason: 'board has zero jobs' };
  } catch (err) {
    if (err?.status === 404) return { live: false, reason: '404' };
    return { unknown: true, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** First live board for a name across slug variants × providers (first match wins). */
export async function discoverBoard(name, { providers = Object.keys(PROVIDERS) } = {}) {
  for (const provider of providers) {
    for (const slug of slugVariants(name)) {
      const result = await probeBoard(provider, slug);
      if (result.live) return { name, provider, slug, count: result.count };
    }
  }
  return null;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

async function verifyAll(root, { prune = false } = {}) {
  const file = companiesPath(root);
  const config = yaml.load(await readFile(file, 'utf8'));
  const companies = (config.companies || []).filter((c) => c?.name && c?.slug && PROVIDERS[c.provider]);
  const results = await mapPool(companies, CONCURRENCY, async (entry) => ({ entry, result: await probeBoard(entry.provider, entry.slug) }));

  const dead = results.filter(({ result }) => result.live === false);
  const unknown = results.filter(({ result }) => result.unknown);
  const alive = results.filter(({ result }) => result.live);

  for (const { entry, result } of dead) console.error(`💀 dead: ${entry.provider}:${entry.slug} (${entry.name}) — ${result.reason}`);
  for (const { entry, result } of unknown) console.error(`❓ unknown: ${entry.provider}:${entry.slug} (${entry.name}) — ${result.reason}`);
  console.log(JSON.stringify({
    boards: companies.length,
    live: alive.length,
    dead: dead.length,
    unknown: unknown.length,
    pruned: prune ? dead.map(({ entry }) => entry.slug) : [],
  }, null, 2));

  if (prune && dead.length > 0) {
    const deadKeys = new Set(dead.map(({ entry }) => `${entry.provider}:${entry.slug}`));
    config.companies = (config.companies || []).filter((c) => !deadKeys.has(`${c.provider}:${c.slug}`));
    await rename(file, `${file}.bak`);
    await writeFile(file, yaml.dump(config, { lineWidth: 120 }));
    console.error(`✂️  pruned ${dead.length} board(s); backup at companies.yml.bak`);
  }
  return { dead: dead.length, unknown: unknown.length };
}

async function addCompanies(root, names) {
  const file = companiesPath(root);
  const config = yaml.load(await readFile(file, 'utf8'));
  const existing = new Set((config.companies || []).map((c) => String(c.name).toLowerCase()));
  const added = [];
  for (const name of names) {
    if (existing.has(name.toLowerCase())) { console.error(`⏭️  ${name}: already in companies.yml`); continue; }
    const found = await discoverBoard(name);
    if (found) {
      config.companies = config.companies || [];
      config.companies.push({ name: found.name, provider: found.provider, slug: found.slug });
      added.push(found);
      console.error(`✅ ${name}: ${found.provider}:${found.slug} (${found.count} jobs)`);
    } else {
      console.error(`❌ ${name}: no live Greenhouse/Lever/Ashby board found for slug variants ${slugVariants(name).join(', ')}`);
    }
  }
  if (added.length > 0) {
    await rename(file, `${file}.bak`);
    await writeFile(file, yaml.dump(config, { lineWidth: 120 }));
    console.error(`💾 appended ${added.length} board(s); backup at companies.yml.bak`);
  }
  console.log(JSON.stringify({ added }, null, 2));
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
