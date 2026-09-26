import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readJobs, writeJobs, appendJobs, updateJobs, findJob, JOBS_HEADER, JOBS_HEADER_V1,
} from '../scripts/lib/workspace.mjs';
import { readEval, writeEval } from '../scripts/lib/workspace.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'jobpilot-ws-'));
  return dir;
}

test('schema v1 → v2: readJobs accepts the old header and maps score → fit', async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, 'jobs.csv'), [
      JOBS_HEADER_V1.join(','),
      '1,Acme,Backend Eng,https://x.co/1,Berlin,2026-01-01,72,new,score reason',
    ].join('\n') + '\n');
    const jobs = readJobs(dir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].fit, '72'); // score migrated to fit
    assert.equal(jobs[0].posted, ''); // new columns start empty
    assert.equal(jobs[0].breakdown, '');
    assert.equal(jobs[0].notes, 'score reason');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema v1 → v2: the file upgrades on the next write, with no data loss', async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, 'jobs.csv'), [
      JOBS_HEADER_V1.join(','),
      '1,Acme,Backend Eng,https://x.co/1,Berlin,2026-01-01,72,new,score reason',
      '2,Globex,SRE,https://x.co/2,Remote,2026-01-02,,new,',
    ].join('\n') + '\n');
    updateJobs(dir, '2', { status: 'applied' });
    const text = await readFile(join(dir, 'jobs.csv'), 'utf8');
    assert.equal(text.split('\n')[0], JOBS_HEADER.join(',')); // v2 header on disk now
    const jobs = readJobs(dir);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].fit, '72');
    assert.equal(jobs[0].notes, 'score reason');
    assert.equal(jobs[1].status, 'applied');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema v2: appendJobs upgrades a v1 file before appending', async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, 'jobs.csv'), [
      JOBS_HEADER_V1.join(','),
      '1,Acme,Backend Eng,https://x.co/1,Berlin,2026-01-01,72,new,',
    ].join('\n') + '\n');
    appendJobs(dir, [{ id: '2', company: 'Globex', title: 'SRE', url: 'https://x.co/2', status: 'new', found: '2026-09-26' }]);
    const text = await readFile(join(dir, 'jobs.csv'), 'utf8');
    assert.equal(text.split('\n')[0], JOBS_HEADER.join(','));
    const jobs = readJobs(dir);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].id, '2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema v2: unknown-but-malformed header still fails loudly', async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, 'jobs.csv'), 'id,company\n1,Acme\n');
    assert.throws(() => readJobs(dir), /header mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evals/<id>.json: write + read round-trip', async () => {
  const dir = await tempWorkspace();
  try {
    writeEval(dir, 12, { id: 12, checklist: { requirements: [] }, score: { fit: 77 } });
    const ev = readEval(dir, 12);
    assert.equal(ev.score.fit, 77);
    assert.equal(readEval(dir, 99), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
