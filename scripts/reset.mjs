#!/usr/bin/env node
// jobpilot reset — start over from scratch without losing anything.
//
//   node reset.mjs [--dry-run]           move to a dated backup (undoable)
//   node reset.mjs --wipe --yes          delete everything permanently (no backup)
//
// Moves the whole workspace (profile.md, companies.yml, jobs.csv, evals/,
// out/, the original resume) to a dated sibling folder,
// <root>-backup-YYYYMMDD-HHMMSS, and leaves the workspace path empty so
// setup builds everything again from one resume. Nothing is deleted: to undo,
// move the backup folder back. ~/.jobpilot.json is kept, so the workspace
// path stays the same.

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Refuse roots where moving the folder would take more than jobpilot's data. */
export function unsafeRoot(root, { home = homedir(), plugin = pluginRoot } = {}) {
  const abs = resolve(root);
  if (abs === resolve(sep) || abs === resolve(home)) return 'the workspace is your home or root folder';
  if (abs === plugin || plugin.startsWith(abs + sep)) return 'the workspace contains the plugin itself';
  return null;
}

export function reset(root, { dryRun = false, wipe = false, now = new Date(), home, plugin } = {}) {
  const abs = resolve(root);
  if (!existsSync(abs) || readdirSync(abs).length === 0) return { root: abs, backup: null, files: [], nothingToReset: true };
  const why = unsafeRoot(abs, { home, plugin });
  if (why) throw new Error(`reset: refusing — ${why} (${abs}). Set a dedicated workspace first.`);
  const files = readdirSync(abs).sort();
  let backup = join(dirname(abs), `${basename(abs)}-backup-${stamp(now)}`);
  for (let i = 2; existsSync(backup); i++) backup = join(dirname(abs), `${basename(abs)}-backup-${stamp(now)}-${i}`);
  const resume = files.find((f) => /^resume\.(pdf|docx)$/i.test(f));
  if (wipe) {
    if (!dryRun) { rmSync(abs, { recursive: true, force: true }); }
    return { root: abs, backup: null, files, wiped: !dryRun, dryRun };
  }
  if (!dryRun) renameSync(abs, backup);
  return { root: abs, backup, files, resume: resume ? join(backup, resume) : null, dryRun };
}

if (isMainModule(import.meta.url)) {
  try {
    const has = (f) => process.argv.includes(f);
    if (has('--wipe') && !has('--yes') && !has('--dry-run')) {
      throw new Error('--wipe deletes the workspace permanently, with no backup. Add --yes to confirm (or --dry-run to preview).');
    }
    const summary = reset(workspaceRoot(), { dryRun: has('--dry-run'), wipe: has('--wipe') });
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
