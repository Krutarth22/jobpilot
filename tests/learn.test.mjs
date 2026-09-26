import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackRows, fitWeights, suggestPreferences, statsByBucket } from '../scripts/lib/learn.mjs';

function synthRow(i, weights, noise = 0) {
  // components chosen so a known-weight linear model produced the user score
  // (weights are already on the 0–100 scale, same as score.mjs's fit)
  const components = {
    skills: ((i % 5) + 5) / 10,
    seniority: ((i % 3) + 6) / 10,
    domain: ((i % 4) + 4) / 10,
    location: ((i % 2) + 7) / 10,
    comp: ((i % 6) + 2) / 10,
  };
  const user = Math.round(weights.skills * components.skills + weights.seniority * components.seniority
    + weights.domain * components.domain + weights.location * components.location + weights.comp * components.comp + noise);
  return { id: i, userScore: Math.min(100, Math.max(0, user)), why: `row ${i}`, components, outcome: '' };
}

test('fitWeights: recovers known weights from clean synthetic data', () => {
  const truth = { skills: 40, seniority: 20, domain: 10, location: 15, comp: 15 };
  const rows = Array.from({ length: 60 }, (_, i) => synthRow(i, truth));
  const fit = fitWeights(rows, { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 });
  assert.equal(fit.trivial, false);
  const sum = Object.values(fit.weights).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100); // constraint holds exactly
  for (const k of Object.keys(truth)) {
    assert.ok(Math.abs(fit.weights[k] - truth[k]) <= 6, `${k}: ${fit.weights[k]} vs ${truth[k]}`);
  }
  assert.ok(fit.maeAfter <= fit.maeBefore + 0.5);
  assert.ok(fit.maeAfter < 5, `recovered model should fit cleanly, mae=${fit.maeAfter}`);
});

test('fitWeights: weights stay non-negative and sum exactly 100', () => {
  const rows = Array.from({ length: 12 }, (_, i) => synthRow(i, { skills: 50, seniority: 10, domain: 10, location: 20, comp: 10 }, (i % 3) - 1));
  const fit = fitWeights(rows, {});
  const values = Object.values(fit.weights);
  assert.ok(values.every((v) => v >= 0));
  assert.equal(values.reduce((a, b) => a + b, 0), 100);
});

test('fitWeights: too few rows → no-op with current weights', () => {
  const fit = fitWeights([{ userScore: 50, components: { skills: 0.5, seniority: 0.5, domain: 0.5, location: 0.5, comp: 0.5 } }], { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 });
  assert.equal(fit.trivial, true);
  assert.deepEqual(fit.weights, { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 });
});

test('feedbackRows: null component pcts score neutral (0.5)', () => {
  const rows = feedbackRows([
    { id: 1, feedback: { user_score: 70, why: 'solid' }, score: { components: { skills: { pct: 80 }, seniority: { pct: null } } }, outcome: 'interview' },
    { id: 2, feedback: { user_score: 40, why: 'meh' }, score: { components: {} } }, // no components → skipped
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].components.skills, 0.8);
  assert.equal(rows[0].components.seniority, 0.5);
  assert.equal(rows[0].outcome, 'interview');
});

test('suggestPreferences: recurring themes surface, one-offs do not', () => {
  const rows = [
    { userScore: 30, why: 'on-site only, would not take it', components: {} },
    { userScore: 35, why: 'on-site requirement kills it', components: {} },
    { userScore: 40, why: 'on-site, too far', components: {} },
    { userScore: 60, why: 'salary a bit low', components: {} },
  ];
  const suggestions = suggestPreferences(rows, { minCount: 3 });
  assert.equal(suggestions.length, 1, JSON.stringify(suggestions));
  assert.match(suggestions[0].suggestion, /remote/i);
});

test('statsByBucket: health verdict only at 15+ outcomes, monotonic rates = healthy', () => {
  const jobs = [];
  for (let i = 0; i < 10; i++) jobs.push({ fit: '85', outcome: i < 5 ? 'interview' : 'rejected' }); // 80+: 50%
  for (let i = 0; i < 10; i++) jobs.push({ fit: '70', outcome: i < 2 ? 'interview' : 'rejected' }); // 60-79: 20%
  for (let i = 0; i < 10; i++) jobs.push({ fit: '45', outcome: i < 1 ? 'interview' : 'ghosted' });  // <60: 10%
  const health = statsByBucket(jobs);
  assert.equal(health.totalOutcomes, 30);
  assert.equal(health.healthy, true);

  // Inverted: low-fit converts better → miscalibrated.
  const inverted = [];
  for (let i = 0; i < 10; i++) inverted.push({ fit: '85', outcome: 'rejected' });
  for (let i = 0; i < 10; i++) inverted.push({ fit: '45', outcome: 'interview' });
  for (let i = 0; i < 5; i++) inverted.push({ fit: '70', outcome: 'ghosted' });
  assert.equal(statsByBucket(inverted).healthy, false);

  assert.equal(statsByBucket([{ fit: '85', outcome: 'interview' }]).healthy, null); // under 15
  assert.equal(statsByBucket([{ fit: '', outcome: 'interview' }]).totalOutcomes, 0); // unscored rows excluded
});
