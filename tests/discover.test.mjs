import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseBoardUrl, boardsFromText, nameFromSlug, buildQueries, discover } from '../scripts/discover.mjs';

test('parseBoardUrl: posting and board URLs on every supported host', () => {
  assert.deepEqual(parseBoardUrl('https://job-boards.greenhouse.io/figma/jobs/5551234'), { provider: 'greenhouse', slug: 'figma' });
  assert.deepEqual(parseBoardUrl('https://boards.greenhouse.io/stripe/jobs/1?gh_src=x'), { provider: 'greenhouse', slug: 'stripe' });
  assert.deepEqual(parseBoardUrl('https://job-boards.eu.greenhouse.io/n26/jobs/9'), { provider: 'greenhouse', slug: 'n26' });
  assert.deepEqual(parseBoardUrl('https://boards.greenhouse.io/embed/job_app?for=gusto&token=42'), { provider: 'greenhouse', slug: 'gusto' });
  assert.deepEqual(parseBoardUrl('https://jobs.lever.co/palantir/abc-123/apply'), { provider: 'lever', slug: 'palantir' });
  assert.deepEqual(parseBoardUrl('https://jobs.ashbyhq.com/linear/uuid-here'), { provider: 'ashby', slug: 'linear' });
  assert.deepEqual(parseBoardUrl('https://jobs.ashbyhq.com/Ramp'), { provider: 'ashby', slug: 'Ramp' });
});

test('parseBoardUrl: rejects other hosts, ATS pages and garbage', () => {
  assert.equal(parseBoardUrl('https://www.linkedin.com/jobs/view/1'), null);
  assert.equal(parseBoardUrl('https://jobs.eu.lever.co/acme/1'), null); // api.eu.lever.co isn't fetched
  assert.equal(parseBoardUrl('https://boards.greenhouse.io/embed/job_board'), null);
  assert.equal(parseBoardUrl('https://jobs.ashbyhq.com/'), null);
  assert.equal(parseBoardUrl('https://jobs.lever.co.evil.com/acme'), null);
  assert.equal(parseBoardUrl('not a url'), null);
});

test('boardsFromText: pulls URLs out of search output, dedups case-insensitively', () => {
  const text = `
    1. Engineering Manager - Acme (https://jobs.lever.co/acme/1).
    2. https://jobs.lever.co/ACME/2, and https://jobs.ashbyhq.com/globex/x
    3. https://example.com/careers
  `;
  assert.deepEqual(boardsFromText(text), [
    { provider: 'lever', slug: 'acme' },
    { provider: 'ashby', slug: 'globex' },
  ]);
});

test('boardsFromText: "url | Name" names the board; junk names are dropped', () => {
  const text = [
    'https://jobs.ashbyhq.com/permitflow/1 | PermitFlow',
    'https://jobs.ashbyhq.com/permitflow/2 | Something Else', // first name wins
    'https://jobs.lever.co/acme/1',
    'https://jobs.lever.co/acme/2 | Acme Corp', // later name fills a gap
    `https://jobs.ashbyhq.com/n8n/1 | ${'x'.repeat(80)}`, // too long → no name
    'https://jobs.ashbyhq.com/rula/1 | Rula https://jobs.ashbyhq.com/other/2', // two URLs on a line
  ].join('\n');
  assert.deepEqual(boardsFromText(text), [
    { provider: 'ashby', slug: 'permitflow', name: 'PermitFlow' },
    { provider: 'lever', slug: 'acme', name: 'Acme Corp' },
    { provider: 'ashby', slug: 'n8n' },
    { provider: 'ashby', slug: 'rula', name: 'Rula' },
    { provider: 'ashby', slug: 'other' },
  ]);
});

test('nameFromSlug: readable fallback name', () => {
  assert.equal(nameFromSlug('shield-ai'), 'Shield Ai');
  assert.equal(nameFromSlug('linear'), 'Linear');
});

