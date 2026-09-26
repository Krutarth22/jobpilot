import test from 'node:test';
import assert from 'node:assert/strict';
import { freshness, compFactor, rankOf, rankAll, HALF_LIFE_DAYS } from '../scripts/lib/rank.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T00:00:00Z');

test('freshness: 14-day half-life decay', () => {
  assert.equal(freshness('2026-09-26', NOW), 1.0); // today
  assert.abs = assert;
  const half = freshness(new Date(NOW - HALF_LIFE_DAYS * DAY).toISOString().slice(0, 10), NOW);
  assert.ok(Math.abs(half - 0.5) < 0.01, `half-life should be ~0.5, got ${half}`);
  const quarter = freshness(new Date(NOW - 2 * HALF_LIFE_DAYS * DAY).toISOString().slice(0, 10), NOW);
  assert.ok(Math.abs(quarter - 0.25) < 0.01);
  assert.ok(freshness('2026-01-01', NOW) < 0.001); // old postings sink
});

test('freshness: missing or malformed date is neutral (1.0), never guessed', () => {
  assert.equal(freshness('', NOW), 1.0);
  assert.equal(freshness('not-a-date', NOW), 1.0);
  assert.equal(freshness(undefined, NOW), 1.0);
});

test('compFactor: at/above floor 1.0, 70–100% taper, below scales to 0', () => {
  const comp = { currency: 'USD', min_total: 200000 };
  assert.equal(compFactor({ min: 220000, max: 260000, currency: 'USD' }, comp), 1.0);
  const at70 = compFactor({ min: 130000, max: 150000, currency: 'USD' }, comp); // mid 140k = 70%
  assert.ok(Math.abs(at70 - 0.8) < 0.01);
  assert.ok(compFactor({ min: 70000, max: 90000, currency: 'USD' }, comp) < 0.5);
  assert.equal(compFactor(null, comp), 1.0); // unknown salary → neutral
  // Never compare across currencies.
  assert.equal(compFactor({ min: 10000, max: 11000, currency: 'GBP' }, comp), 1.0);
});

test('rankOf: multiplicative', () => {
  assert.equal(rankOf(80, 1.0, 1.0), 80);
  assert.equal(rankOf(80, 0.5, 1.0), 40);
  assert.equal(rankOf(80, 0.5, 0.5), 20);
});

test('rankAll: sorts best-first and respects freshness + comp', () => {
  const jobs = [
    { id: '1', fit: '85', posted: '2026-09-20', salary: '' },
    { id: '2', fit: '85', posted: '2026-09-26', salary: '' },
    { id: '3', fit: '90', posted: '2026-01-01', salary: 'USD 60k-70k' },
    { id: '4', fit: '70', posted: '2026-09-26', salary: 'USD 300k-320k' },
  ];
  const profile = { comp: { currency: 'USD', min_total: 200000 } };
  const ranked = rankAll(jobs, profile, NOW);
  const order = ranked.map(({ job }) => job.id);
  // #2 (same fit, fresh) beats #1; #3's high fit is decayed AND comp-tapered;
  // #4 fresh + well-paid despite lower fit.
  assert.equal(order[0], '2');
  assert.ok(order.indexOf('4') < order.indexOf('3'));
  const byId = Object.fromEntries(ranked.map((r) => [r.job.id, r]));
  assert.ok(byId['2'].rank > byId['1'].rank);
  assert.ok(byId['4'].rank > byId['3'].rank);
});
