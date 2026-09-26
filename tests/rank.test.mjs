import test from 'node:test';
import assert from 'node:assert/strict';
import * as rank from '../scripts/lib/rank.mjs';

const { freshness, rankOf, rankAll, HALF_LIFE_DAYS } = rank;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-26T00:00:00Z');

test('freshness: 14-day half-life decay', () => {
  assert.equal(freshness('2026-09-26', NOW), 1.0); // today
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

test('rankOf: fit × freshness', () => {
  assert.equal(rankOf(80, 1.0), 80);
  assert.equal(rankOf(80, 0.5), 40);
  assert.equal(rankOf('', 1.0), 0);
});

test('pay is not a second rank factor (fit already carries comp)', () => {
  assert.equal(rank.compFactor, undefined);
  const jobs = [
    { id: '1', fit: '70', posted: '2026-09-26', salary: 'USD 60k-70k' },
    { id: '2', fit: '70', posted: '2026-09-26', salary: 'USD 300k-320k' },
  ];
  const [a, b] = rankAll(jobs, NOW);
  assert.equal(a.rank, b.rank);
});

test('rankAll: sorts best-first by fit × freshness', () => {
  const jobs = [
    { id: '1', fit: '85', posted: '2026-09-20' },
    { id: '2', fit: '85', posted: '2026-09-26' },
    { id: '3', fit: '90', posted: '2026-01-01' },
    { id: '4', fit: '70', posted: '2026-09-26' },
  ];
  const order = rankAll(jobs, NOW).map(({ job }) => job.id);
  // #2 (same fit, fresher) beats #1; six days of decay drops #1 (85 → ~63)
  // below #4 posted today (70); #3's high fit has decayed to almost nothing.
  assert.deepEqual(order, ['2', '4', '1', '3']);
});

test('rankAll: unscored jobs come out freshest-first', () => {
  const jobs = [
    { id: '1', fit: '', posted: '2026-08-01' },
    { id: '2', fit: '', posted: '2026-09-25' },
    { id: '3', fit: '', found: '2026-09-10' },
  ];
  assert.deepEqual(rankAll(jobs, NOW).map(({ job }) => job.id), ['2', '3', '1']);
});