test('buildQueries: titles × hosts, narrowed by remote or first city; none without titles', () => {
  const q = buildQueries({ target_titles: ['Engineering Manager'], locations: { remote: 'preferred' } });
  assert.deepEqual(q, [
    'site:job-boards.greenhouse.io "Engineering Manager" remote',
    'site:jobs.lever.co "Engineering Manager" remote',
    'site:jobs.ashbyhq.com "Engineering Manager" remote',
  ]);
  assert.match(buildQueries({ target_titles: ['SRE'], locations: { cities: ['Berlin'] } })[0], /"SRE" Berlin$/);
  assert.equal(buildQueries({ target_titles: ['A', 'B', 'C', 'D', 'E'] }).length, 12); // capped at 4 titles
  assert.deepEqual(buildQueries({ target_titles: [] }), []);
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-discover-'));
  writeFileSync(join(root, 'companies.yml'), [
    '# my boards',
    'title_filter:',
    '  positive: [engineer]',
    '  negative: [sales]',
    'location_filter: {}',
    '',
    'companies:',
    '  - { name: Acme, provider: lever, slug: acme }',
    '',
  ].join('\n'));
  return root;
}

const BOARDS = {
  'ashby:globex': { live: true, count: 3, rows: [{ title: 'Backend Engineer' }, { title: 'Staff Engineer' }, { title: 'Sales Lead' }] },
  'greenhouse:initech': { live: true, count: 1, rows: [{ title: 'Platform Engineer' }] },
  'lever:hooli': { live: true, count: 2, rows: [{ title: 'Account Executive' }, { title: 'Sales Engineer' }] },
  'lever:gone': { live: false, reason: '404' },
  'ashby:flaky': { unknown: true, reason: 'timeout' },
};
const probe = async (provider, slug) => BOARDS[`${provider}:${slug}`];
const fetchBoardName = async () => 'Initech';

const URLS = [
  'https://jobs.lever.co/acme/1', // already known
  'https://jobs.ashbyhq.com/globex/1 | Globex Corporation',
  'https://job-boards.greenhouse.io/initech/jobs/2 | Not Initech', // Greenhouse's own board name wins
  'https://jobs.lever.co/hooli/3', // live, nothing passes the filters
  'https://jobs.lever.co/gone/4',
  'https://jobs.ashbyhq.com/flaky/5',
].join('\n');

test('discover: appends only fresh live boards with a matching role, keeps comments', async () => {
  const root = workspace();
  const summary = await discover(root, URLS, { probe, fetchBoardName });

  assert.equal(summary.alreadyKnown, 1);
  assert.deepEqual(summary.added.map((a) => [a.name, a.slug, a.matching]), [['Globex Corporation', 'globex', 2], ['Initech', 'initech', 1]]);
  assert.deepEqual(summary.noMatch, [{ provider: 'lever', slug: 'hooli', open: 2 }]);
  assert.deepEqual(summary.dead, [{ provider: 'lever', slug: 'gone' }]);
  assert.equal(summary.unknown[0].slug, 'flaky');

  const text = readFileSync(join(root, 'companies.yml'), 'utf8');
  assert.match(text, /^# my boards/);
  assert.deepEqual(yaml.load(text).companies.map((c) => c.slug), ['acme', 'globex', 'initech']);

  // Re-running is a no-op: everything is now known.
  const again = await discover(root, URLS, { probe, fetchBoardName });
  assert.equal(again.added.length, 0);
});

test('discover: --max caps additions (most matching first), --dry-run writes nothing', async () => {
  const root = workspace();
  const before = readFileSync(join(root, 'companies.yml'), 'utf8');
  const capped = await discover(root, URLS, { probe, fetchBoardName, max: 1, dryRun: true });
  assert.deepEqual(capped.added.map((a) => a.slug), ['globex']);
  assert.deepEqual(capped.overCap.map((a) => a.slug), ['initech']);
  assert.equal(readFileSync(join(root, 'companies.yml'), 'utf8'), before);
});
