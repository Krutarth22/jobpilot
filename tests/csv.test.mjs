import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsvLine, csvRow, normalizeUrl, jobFromFields, JOBS_HEADER,
} from '../scripts/lib/workspace.mjs';
import { toCsvRows } from '../scripts/scan.mjs';

test('csv: quoted fields with commas, quotes and newlines round-trip', () => {
  const row = csvRow(['1', 'Acme, Inc.', 'Engineer "III"', 'said "hi"\nbye', '', '', '', 'new', '']);
  const parsed = parseCsvLine(row);
  assert.deepEqual(parsed, ['1', 'Acme, Inc.', 'Engineer "III"', 'said "hi"\nbye', '', '', '', 'new', '']);
});

test('csv: plain line parses', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
});

test('normalizeUrl: tracking params, fragment, trailing slash, host case', () => {
  assert.equal(
    normalizeUrl('HTTPS://Jobs.Lever.co/acme/123-abc/?utm_source=linkedin&gh_src=x#form'),
    'https://jobs.lever.co/acme/123-abc?gh_src=x',
  );
});

test('normalizeUrl: job id is kept (greenhouse gh_jid)', () => {
  assert.equal(
    normalizeUrl('https://job-boards.greenhouse.io/acme/jobs/4455667?gh_jid=4455667&utm_medium=job-board'),
    'https://job-boards.greenhouse.io/acme/jobs/4455667?gh_jid=4455667',
  );
});

test('toCsvRows: sequential ids, status new, found date', () => {
  const rows = toCsvRows([
    { company: 'Acme', title: 'Backend Engineer', url: 'https://x.co/1', location: 'Berlin' },
    { company: 'Globex', title: 'SRE', url: 'https://y.co/2', location: '' },
  ], 7, '2026-09-26');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, '7');
  assert.equal(rows[1].id, '8');
  assert.ok(rows.every((r) => r.status === 'new' && r.score === '' && r.found === '2026-09-26'));
  const job = jobFromFields(Object.values(rows[0]).map(String));
  assert.deepEqual(Object.keys(job), JOBS_HEADER);
});
