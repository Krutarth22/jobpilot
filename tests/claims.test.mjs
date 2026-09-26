import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateClaims, ClaimValidationError, hashProfile, claimsPath, claimsForJob, PLAIN_LABELS,
} from '../scripts/claims.mjs';
import { claimWarnings } from '../scripts/check-resume.mjs';
import { writeJobs, writeEval, profilePath } from '../scripts/lib/workspace.mjs';

const FIXTURES = new URL('./fixtures/claims/', import.meta.url);

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`${name}.json`, FIXTURES), 'utf8'));
}

// ── All 5 fixtures validate (ported from test_report.py) ────────────────

test('claims: all 5 fixtures validate, each with claims + counts + percentages summing to 100', async () => {
  const names = ['confidential-work', 'consistent', 'harmless-date-rounding', 'mixed-evidence', 'no-online-profile'];
  for (const name of names) {
    const report = validateClaims(await loadFixture(name));
    assert.ok(report.claims.length > 0, name);
    assert.ok(report.counts, name);
    assert.equal(Object.values(report.percentages).reduce((a, b) => a + b, 0), 100, name);
  }
});

test('claims: standard limitations are always appended', async () => {
  const report = validateClaims(await loadFixture('consistent'));
  const joined = report.limitations.join(' ');
  assert.match(joined, /Finding nothing online does not mean the claim is false\./);
  assert.match(joined, /does not prove that anyone lied or committed fraud/);
});

test('claims: standard limitations are appended once, even if the input already lists one', async () => {
  const raw = await loadFixture('consistent');
  raw.limitations = ['Finding nothing online does not mean the claim is false.'];
  const report = validateClaims(raw);
  const occurrences = report.limitations.filter((l) => l === 'Finding nothing online does not mean the claim is false.').length;
  assert.equal(occurrences, 1);
});

test('claims: candidate_label is always forced to "You"', async () => {
  const raw = await loadFixture('consistent');
  raw.candidate_label = 'Someone Else';
  const report = validateClaims(raw);
  assert.equal(report.candidate_label, 'You');
});

test('claims: prohibited decision field is rejected (candidate_score)', async () => {
  const raw = await loadFixture('consistent');
  raw.candidate_score = 82;
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: prohibited field is rejected anywhere in the tree (fake_probability on a claim)', async () => {
  const raw = await loadFixture('consistent');
  raw.claims[0].fake_probability = 10;
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: unknown top-level field is rejected', async () => {
  const raw = await loadFixture('consistent');
  raw.extra_notes = 'not allowed';
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: unknown claim field is rejected', async () => {
  const raw = await loadFixture('consistent');
  raw.claims[0].internal_note = 'nope';
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: banned hiring conclusion phrase is rejected', async () => {
  const raw = await loadFixture('consistent');
  raw.summary = 'Do not hire the candidate.';
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: banned fraud phrase in a claim inference is rejected', async () => {
  const raw = await loadFixture('mixed-evidence');
  raw.claims[2].inference = 'The candidate committed fraud on this project.';
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: Supported claim requires evidence', async () => {
  const raw = await loadFixture('consistent');
  raw.claims[0].evidence = [];
  assert.throws(() => validateClaims(raw), ClaimValidationError);
});

test('claims: flagged claim requires alternative explanations and a follow-up question', async () => {
  const raw = await loadFixture('mixed-evidence');
  raw.claims[1].alternative_explanations = [];
  assert.throws(() => validateClaims(raw), ClaimValidationError);
  const raw2 = await loadFixture('mixed-evidence');
  raw2.claims[1].follow_up_questions = [];
  assert.throws(() => validateClaims(raw2), ClaimValidationError);
});

test('claims: counts/percentages as input are rejected (derived only, never accepted)', async () => {
  const raw = await loadFixture('consistent');
  raw.counts = { Supported: 1 };
  assert.throws(() => validateClaims(raw), ClaimValidationError);
  const raw2 = await loadFixture('consistent');
  raw2.percentages = { Supported: 100 };
  assert.throws(() => validateClaims(raw2), ClaimValidationError);
});

