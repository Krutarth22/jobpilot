import test from 'node:test';
import assert from 'node:assert/strict';
import { roleTokens, titleFuzzyMatch, companyKey, findReposts } from '../scripts/lib/repost.mjs';

test('roleTokens: drops seniority + stopwords, dedupes', () => {
  assert.deepEqual(roleTokens('Senior Software Engineer'), ['software', 'engineer']);
  assert.deepEqual(roleTokens('Manager, Software Engineering - Remote'), ['manager', 'software', 'engineering']);
  assert.deepEqual(roleTokens('Member of Technical Staff, Payments'), ['payments']);
});

test('titleFuzzyMatch: seniority-only differences match (classic repost)', () => {
  assert.equal(titleFuzzyMatch('Senior Backend Engineer', 'Backend Engineer'), true);
  assert.equal(titleFuzzyMatch('Software Engineer - Payments', 'Software Engineer, Payments Platform'), true);
  assert.equal(titleFuzzyMatch('Product Manager', 'Software Engineer'), false);
  // Same altitude, different discipline: one generic shared token is NOT a match.
  assert.equal(titleFuzzyMatch('Backend Engineer', 'Frontend Engineer'), false);
});

// "Backend Engineer" vs "Frontend Engineer" share exactly one generic token.
// The 2-token rule only relaxes to 1 when BOTH titles are token-poor, which
// is the case here — document that trade-off explicitly.
test('titleFuzzyMatch: single-overlap passes only when both titles are tiny', () => {
  assert.equal(titleFuzzyMatch('SRE', 'SRE'), true);
  assert.equal(titleFuzzyMatch('Data Engineer', 'Data Scientist'), false); // 2+ tokens each, 1 overlap
});

test('companyKey: suffix/punctuation-insensitive', () => {
  assert.equal(companyKey('Acme Inc.'), companyKey('acme'));
  assert.equal(companyKey('Globex Corporation'), companyKey('Globex'));
  assert.notEqual(companyKey('Acme'), companyKey('Beta'));
});

test('findReposts: same company, fuzzy title, different URL, within 90 days', () => {
  const existing = [
    { id: '1', company: 'Acme Inc.', title: 'Senior Backend Engineer', url: 'https://a.co/1', found: '2026-08-01' },
    { id: '2', company: 'Acme', title: 'Backend Engineer', url: 'https://a.co/2', found: '2026-09-01' },
    { id: '3', company: 'Beta', title: 'Backend Engineer', url: 'https://b.co/3', found: '2026-09-01' },
    { id: '4', company: 'Acme', title: 'Product Manager', url: 'https://a.co/4', found: '2026-09-01' },
    { id: '5', company: 'Acme', title: 'Backend Engineer', url: 'https://a.co/5', found: '2025-01-01' }, // outside window
  ];
  const job = { id: null, company: 'acme', title: 'Staff Backend Engineer', url: 'https://a.co/new' };
  const { count, ids } = findReposts(job, existing);
  assert.equal(count, 2);
  assert.deepEqual(ids, ['1', '2']);
});

test('findReposts: same URL is dedup, not a repost', () => {
  const existing = [{ id: '1', company: 'Acme', title: 'Backend Engineer', url: 'https://a.co/1', found: '2026-09-01' }];
  const { count } = findReposts({ company: 'Acme', title: 'Backend Engineer', url: 'https://a.co/1' }, existing);
  assert.equal(count, 0);
});
