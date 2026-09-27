#!/usr/bin/env node
// jobpilot comp — calibrate total-comp multipliers from real pay data.
//
//   node comp.mjs calibrate <lookups.json> [--dry-run]
//   node comp.mjs show
//
// Postings list base pay; offers are judged on total (base + bonus + equity).
// The scorer bridges the two with multipliers in profile.md's comp table
// (see totalCompMultiplier in score.mjs). This script turns pay lookups the
// agent made — levels.fyi for tech, Glassdoor/Payscale, BLS, published pay
// scales, bonus surveys for finance — into that table:
//
//   company:<Name>          that company's own total/base ratio
//   stage:<type>            median ratio for a company type (public, startup,
//                           bank, hedge-fund, hospital, government, … — any label)
//   default                 median over every lookup (needs ≥3)
//
// A lookup may name the scorer level it was made for ("level":
// "senior-manager"); then the level-specific keys are written too, so a
// Director posting is estimated with Director ratios:
//
//   company:<Name>@<level>  <level>@<type>  <level>
//
// and tags each looked-up company in companies.yml with its type. Hand-set
// keys (manager@public, a level) are kept. The lookups file:
//
//   { "source": "levels.fyi", "role": "Senior Engineering Manager",
//     "companies": [
//       { "company": "Stripe", "stage": "public", "base": 290000, "total": 520000 },
//       { "company": "Mount Sinai", "stage": "hospital", "base": 240000, "total": 252000, "source": "Glassdoor" },
//       { "company": "Stripe", "stage": "public", "level": "director", "base": 330000, "total": 700000 },
//       { "company": "Figma", "stage": "public" }            // type only, no pay data
//     ] }
//
// Pay figures are annual medians in the profile's currency. A lookup whose
// ratio is implausible (total < base, or more than 5× base) is rejected, not
// clamped.

import { readFile, writeFile, rename } from 'node:fs/promises';
import yaml from 'js-yaml';
import { workspaceRoot, companiesPath, profilePath } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { loadProfile, setFrontmatterField } from './lib/profile.mjs';
import { entryLine, saveCompanies } from './verify-boards.mjs';
import { LEVELS } from './lib/signals.mjs';

const MAX_RATIO = 5;
const MIN_FOR_DEFAULT = 3;

const round2 = (n) => Math.round(n * 100) / 100;
const slugStage = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Validate lookups and compute per-company, per-type and default ratios. */
export function computeMultipliers(lookups) {
  const defaultSource = String(lookups?.source || '').trim();
  const accepted = [];
  const rejected = [];
  const stages = [];
  for (const raw of Array.isArray(lookups?.companies) ? lookups.companies : []) {
    const company = String(raw?.company || '').trim();
    if (!company) { rejected.push({ company: '', reason: 'no company name' }); continue; }
    const stage = slugStage(raw.stage);
    if (stage && !stages.some((x) => x.company.toLowerCase() === company.toLowerCase())) stages.push({ company, stage });
    const level = raw.level == null || raw.level === '' ? '' : String(raw.level).trim().toLowerCase();
    if (level && !LEVELS.includes(level)) { rejected.push({ company, reason: `unknown level "${raw.level}" (use: ${LEVELS.join(', ')})` }); continue; }
    const hasPay = raw.base != null || raw.total != null;
    if (!hasPay) continue;
    const base = Number(raw.base);
    const total = Number(raw.total);
    if (!(base > 0) || !(total > 0)) { rejected.push({ company, reason: 'base and total must both be positive numbers' }); continue; }
    const ratio = total / base;
    if (ratio < 1) { rejected.push({ company, reason: `total ${total} is below base ${base}` }); continue; }
    if (ratio > MAX_RATIO) { rejected.push({ company, reason: `ratio ${round2(ratio)} is above ${MAX_RATIO}× — check the figures` }); continue; }
    accepted.push({ company, stage, level, base, total, ratio: round2(ratio), source: String(raw.source || defaultSource || 'unknown') });
  }

  // Median ratio per key; every lookup feeds its level-free keys too, so a
  // posting at a level nobody looked up still gets the company's own ratio.
  const groups = new Map();
  const add = (key, ratio) => groups.set(key, [...(groups.get(key) || []), ratio]);
  for (const a of accepted) {
    add(`company:${a.company}`, a.ratio);
    if (a.stage) add(`stage:${a.stage}`, a.ratio);
    if (a.level) {
      add(`company:${a.company}@${a.level}`, a.ratio);
      if (a.stage) add(`${a.level}@${a.stage}`, a.ratio);
      add(a.level, a.ratio);
    }
  }
  const multipliers = {};
  for (const [key, ratios] of groups) multipliers[key] = round2(median(ratios));
  const stageSummary = [...groups]
    .filter(([key]) => key.startsWith('stage:') || (!key.startsWith('company:') && key.includes('@')) || LEVELS.includes(key))
    .map(([key, ratios]) => ({ stage: key.replace(/^stage:/, ''), ratio: multipliers[key], n: ratios.length }))
    .sort((a, b) => a.stage.localeCompare(b.stage));
  const def = accepted.length >= MIN_FOR_DEFAULT ? round2(median(accepted.map((a) => a.ratio))) : null;
  if (def !== null) multipliers.default = def;

  const sources = [...new Set(accepted.map((a) => a.source))];
  return { multipliers, accepted, rejected, stages, stageSummary, default: def, sources };
}

