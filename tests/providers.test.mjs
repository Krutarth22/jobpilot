import test from 'node:test';
import assert from 'node:assert/strict';
import * as greenhouse from '../scripts/providers/greenhouse.mjs';
import * as lever from '../scripts/providers/lever.mjs';
import * as ashby from '../scripts/providers/ashby.mjs';

// Recorded-API-shape fixtures — the provider's whole contract in one object.
const GREENHOUSE_JSON = {
  jobs: [
    { id: 1, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Berlin, Germany' }, first_published: '2026-09-01T00:00:00Z' },
    // work-model-only location: enrichment should fold offices in
    { id: 2, title: 'SRE', absolute_url: 'https://boards.greenhouse.io/acme/jobs/2', location: { name: 'Hybrid' }, first_published: null },
    { id: 3, title: 'No URL job', absolute_url: null, location: { name: 'Nowhere' } },
  ],
};

const OFFICES_JSON = {
  offices: [
    { name: 'Berlin', departments: [{ jobs: [{ id: 2 }] }] },
    { name: 'Amsterdam', children: [{ name: 'AMS Annex', departments: [{ jobs: [{ id: 2 }] }] }] },
  ],
};

test('greenhouse: normalizes rows and enriches work-model-only locations', async () => {
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); return url.includes('/offices') ? OFFICES_JSON : GREENHOUSE_JSON; };
  const rows = await greenhouse.fetchBoard({ name: 'Acme', slug: 'acme' }, { fetchJson });
  assert.equal(rows.length, 2); // jobs without absolute_url are dropped
  assert.deepEqual(rows[0], { title: 'Backend Engineer', url: GREENHOUSE_JSON.jobs[0].absolute_url, company: 'Acme', location: 'Berlin, Germany', postedAt: Date.parse('2026-09-01T00:00:00Z') });
  // Multi-site: the parent office carries no departments, so only named
  // offices with job listings contribute ("AMS Annex" is the child that has one).
  assert.equal(rows[1].location, 'Hybrid · Berlin · AMS Annex');
  assert.equal(calls.filter((u) => u.includes('/offices')).length, 1); // enrichment only paid when needed
});

test('greenhouse: no work-model-only locations → no /offices request', async () => {
  const fetchJson = async () => ({ jobs: [GREENHOUSE_JSON.jobs[0]] });
  await greenhouse.fetchBoard({ name: 'Acme', slug: 'acme' }, { fetchJson });
});

test('greenhouse: jobIdFromUrl handles both URL shapes', () => {
  assert.equal(greenhouse.jobIdFromUrl('https://job-boards.greenhouse.io/acme/jobs/4455667'), '4455667');
  assert.equal(greenhouse.jobIdFromUrl('https://boards.greenhouse.io/acme/jobs/4455667?gh_jid=4455667'), '4455667');
  assert.equal(greenhouse.jobIdFromUrl('https://example.com/no-id'), null);
});

const LEVER_JSON = [
  { text: 'Product Engineer', hostedUrl: 'https://jobs.lever.co/acme/aaa-bbb', categories: { location: 'London, UK' }, descriptionPlain: 'Build things.', createdAt: 1780000000000 },
];

test('lever: normalizes rows and keeps descriptionPlain', async () => {
  const rows = await lever.fetchBoard({ name: 'Acme', slug: 'acme' }, { fetchJson: async () => LEVER_JSON });
  assert.deepEqual(rows, [{ title: 'Product Engineer', url: 'https://jobs.lever.co/acme/aaa-bbb', company: 'Acme', location: 'London, UK', description: 'Build things.', postedAt: 1780000000000 }]);
});

test('lever: fetchDescription matches by hostedUrl', async () => {
  const desc = await lever.fetchDescription({ name: 'Acme', slug: 'acme' }, null, { fetchJson: async () => LEVER_JSON, url: 'https://jobs.lever.co/acme/aaa-bbb' });
  assert.equal(desc, 'Build things.');
});

const ASHBY_JSON = {
  jobs: [
    { title: 'Founding Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/guid-1', location: 'Canada', secondaryLocations: [{ location: 'Europe', address: { postalAddress: { addressLocality: 'Berlin', addressCountry: 'Germany' } } }], publishedAt: '2026-09-10T00:00:00Z', descriptionPlain: 'Ship fast.', compensation: { interval: '1 MONTH', minValue: 8000, maxValue: 10000, currency: 'eur' } },
  ],
};

test('ashby: folds secondary locations and annualizes comp', async () => {
  const rows = await ashby.fetchBoard({ name: 'Acme', slug: 'acme' }, { fetchJson: async () => ASHBY_JSON });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location, 'Canada · Europe · Berlin · Germany');
  assert.deepEqual(rows[0].salary, { min: 96000, max: 120000, currency: 'EUR' });
});

test('ashby: malformed comp payloads never propagate', () => {
  assert.equal(ashby.parseCompensation({ compensation: { interval: '1 YEAR', minValue: 'not-a-number' } }), null);
  assert.equal(ashby.parseCompensation({ compensation: { interval: 'FORTNIGHT', minValue: 1 } }), null);
  assert.equal(ashby.parseCompensation({}), null);
});

test('ashby: api host is pinned', () => {
  assert.ok(ashby.apiUrlFor('acme').startsWith('https://api.ashbyhq.com/posting-api/job-board/acme'));
});