test('claims: percentages sum to 100 via largest-remainder on a 1/1/1 split', () => {
  const base = {
    report_version: '1.0', candidate_label: 'x', review_date: '2026-09-02',
    reviewed_inputs: ['Resume'], overall_conclusion: 'Clarification recommended',
    summary: 'Three claims, evenly split.', sources: [], limitations: [],
    claims: [
      { id: 'C1', category: 'A', claim: 'one', assessment: 'Supported', confidence: 'High', observations: ['x'], inference: 'x', evidence: [{ source: 's', finding: 'f' }], alternative_explanations: [], follow_up_questions: [], next_step: 'none' },
      { id: 'C2', category: 'A', claim: 'two', assessment: 'Plausible but unverified', confidence: 'Low', observations: ['x'], inference: 'x', evidence: [], alternative_explanations: [], follow_up_questions: [], next_step: 'none' },
      { id: 'C3', category: 'A', claim: 'three', assessment: 'Not assessable', confidence: 'Low', observations: ['x'], inference: 'x', evidence: [], alternative_explanations: [], follow_up_questions: [], next_step: 'none' },
    ],
  };
  const report = validateClaims(base);
  assert.equal(Object.values(report.percentages).reduce((a, b) => a + b, 0), 100);
  // Each of the three categories got exactly one claim (33.3...%): the
  // largest-remainder method must bump exactly one of them to 34%.
  const values = Object.values(report.percentages).filter((v) => v > 0).sort();
  assert.deepEqual(values, [33, 33, 34]);
});

// ── Self-check twist: profile_sha256 + claimsForJob ──────────────────────

test('claims: profile_sha256 is an allowed optional top-level field', async () => {
  const raw = await loadFixture('consistent');
  raw.profile_sha256 = 'a'.repeat(64);
  const report = validateClaims(raw);
  assert.equal(report.profile_sha256, 'a'.repeat(64));
});

test('hashProfile: sha256 of profile.md, changes when the file changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobpilot-claims-hash-'));
  try {
    await writeFile(profilePath(dir), '## Experience\nLed the team.');
    const h1 = hashProfile(dir);
    assert.match(h1, /^[0-9a-f]{64}$/);
    await writeFile(profilePath(dir), '## Experience\nLed a different team.');
    const h2 = hashProfile(dir);
    assert.notEqual(h1, h2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claimsForJob: keeps only claims that touch the job\'s must-haves', async () => {
  const report = validateClaims(await loadFixture('mixed-evidence'));
  const checklist = { requirements: [
    { text: 'Strong React and Node.js experience', type: 'must', category: 'skills', verdict: 'met' },
  ] };
  const relevant = claimsForJob(report.claims, checklist);
  assert.ok(relevant.some((c) => c.id === 'C1')); // React/Node.js claim
  assert.ok(!relevant.some((c) => c.id === 'C2')); // unrelated metric claim, no overlap
});

test('claimsForJob: flagged claims (Needs clarification / Material inconsistency) use a lower match bar', async () => {
  const report = validateClaims(await loadFixture('mixed-evidence'));
  // "inventory application" only lightly overlaps this checklist wording,
  // but C3 is flagged Material inconsistency so it should still surface.
  const checklist = { requirements: [
    { text: 'Experience owning an inventory system end to end', type: 'must', category: 'skills', verdict: 'met' },
  ] };
  const relevant = claimsForJob(report.claims, checklist);
  assert.ok(relevant.some((c) => c.id === 'C3'));
});

test('PLAIN_LABELS: covers all five internal assessment values with no technical leakage', () => {
  for (const key of ['Supported', 'Plausible but unverified', 'Needs clarification', 'Material inconsistency', 'Not assessable']) {
    assert.ok(PLAIN_LABELS[key]);
    assert.notEqual(PLAIN_LABELS[key], key);
  }
});

// ── for-job CLI: stale detection + selection, via a real temp workspace ──

function runClaims(root, ...args) {
  return execFileSync('node', ['scripts/claims.mjs', ...args], {
    env: { ...process.env, JOBPILOT_HOME: root }, encoding: 'utf8', stdio: 'pipe',
  });
}

test('for-job: missing claims.json fails clearly', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-claims-cli-'));
  writeJobs(root, [{ id: '1', company: 'Acme', title: 'Engineer', url: 'https://a/1', status: 'new' }]);
  assert.throws(() => runClaims(root, 'for-job', '1'), /claims\.json not found/);
});