/** New comp table: calibrated keys replace old calibrated keys (company:,
 * stage:, default); hand-set keys stay. An old default survives when too
 * few lookups were made to compute a new one. */
export function mergeComp(comp, result, today) {
  const old = comp?.multipliers && typeof comp.multipliers === 'object' ? comp.multipliers : {};
  const kept = Object.fromEntries(Object.entries(old).filter(([k]) => !/^(company|stage):/i.test(k) && (k !== 'default' || result.default === null)));
  return {
    ...comp,
    multipliers: { ...kept, ...result.multipliers },
    calibrated: { sources: result.sources, date: today, companies: result.accepted.length },
  };
}

/** Set `stage:` on companies.yml entries by name; returns the edited text
 * and the names it couldn't find. */
export function tagStages(text, stages) {
  const want = new Map(stages.map((s) => [s.company.toLowerCase(), s.stage]));
  const found = new Set();
  const lines = text.split('\n').map((line) => {
    const m = line.match(/^(\s*)-\s*\{.*\}\s*(#.*)?$/);
    if (!m) return line;
    let entry;
    try { [entry] = yaml.load(line.trim()); } catch { return line; }
    const stage = entry?.name ? want.get(String(entry.name).toLowerCase()) : undefined;
    if (!stage) return line;
    found.add(String(entry.name).toLowerCase());
    return entryLine({ ...entry, stage }) + (m[2] ? ` ${m[2]}` : '');
  });
  return { text: lines.join('\n'), missing: stages.filter((s) => !found.has(s.company.toLowerCase())).map((s) => s.company) };
}

export async function calibrate(root, lookups, { dryRun = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const result = computeMultipliers(lookups);
  const { profile } = loadProfile(root);
  const comp = mergeComp(profile.comp, result, today);

  const cfile = companiesPath(root);
  const ctext = await readFile(cfile, 'utf8');
  const tagged = tagStages(ctext, result.stages);

  if (!dryRun) {
    if (result.accepted.length > 0) {
      const pfile = profilePath(root);
      const ptext = await readFile(pfile, 'utf8');
      const next = setFrontmatterField(ptext, 'comp', comp);
      await rename(pfile, `${pfile}.bak`);
      await writeFile(pfile, next);
    }
    if (result.stages.length > 0 && tagged.text !== ctext) {
      const expected = yaml.load(tagged.text)?.companies || [];
      await saveCompanies(cfile, ctext, tagged.text, expected);
    }
  }
  return {
    accepted: result.accepted,
    rejected: result.rejected,
    stages: result.stageSummary,
    default: result.default ?? comp.multipliers.default ?? null,
    defaultComputed: result.default !== null,
    notInCompanies: tagged.missing,
    multipliers: comp.multipliers,
    dryRun,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function table(summary) {
  const rows = summary.accepted.map((a) => `  ${a.company.padEnd(22)} ${(a.stage || '-').padEnd(12)} ${(a.level || '-').padEnd(15)} ${String(a.base).padStart(8)} ${String(a.total).padStart(8)}  ×${a.ratio.toFixed(2)}  (${a.source})`);
  const out = [`  ${'company'.padEnd(22)} ${'type'.padEnd(12)} ${'level'.padEnd(15)} ${'base'.padStart(8)} ${'total'.padStart(8)}  ratio`, ...rows];
  for (const s of summary.stages) out.push(`  ${s.stage}: ×${s.ratio.toFixed(2)} (median of ${s.n})`);
  out.push(`  default: ${summary.default === null ? 'none' : `×${Number(summary.default).toFixed(2)}`}${summary.defaultComputed ? '' : ' (kept — fewer than 3 lookups)'}`);
  for (const r of summary.rejected) out.push(`  ✖ ${r.company || '(unnamed)'}: ${r.reason}`);
  if (summary.notInCompanies.length > 0) out.push(`  ⚠️  not in companies.yml (type not saved): ${summary.notInCompanies.join(', ')}`);
  return out.join('\n');
}

async function main(argv) {
  const root = workspaceRoot({ create: true });
  const [cmd, file] = argv.filter((a) => !a.startsWith('--'));
  if (cmd === 'show') {
    const { profile } = loadProfile(root);
    console.log(JSON.stringify(profile.comp || {}, null, 2));
    return;
  }
  if (cmd !== 'calibrate' || !file) throw new Error('usage: comp.mjs calibrate <lookups.json> [--dry-run] | comp.mjs show');
  const lookups = JSON.parse(await readFile(file, 'utf8'));
  const summary = await calibrate(root, lookups, { dryRun: argv.includes('--dry-run') });
  console.error(table(summary));
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
