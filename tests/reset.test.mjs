import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reset, unsafeRoot } from '../scripts/reset.mjs';

function workspace() {
  const parent = mkdtempSync(join(tmpdir(), 'jobpilot-reset-'));
  const root = join(parent, 'jobpilot');
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'profile.md'), 'old profile');
  writeFileSync(join(root, 'resume.pdf'), 'pdf');
  return { parent, root };
}

const NOW = new Date(2026, 8, 27, 9, 5, 3);

test('reset: moves the workspace to a dated backup, deletes nothing', () => {
  const { parent, root } = workspace();
  const s = reset(root, { now: NOW });
  assert.equal(s.backup, join(parent, 'jobpilot-backup-20260927-090503'));
  assert.equal(existsSync(root), false);
  assert.equal(readFileSync(join(s.backup, 'profile.md'), 'utf8'), 'old profile');
  assert.equal(s.resume, join(s.backup, 'resume.pdf'));
  assert.deepEqual(s.files, ['evals', 'profile.md', 'resume.pdf']);
});

test('reset: a second reset in the same second gets its own folder', () => {
  const { parent, root } = workspace();
  reset(root, { now: NOW });
  mkdirSync(root);
  writeFileSync(join(root, 'profile.md'), 'newer');
  assert.equal(reset(root, { now: NOW }).backup, join(parent, 'jobpilot-backup-20260927-090503-2'));
});

test('reset: --dry-run and empty workspaces change nothing', () => {
  const { root } = workspace();
  assert.ok(reset(root, { dryRun: true, now: NOW }).backup);
  assert.ok(existsSync(join(root, 'profile.md')));
  const empty = mkdtempSync(join(tmpdir(), 'jobpilot-empty-'));
  assert.equal(reset(empty).nothingToReset, true);
  assert.equal(reset(join(empty, 'missing')).nothingToReset, true);
});

test('reset: refuses home, filesystem root and folders holding the plugin', () => {
  assert.match(unsafeRoot('/Users/x', { home: '/Users/x', plugin: '/opt/p' }), /home/);
  assert.match(unsafeRoot('/', { home: '/Users/x', plugin: '/opt/p' }), /home or root/);
  assert.match(unsafeRoot('/opt', { home: '/Users/x', plugin: '/opt/p' }), /plugin/);
  assert.equal(unsafeRoot('/Users/x/jobpilot', { home: '/Users/x', plugin: '/opt/p' }), null);
});