test('for-job: stale claims.json (profile.md changed since build) is detected with a distinct exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-claims-cli-'));
  writeJobs(root, [{ id: '1', company: 'Acme', title: 'Engineer', url: 'https://a/1', status: 'new' }]);
  writeFileSync(profilePath(root), '## Experience\nLed the platform team.');
  // claims.json holds the RAW (pre-normalization) report shape — counts and
  // percentages are derived on load, never stored — so write that shape here.
  const staleReport = {
    report_version: '1.0', candidate_label: 'x', review_date: '2026-09-02',
    reviewed_inputs: ['Resume'], overall_conclusion: 'No material issues found',
    summary: 'ok', sources: [], limitations: [],
    profile_sha256: 'stale'.padEnd(64, '0'),
    claims: [{ id: 'C1', category: 'Employment', claim: 'Led the platform team', assessment: 'Supported', confidence: 'High', observations: ['x'], inference: 'x', evidence: [{ source: 's', finding: 'f' }], alternative_explanations: [], follow_up_questions: [], next_step: 'none' }],
  };
  writeFileSync(claimsPath(root), JSON.stringify(staleReport, null, 2));
  try {
    runClaims(root, 'for-job', '1');
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /stale/i);
  }
});

test('for-job: fresh claims.json (matching profile_sha256) selects claims touching the job', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-claims-cli-'));
  writeJobs(root, [{ id: '1', company: 'Acme', title: 'Backend Engineer', url: 'https://a/1', status: 'new' }]);
  writeFileSync(profilePath(root), '## Experience\nLed the Kubernetes migration at Acme.');
  writeEval(root, '1', { checklist: { requirements: [
    { text: 'Kubernetes experience', type: 'must', category: 'skills', verdict: 'met' },
  ] } });
  const fresh = {
    report_version: '1.0', candidate_label: 'x', review_date: '2026-09-02',
    reviewed_inputs: ['Resume'], overall_conclusion: 'No material issues found',
    summary: 'ok', sources: [], limitations: [],
    profile_sha256: hashProfile(root),
    claims: [
      { id: 'C1', category: 'Skills', claim: 'Owned the Kubernetes migration', assessment: 'Supported', confidence: 'High', observations: ['x'], inference: 'x', evidence: [{ source: 's', finding: 'f' }], alternative_explanations: [], follow_up_questions: [], next_step: 'none' },
      { id: 'C2', category: 'Skills', claim: 'Fluent in French cooking', assessment: 'Supported', confidence: 'High', observations: ['x'], inference: 'x', evidence: [{ source: 's', finding: 'f' }], alternative_explanations: [], follow_up_questions: [], next_step: 'none' },
    ],
  };
  writeFileSync(claimsPath(root), JSON.stringify(fresh, null, 2));
  const out = JSON.parse(runClaims(root, 'for-job', '1'));
  assert.ok(out.claims.some((c) => c.id === 'C1'));
  assert.ok(!out.claims.some((c) => c.id === 'C2'));
  assert.equal(out.claims[0].plainLabel, 'Matches the evidence');
});

// ── check-resume.mjs advisory hook ───────────────────────────────────────

test('claimWarnings: a bullet overlapping a Material inconsistency claim is flagged, advisory only', async () => {
  const report = validateClaims(await loadFixture('mixed-evidence'));
  const warnings = claimWarnings(['Created the linked inventory application single-handedly'], report);
  assert.ok(warnings.length > 0);
  assert.equal(warnings[0].claimId, 'C3');
});

test('claimWarnings: no claims.json (null report) never warns', () => {
  assert.deepEqual(claimWarnings(['Created the inventory application'], null), []);
});

test('check-resume CLI: claimWarnings never flips ok, and is reported as advisory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-claims-check-'));
  const profileText = `
## Experience
Contributed to the linked inventory application at Acme Corp from 2019 to 2024.
- Cut p99 latency 40 percent
## Skills
Python, React.
`;
  writeFileSync(profilePath(root), profileText);
  const mixed = await loadFixture('mixed-evidence');
  writeFileSync(claimsPath(root), JSON.stringify({ ...mixed, profile_sha256: hashProfile(root) }, null, 2));
  const tailoredHtml = `<p>Acme Corp · 2019-2024</p><ul><li>Created the linked inventory application</li><li>Cut p99 latency 40 percent</li></ul>`;
  const htmlPath = join(root, 'tailored.html');
  writeFileSync(htmlPath, tailoredHtml);
  const out = execFileSync('node', ['scripts/check-resume.mjs', htmlPath], {
    env: { ...process.env, JOBPILOT_HOME: root }, encoding: 'utf8', stdio: 'pipe',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true); // fact gate unaffected by the advisory warning
  assert.ok(parsed.claimWarnings.length > 0);
});
