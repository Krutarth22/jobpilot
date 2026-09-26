#!/usr/bin/env node
// jobpilot learn — fit the scoring weights to the user's feedback (D2/D3).
//
//   node learn.mjs                # proposal: old → new weights, error improvement, preference suggestions
//   node learn.mjs --write       # write the new weights into profile.md (the user confirms FIRST)
//
// Needs ≥10 feedback rows (jobs.mjs feedback <id> <score> "why") to be useful;
// fewer rows fall back to a no-op with the error numbers shown.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import {
  workspaceRoot, readEval, evalsPath, profilePath,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { parseProfile } from './lib/profile.mjs';
import { feedbackRows, fitWeights, suggestPreferences } from './lib/learn.mjs';
import yaml from 'js-yaml';

const MIN_ROWS = 10;

function loadAllEvals(root) {
  const dir = evalsPath(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return readEval(root, f.replace(/\.json$/, '')); } catch { return null; }
    })
    .filter(Boolean);
}

/** Rewrite profile.md with new weights (front matter re-emitted, body untouched). */
export async function writeWeights(root, weights) {
  const file = profilePath(root);
  const text = await readFile(file, 'utf8');
  const { frontmatter, body, hasFrontmatter } = parseProfile(text);
  if (!hasFrontmatter) throw new Error('profile.md has no front matter to update — run setup first');
  const fm = { ...frontmatter, weights };
  const out = `---\n${yaml.dump(fm, { lineWidth: 120 }).trimEnd()}\n---\n\n${body}\n`;
  await rename(file, `${file}.bak`);
  await writeFile(file, out);
  return `${file}.bak`;
}

async function main(argv) {
  const write = argv.includes('--write');
  const root = workspaceRoot();
  const text = await readFile(profilePath(root), 'utf8').catch(() => '');
  const { frontmatter: profile } = parseProfile(text);
  const all = loadAllEvals(root);
  const rows = feedbackRows(all);

  if (rows.length < MIN_ROWS) {
    console.log(JSON.stringify({
      ready: false,
      rows: rows.length,
      needed: MIN_ROWS,
      message: `Collect feedback with: jobs.mjs feedback <id> <0-100> "why". ${MIN_ROWS - rows.length} more row(s) needed before fitting.`,
    }, null, 2));
    return;
  }

  const fit = fitWeights(rows, profile.weights || {});
  const suggestions = suggestPreferences(rows);

  // Never propose a worse fit: if the fitted weights don't improve the gap,
  // say so and keep the current ones.
  const improves = fit.maeAfter !== null && fit.maeBefore !== null && fit.maeAfter <= fit.maeBefore;

  console.log(JSON.stringify({
    ready: true,
    rows: fit.rows,
    weights: {
      before: profile.weights || null,
      proposed: improves ? fit.weights : null,
      maeBefore: fit.maeBefore === null ? null : Math.round(fit.maeBefore * 10) / 10,
      maeAfter: fit.maeAfter === null ? null : Math.round(fit.maeAfter * 10) / 10,
      ...(improves ? {} : { message: 'the fitted weights did not improve the gap — keeping current weights' }),
    },
    preferences: suggestions,
  }, null, 2));

  if (write && improves) {
    const backup = await writeWeights(root, fit.weights);
    console.error(`✅ weights written to profile.md (backup: ${backup})`);
  } else {
    console.error('ℹ️  proposal only — confirm with the user, then re-run with --write.');
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
