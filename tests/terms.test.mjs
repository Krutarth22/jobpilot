import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSkills, extractTerms, PRACTICE_TERMS } from '../scripts/lib/skills.mjs';
import { keywordPreScore, jdTerms, MIN_PRESCORE_TERMS } from '../scripts/lib/signals.mjs';
import { computeScore, untracedRequirements, scoreNotes } from '../scripts/score.mjs';

// Paraphrased engineering-manager JD in the style of a real Figma posting
// that the tools-only vocabulary matched just 3 terms in.
const EM_JD = `
As the Engineering Manager for Observability, you'll lead the team building the
systems that show how the platform and its AI products behave in production:
metrics, logs and distributed tracing, plus an AI observability pipeline that
turns traces and model outputs into evals. Lead and grow a 6 engineer team
responsible for reliability and scalability. Own the observability stack,
including Datadog. Set the technical strategy for instrumentation standards.
Ship AI-driven anomaly detection. Partner across infrastructure, product
engineering, finance and security. Coach and develop engineers through career
growth and feedback. 4+ years leading engineering teams; a strong foundation in
distributed systems; hands-on depth in observability and machine learning.
We believe in hiring smart, curious people who are excited to learn.`;

const PROFILE = { skills: ['python', 'datadog', 'distributed systems', 'machine learning'] };

test('practice terms: a manager JD now yields enough terms to cross-check', () => {
  assert.ok(extractSkills(EM_JD).size < MIN_PRESCORE_TERMS); // tools alone: too few
  const terms = jdTerms(EM_JD, PROFILE);
  assert.ok(terms.length >= 10, `got ${terms.join(', ')}`);
  for (const t of ['Hiring', 'Mentoring', 'Technical strategy', 'Cross-functional', 'Observability', 'Anomaly detection']) {
    assert.ok(terms.includes(t), `missing ${t}`);
  }
  assert.notEqual(keywordPreScore(EM_JD, PROFILE, ''), null);
});

test('practice terms: careers-page boilerplate is not a hiring duty', () => {
  const hiring = PRACTICE_TERMS.find(([n]) => n === 'Hiring')[1];
  assert.equal(hiring.test('We believe in hiring smart, curious people'), false);
  assert.equal(hiring.test('Figma is growing our team of passionate creatives'), false);
  assert.equal(hiring.test('Our hiring manager will reach out'), false);
  assert.equal(hiring.test('Lead and grow a 6 engineer team'), true);
  assert.equal(hiring.test('Grew the team from 4 to 20 engineers'), true);
  assert.equal(hiring.test('Hired 12 engineers'), true);
});

test('practice terms never reach the fact gate vocabulary', () => {
  // A tailored "mentoring" vs a profile's "mentored" must not block a PDF.
  assert.equal(extractSkills('Mentoring, hiring, roadmap, stakeholders, cross-functional').size, 0);
});

test('extractTerms: the user\'s own listed skills are found even outside the vocabulary', () => {
  const terms = extractTerms('Deep experience with ClickHouse and vector search', ['ClickHouse', 'go', 'data']);
  assert.ok([...terms].includes('ClickHouse'));
  assert.ok(![...terms].some((t) => t.toLowerCase() === 'go' || t.toLowerCase() === 'data')); // too short / generic
});

test('keywordPreScore: fewer than MIN_PRESCORE_TERMS recognizable terms → null (skipped, not guessed)', () => {
  assert.equal(keywordPreScore('Join us! Great benefits and a friendly office.', PROFILE, ''), null);
});

test('untracedRequirements: paraphrases trace; invented requirements do not', () => {
  const reqs = [
    { text: '4+ years leading and growing engineering teams' },
    { text: 'Strong foundation in distributed systems' },
    { text: 'Hands-on depth in observability (metrics, logs, tracing)' },
    { text: 'Experience running Datadog' },
    { text: 'Coach engineers through career growth and feedback' },
    { text: 'Experience with Kubernetes operators' }, // tool the JD never names
    { text: 'Background in consumer payments and fraud prevention' }, // not in the JD
  ];
  assert.deepEqual(untracedRequirements(reqs, EM_JD), [
    'Experience with Kubernetes operators',
    'Background in consumer payments and fraud prevention',
  ]);
  assert.deepEqual(untracedRequirements(reqs, ''), []); // no JD cached → nothing to check
});

test('computeScore: an untraced requirement flags a recheck even without a pre-score', () => {
  const profile = { weights: { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 }, skills: [], locations: {}, comp: {}, deal_breakers: {} };
  const signals = { jdText: EM_JD, years: null, level: null, workMode: { mode: null, onsite_only: false, source: 'none' }, salary: null, requiredLanguages: [], prescore: null, job: {} };
  const checklist = { requirements: [{ text: 'Experience with Kubernetes operators', type: 'must', verdict: 'met' }] };
  const score = computeScore(checklist, signals, profile);
  assert.equal(score.recheck, true);
  assert.deepEqual(score.untraced, ['Experience with Kubernetes operators']);
  assert.equal(score.prescoreMismatch, false);
});

test('scoreNotes: a stale "cross-check skipped" note is replaced on re-score', () => {
  const notes = scoreNotes('applied via referral | cross-check skipped: only 2 recognizable term(s)', []);
  assert.equal(notes, 'applied via referral');
});
