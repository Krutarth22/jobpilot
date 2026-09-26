import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYears, extractLevel, extractWorkMode, extractSalary, parseSalaryColumn,
  formatSalary, extractRequiredLanguages, keywordPreScore, levelDistance,
} from '../scripts/lib/signals.mjs';
import { extractSkills } from '../scripts/lib/skills.mjs';

test('skills: canonicalization collapses spellings', () => {
  assert.equal(extractSkills('k8s and golang').has('Kubernetes') && extractSkills('k8s and golang').has('Go'), true);
  const s = extractSkills('Kubernetes, GO, postgres, Graphql');
  assert.ok(s.has('PostgreSQL'));
  assert.ok(s.has('GraphQL'));
  // 'Go' only in the case-sensitive pass: prose "go" must not register.
  assert.ok(!extractSkills('go the extra mile').has('Go'));
});

test('years: extracts the LOWER bound of ranges', () => {
  assert.equal(extractYears('5+ years of experience in ML').years, 5);
  assert.equal(extractYears('at least 8 years of professional experience').years, 8);
  assert.equal(extractYears('8-12 years of experience').years, 8);
  assert.equal(extractYears('minimum 3 years with distributed systems').years, 3);
  assert.equal(extractYears('we value curiosity'), null);
  assert.equal(extractYears('20+ years (garbage bound)').years, 20); // within sanity cap
});

test('level: title wins over JD prose', () => {
  assert.equal(extractLevel('Director of Engineering', 'senior role').level, 'director');
  assert.equal(extractLevel('Software Engineer', 'You will be managing a team of 8').level, 'manager');
  assert.equal(extractLevel('Senior Backend Engineer', '').level, 'ic-senior');
  assert.equal(extractLevel('Staff Engineer, Payments', '').level, 'staff');
  assert.equal(extractLevel('Cook', ''), null);
});

test('level distance (dual-track scale; switching IC ↔ management costs one extra step)', () => {
  assert.equal(levelDistance('ic-senior', 'ic-senior'), 0);
  assert.equal(levelDistance('ic-senior', 'manager'), 2);
  assert.equal(levelDistance('staff', 'manager'), 1); // same rung, different track
  assert.equal(levelDistance('ic-mid', 'principal'), 3);
  assert.equal(levelDistance('ic-mid', 'director'), 5);
  assert.equal(levelDistance('manager', 'director'), 2);
  assert.equal(levelDistance('unknown', 'director'), null);
});

test('work mode: explicit on-site only is the only onsite_only signal', () => {
  assert.equal(extractWorkMode('Hybrid - London', '').mode, 'hybrid');
  assert.equal(extractWorkMode('Remote (EU)', '').mode, 'remote');
  assert.equal(extractWorkMode('Berlin', 'This role must be on-site 5 days a week in the office.').onsite_only, true);
  // Absence of remote language is NOT evidence of on-site.
  assert.deepEqual(extractWorkMode('New York, NY', 'Great team, great office.'), { mode: null, onsite_only: false, source: 'none' });
});

// ── Salary regex over real JD snippet shapes ─────────────────────────────
const SALARY_SNIPPETS = [
  ['$180,000 – $220,000 per year', 180000, 220000],
  ['Salary range: $180,000 - $220,000', 180000, 220000],
  ['USD 180k-220k base', 180000, 220000],
  ['The compensation band is $150K to $190K', 150000, 190000],
  ['$120,000–$160,000 annually, plus equity', 120000, 160000],
  ['€90.000 - €120.000 per annum', 90000, 120000],
  ['base salary: $200,000', 200000, 200000],
  ['$75 - $90 per hour', 75 * 2080, 90 * 2080],
];

for (const [snippet, min, max] of SALARY_SNIPPETS) {
  test(`salary: "${snippet}"`, () => {
    const s = extractSalary(snippet);
    assert.ok(s, 'should parse');
    assert.equal(s.min, min);
    assert.equal(s.max, max);
  });
}

test('salary: ignores noise', () => {
  assert.equal(extractSalary('a team of 20-30 people'), null);
  assert.equal(extractSalary('founded 2015 - 2020'), null);
  assert.equal(extractSalary('10-15% travel'), null);
});

test('salary column round-trips through formatSalary', () => {
  const original = { min: 120000, max: 150000, currency: 'USD' };
  const formatted = formatSalary(original);
  assert.equal(formatted, 'USD 120k-150k');
  const parsed = parseSalaryColumn(formatted);
  assert.equal(parsed.min, 120000);
  assert.equal(parsed.max, 150000);
  assert.equal(parsed.currency, 'USD');
});

test('required languages', () => {
  assert.deepEqual(extractRequiredLanguages('Fluent in German required; English nice'), ['german']);
  assert.deepEqual(extractRequiredLanguages('french fluency is required'), ['french']);
  assert.deepEqual(extractRequiredLanguages('no language requirements'), []);
});

test('keyword pre-score: JD coverage by profile skills', () => {
  const profile = { skills: ['python', 'pytorch'] };
  const jd = 'Requirements: Python, PyTorch, Kubernetes, Kafka, Airflow, SQL, Spark, AWS, Docker, Terraform'; // 10 skills, 2 known
  assert.equal(keywordPreScore(jd, profile, ''), 20);
  assert.equal(keywordPreScore('no skill tokens here at all', profile, ''), null);
});
