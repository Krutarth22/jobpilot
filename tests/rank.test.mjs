import test from 'node:test';
import assert from 'node:assert/strict';
import * as rank from '../scripts/lib/rank.mjs';

const { agePenalty, rankOf, rankAll, DAYS_PER_POINT, MAX_AGE_PENALTY } = rank;
const NOW = Date.parse('2026-09-26T00:00:00Z');

test('agePenalty: 1 point per 5 days, capped at 10', () => {
  assert.equal(DAYS_PER_POINT, 5);
  assert.equal(MAX_AGE_PENALTY, 10);
  assert.equal(agePenalty('2026-09-26', NOW), 0); // today
  assert.equal(agePenalty('2026-09-16', NOW), 2); // 10 days
  assert.equal(agePenalty('2026-08-11', NOW), 9.2); // 46 days
  assert.equal(agePenalty('2026-01-01', NOW), 10); // capped
});

test('agePenalty: missing or malformed date costs nothing, never guessed', () => {
  assert.equal(agePenalty('', NOW), 0);
  assert.equal(agePenalty('not-a-date', NOW), 0);
  assert.equal(agePenalty(undefined, NOW), 0);
});

test('agePenalty: profile ranking options override the defaults; 0 turns it off', () => {
  assert.equal(agePenalty('2026-09-16', NOW, { days_per_point: 10 }), 1);
  assert.equal(agePenalty('2026-01-01', NOW, { max_age_penalty: 20 }), 20);
  assert.equal(agePenalty('2026-01-01', NOW, { max_age_penalty: 0 }), 0);
  assert.equal(agePenalty('2026-09-16', NOW, { days_per_point: 'junk' }), 2); // bad value → default
});

test('rankOf: fit minus penalty, never below 0; unscored is 0', () => {
  assert.equal(rankOf(80, 0), 80);
  assert.equal(rankOf('84', 9.2), 75);
  assert.equal(rankOf(5, 10), 0);
  assert.equal(rankOf('', 0), 0);
  assert.equal(rankOf(undefined, 0), 0);
});

test('an old strong match that is still open is not sunk by age (46-day fit 84 regression)', () => {
  const jobs = [
    { id: '1', fit: '84', posted: '2026-08-11' }, // 46 days old
    { id: '2', fit: '70', posted: '2026-09-26' }, // today
  ];
  const [first] = rankAll(jobs, NOW);
  assert.equal(first.job.id, '1');
  assert.equal(first.rank, 75);
});

test('pay is not a second rank factor (fit already carries comp)', () => {
  const jobs = [
    { id: '1', fit: '70', posted: '2026-09-26', salary: 'USD 60k-70k' },
    { id: '2', fit: '70', posted: '2026-09-26', salary: 'USD 300k-320k' },
  ];
  const [a, b] = rankAll(jobs, NOW);
  assert.equal(a.rank, b.rank);
});

test('rankAll: best matches first; among similar matches, newest first', () => {
  const jobs = [
    { id: '1', fit: '85', posted: '2026-09-20' }, // 6 days → 84
    { id: '2', fit: '85', posted: '2026-09-26' }, // 85
    { id: '3', fit: '90', posted: '2026-01-01' }, // capped → 80
    { id: '4', fit: '70', posted: '2026-09-26' }, // 70
    { id: '5', fit: '81', posted: '2026-09-26' }, // 81 — beats #3 on rank
  ];
  assert.deepEqual(rankAll(jobs, NOW).map(({ job }) => job.id), ['2', '1', '5', '3', '4']);
});

test('rankAll: equal rank breaks ties newest-first', () => {
  const jobs = [
    { id: '1', fit: '82', posted: '2026-09-16' }, // 82 − 2 = 80
    { id: '2', fit: '80', posted: '2026-09-26' }, // 80
  ];
  assert.deepEqual(rankAll(jobs, NOW).map(({ job }) => job.id), ['2', '1']);
});

test('rankAll: unscored jobs come out newest-first', () => {
  const jobs = [
    { id: '1', fit: '', posted: '2026-08-01' },
    { id: '2', fit: '', posted: '2026-09-25' },
    { id: '3', fit: '', found: '2026-09-10' },
  ];
  assert.deepEqual(rankAll(jobs, NOW).map(({ job }) => job.id), ['2', '3', '1']);
});
