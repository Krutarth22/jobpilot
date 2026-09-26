import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateChecklist, evidenceBacked, computeScore, skillsScore,
  detectKnockouts, KNOCKOUT_CAP,
} from '../scripts/score.mjs';

const PROFILE_BODY = `
## Experience
Led the platform team at Acme Corp from 2019 to 2024. Cut p99 latency 40 percent by rebuilding the ingestion pipeline.
## Skills
Python, PyTorch, Kubernetes, Kafka, AWS.
`;

const PROFILE = {
  years_experience: 11,
  level: 'manager',
  skills: ['python', 'pytorch', 'kubernetes'],
  languages: ['english'],
  locations: { remote: 'preferred', cities: ['New York'] },
  comp: { currency: 'USD', min_total: 350000 },
  deal_breakers: { onsite_only: true, needs_sponsorship: false, clearance: false },
  weights: { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 },
};

const JOB = { id: 1, company: 'Acme', title: 'Senior Backend Engineer', location: 'Remote - US' };

const SIGNALS = {
  job: JOB,
  jdText: '',
  years: { years: 8, source: '8+ years' },
  level: { level: 'ic-senior', source: 'title' },
  workMode: { mode: 'remote', onsite_only: false, source: 'location' },
  salary: null,
  requiredLanguages: [],
  prescore: null,
};

test('evidenceBacked: a quoted profile span counts, invented text does not', () => {
  assert.equal(evidenceBacked("profile: 'Led the platform team at Acme Corp'", PROFILE_BODY), true);
  assert.equal(evidenceBacked('I single-handedly built their entire ML stack', PROFILE_BODY), false);
});

test('checklist: met without a profile.md quote is downgraded to partial', () => {
  const checklist = {
    requirements: [
      { text: 'Kubernetes', type: 'must', category: 'skills', verdict: 'met', evidence: 'invented claim with no source at all' },
      { text: 'Python', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch, Kubernetes"' },
      { text: 'Rust', type: 'nice', category: 'skills', verdict: 'missing' },
    ],
    domain: { verdict: 'met', evidence: 'invented' },
  };
  const { clean, downgraded } = validateChecklist(checklist, PROFILE_BODY, PROFILE.skills);
  assert.equal(downgraded.length, 2);
  assert.equal(clean.requirements[0].verdict, 'partial');
  assert.equal(clean.requirements[1].verdict, 'met'); // quoted → stays met
  assert.equal(clean.domain.verdict, 'partial');
});

test('skillsScore: must ×2, nice ×1, met=1 partial=.5 missing=0', () => {
  const reqs = [
    { category: 'skills', type: 'must', verdict: 'met' },
    { category: 'skills', type: 'must', verdict: 'partial' },
    { category: 'skills', type: 'nice', verdict: 'missing' },
  ];
  // points = 2 + 1 + 0 = 3 of max 5 → 60
  assert.equal(skillsScore(reqs).pct, 60);
  assert.equal(skillsScore([]).pct, null); // unknown
});

test('score: deterministic — same inputs, same output, 100 runs', () => {
  const checklist = {
    requirements: [
      { text: 'Python', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch, Kubernetes, Kafka"' },
      { text: 'Kubernetes', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch, Kubernetes, Kafka"' },
      { text: 'Rust', type: 'nice', category: 'skills', verdict: 'missing' },
    ],
    domain: { verdict: 'partial', evidence: 'whatever' },
  };
  const first = computeScore(checklist, { ...SIGNALS }, PROFILE);
  for (let i = 0; i < 100; i++) {
    const again = computeScore(checklist, { ...SIGNALS }, PROFILE);
    assert.equal(again.fit, first.fit);
    assert.equal(again.breakdown, first.breakdown);
  }
  // Sanity: strong checklist + good signals should land high.
  assert.ok(first.fit >= 60, `fit=${first.fit}`);
});

test('score: unknown signals score neutral (50), never zero', () => {
  const result = computeScore(
    { requirements: [], domain: null },
    { ...SIGNALS, years: null, level: null, workMode: { mode: null, onsite_only: false, source: 'none' }, salary: null, prescore: null },
    { ...PROFILE, years_experience: undefined, level: undefined, locations: {}, comp: {} },
  );
  assert.ok(result.fit > 30 && result.fit < 70, `all-neutral fit=${result.fit}`);
});

test('knockouts: cap at 40 and flag', () => {
  const strong = computeScore(
    {
      requirements: [{ text: 'x', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch, Kubernetes, Kafka"' }],
      domain: { verdict: 'met', evidence: 'profile: "platform team at Acme Corp"' },
    },
    { ...SIGNALS, workMode: { mode: 'onsite', onsite_only: true, source: 'jd' } },
    PROFILE,
  );
  assert.ok(strong.knockouts.includes('on-site only'));
  assert.equal(strong.fit, KNOCKOUT_CAP);
  assert.equal(strong.capped, true);
  assert.match(strong.breakdown, /KO/);
});

test('knockouts: clearance, language, and level distance', () => {
  const signals = {
    ...SIGNALS,
    jdText: 'Active TS/SCI clearance required. Fluent in German required.',
    requiredLanguages: ['german'],
    level: { level: 'director', source: 'title' },
  };
  const kos = detectKnockouts(signals, JOB, PROFILE);
  assert.ok(kos.some((k) => k.includes('clearance')));
  assert.ok(kos.some((k) => k.includes('german')));
  // manager → director is 2 steps on the dual-track scale: flagged, not a knockout
  const kos2 = detectKnockouts(signals, JOB, { ...PROFILE, level: 'ic-mid' }); // 4 steps
  assert.ok(kos2.some((k) => k.includes('2 steps away')));
});

test('knockouts: sponsorship needed but not offered', () => {
  const kos = detectKnockouts(
    { ...SIGNALS, jdText: 'We cannot sponsor work visas at this time.' },
    JOB,
    { ...PROFILE, deal_breakers: { ...PROFILE.deal_breakers, needs_sponsorship: true } },
  );
  assert.ok(kos.some((k) => k.includes('sponsorship')));
});

test('comp: salary below the floor scores low but not zero; est. flag from multiplier', () => {
  const low = computeScore(
    { requirements: [{ text: 'x', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch"' }] },
    { ...SIGNALS, salary: { min: 150000, max: 170000, currency: 'USD' } },
    PROFILE,
  );
  // mid 160k vs min 350k → ratio ~0.46 → very low comp score
  assert.ok(low.components.comp.pct < 20);

  const withMultiplier = computeScore(
    { requirements: [{ text: 'x', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch"' }] },
    { ...SIGNALS, salary: { min: 220000, max: 240000, currency: 'USD' }, level: { level: 'manager', source: 'title' }, stage: 'public' },
    { ...PROFILE, comp: { ...PROFILE.comp, multipliers: { 'manager@public': 1.6 } } },
  );
  // mid 230k × 1.6 = 368k ≥ 350k → 100, est. flagged
  assert.equal(withMultiplier.components.comp.pct, 100);
  assert.ok(withMultiplier.breakdown.includes('est.'));
});

test('recheck: keyword pre-score far from checklist skills flags recheck', () => {
  const result = computeScore(
    {
      requirements: [{ text: 'Python', type: 'must', category: 'skills', verdict: 'met', evidence: 'profile: "Python, PyTorch, Kubernetes, Kafka"' }],
      domain: { verdict: 'met', evidence: 'profile: "platform team at Acme Corp"' },
    },
    { ...SIGNALS, prescore: 20 }, // checklist skills ≈ 100 — gap > 25
    PROFILE,
  );
  assert.equal(result.recheck, true);
});
