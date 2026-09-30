import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atsScore, titleWords } from '../scripts/lib/ats.mjs';
import { originalResumePath, checklistOf } from '../scripts/review.mjs';
import { validateChecklist } from '../scripts/score.mjs';

const NOW = new Date(2026, 8, 29);
const JD = `Lead and grow a team of engineers building our observability platform:
metrics, logs and distributed tracing on Datadog and Prometheus. Set the technical
strategy. Ship anomaly detection. Strong distributed systems foundation. Kubernetes a plus.
5+ years of experience.`;
const met = (text, type = 'must', evidence = 'x') => ({ text, type, verdict: 'met', evidence });
const CHECKLIST = { requirements: [
  met('Hands-on observability with Datadog'),
  met('Distributed systems foundation'),
  met('Kubernetes', 'nice'),
] };
const TITLE = 'Senior Manager, Software Engineering – Observability';

const filler = 'Delivered reliable systems and clear documentation for many internal customers every quarter. '.repeat(6);
const GOOD = `Alex Morgan
alex.morgan@example.com · +1 (555) 010-2233
Summary
Software engineering manager focused on observability and distributed systems.
Experience
Engineering Manager, Platform — Northwind Labs    Mar 2021 – Present
• Lead and grow a team of 8 engineers owning Datadog and Prometheus observability
• Set the technical strategy for tracing; shipped anomaly detection, cutting alert noise 40%
Senior Software Engineer — Contoso    Jun 2016 – Feb 2021
• Built distributed systems on Kubernetes
${filler}
Skills
Python, Go, Kubernetes, Datadog, Prometheus
Education
B.S. Computer Science, State University, 2016`;

const profile = { skills: ['datadog', 'kubernetes', 'prometheus'], level: 'manager', experience: [{ company: 'Northwind Labs' }, { company: 'Contoso' }] };
const ctx = { jdText: JD, checklist: CHECKLIST, jobTitle: TITLE, profile, profileBody: GOOD, now: NOW };
const run = (text, extra = {}) => atsScore({ ...ctx, text, pages: 1, fileName: 'alex.pdf', ...extra });

test('ats: a clean resume that shows what the job asks scores high, with nothing critical', () => {
  const r = run(GOOD);
  assert.ok(r.score >= 80, `score ${r.score}: ${JSON.stringify(r.findings)}`);
  assert.equal(r.cap, null);
  assert.equal(r.limited, false);
  assert.deepEqual(Object.values(r.parts).map((p) => p.of), [40, 25, 15, 15, 5]);
  assert.ok(!r.findings.some((f) => f.impact === 'critical'));
});

test('ats: proof in a role beats a skills-list mention of the same term', () => {
  const listed = GOOD.replace(/Datadog and Prometheus observability/, 'observability').replace('Set the technical', 'Set the technical');
  const shown = run(GOOD).parts.skills.points;
  const onlyListed = run(listed).parts.skills.points;
  assert.ok(onlyListed < shown, `${onlyListed} < ${shown}`);
  assert.ok(run(listed).findings.some((f) => /Only listed, never shown in a role: .*Datadog/.test(f.message)));
});

test('ats: repeating a keyword never raises the score', () => {
  const base = run(GOOD).score;
  const stuffed = run(`${GOOD}\n${'Datadog Prometheus Kubernetes '.repeat(40)}`).score;
  assert.ok(stuffed <= base);
});

test('ats: a tool used long ago is worth less than one used in the current role', () => {
  const recent = run(GOOD).parts.skills.points;
  const old = run(GOOD.replace(/Mar 2021 – Present/, 'Mar 2011 – Mar 2013').replace(/Jun 2016 – Feb 2021/, 'Jun 2009 – Feb 2011')).parts.skills.points;
  assert.ok(old < recent, `${old} < ${recent}`);
});

test('ats: each must-have the profile cannot back caps the score (79 / 69 / 59), and says so', () => {
  const miss = (t) => ({ text: t, type: 'must', verdict: 'missing' });
  const one = run(GOOD, { checklist: { requirements: [...CHECKLIST.requirements, miss('Manage 20 engineers')] } });
  assert.ok(one.score <= 79);
  assert.deepEqual(one.cap.because, ['Manage 20 engineers']);
  assert.equal(one.findings[0].impact, 'critical');
  const three = run(GOOD, { checklist: { requirements: [...CHECKLIST.requirements, miss('Manage 20 engineers'), miss('Run a hiring loop'), miss('Own a P&L')] } });
  assert.ok(three.score <= 59);
  const custom = run(GOOD, { checklist: { requirements: [...CHECKLIST.requirements, miss('Manage 20 engineers')] }, profile: { ...profile, ats: { caps: [50, 40, 30] } } });
  assert.ok(custom.score <= 50);
  // a missing nice-to-have never caps
  assert.equal(run(GOOD, { checklist: { requirements: [...CHECKLIST.requirements, { text: 'Rust', type: 'nice', verdict: 'missing' }] } }).cap, null);
});

test('ats: without a checklist the requirements part is left out, not zeroed, and the score says to run match', () => {
  const r = run(GOOD, { checklist: null });
  assert.equal(r.limited, true);
  assert.equal(r.parts.requirements, null);
  assert.ok(r.score >= 75, `score ${r.score}`);
  assert.ok(r.findings.some((f) => /Run match/.test(f.message)));
});

test('ats: the job\'s own asks (years, degree) count even when the checklist has no row for them', () => {
  const r = run(GOOD, { checklist: { ...CHECKLIST, education: 'master' } });
  const derived = r.parts.requirements.items.filter((i) => i.derived).map((i) => i.text);
  assert.ok(derived.includes('5+ years of relevant experience'));
  assert.ok(derived.includes("master's-level degree"));
  const master = r.parts.requirements.items.find((i) => /master/.test(i.text));
  assert.equal(master.credit, 0.5); // has a bachelor's, wants a master's
});

test('ats: a file with no readable text (scanned image) is capped at 10', () => {
  const r = run('Alex Morgan');
  assert.ok(r.score <= 10);
  assert.ok(r.findings.some((f) => /scanned image/.test(f.message)));
});

test('ats: missing keywords split into ones your profile backs and real gaps, with display names', () => {
  const thin = GOOD.replace(/Datadog and Prometheus /, '').replace('Python, Go, Kubernetes, Datadog, Prometheus', 'Python, Go');
  const r = run(thin, { profileBody: 'Ran Datadog for 3 years.', profile: { ...profile, skills: ['kubernetes'] }, jdText: `${JD} Prometheus` });
  assert.ok(r.keywordsYouCanAdd.includes('Datadog'), JSON.stringify(r.keywordsYouCanAdd));
  assert.ok(r.findings.some((f) => /Add keywords your experience backs: .*Datadog/.test(f.message)));
});

test('ats: parse problems are found and explained (headings, dates, contact)', () => {
  const weak = GOOD.replace('Experience\n', 'Where I have worked\n').replace(/Mar 2021 – Present|Jun 2016 – Feb 2021/g, '');
  const r = run(weak);
  assert.ok(r.score < run(GOOD).score);
  assert.ok(r.findings.some((f) => f.impact === 'format' && /headings: experience/.test(f.message)));
  assert.ok(r.findings.some((f) => /date range/.test(f.message)));
});

test('ats: length is a light hygiene point, not a big penalty; file type matters', () => {
  const sub = (r) => Object.fromEntries(r.parts.hygiene.subs.map((s) => [s.name, s.got]));
  assert.equal(sub(run(GOOD, { pages: 3 })).length, 0.7);
  assert.equal(sub(run(GOOD, { pages: 4 })).length, 0.3);
  assert.equal(run(GOOD, { pages: null, fileName: 'a.docx' }).parts.hygiene.subs.find((s) => s.name === 'fileType').got, 1);
  assert.equal(sub(run(GOOD, { fileName: 'a.md' })).fileType, 0);
  assert.ok(run(GOOD).score - run(GOOD, { pages: 3 }).score <= 1);
});

test('ats: the score is deterministic', () => {
  assert.deepEqual(run(GOOD), run(GOOD));
});

test('checklistOf and validateChecklist: bare or nested checklists, job facts kept and cleaned', () => {
  assert.equal(checklistOf(null), null);
  assert.deepEqual(checklistOf({ checklist: { requirements: [] } }), { requirements: [] });
  assert.deepEqual(checklistOf({ requirements: [{ text: 'x' }] }), { requirements: [{ text: 'x' }] });
  const { clean } = validateChecklist({ requirements: [], min_years: 8, education: 'master', certifications: ['PMP', 3] }, '', []);
  assert.equal(clean.min_years, 8);
  assert.equal(clean.education, 'master');
  assert.deepEqual(clean.certifications, ['PMP', '3']);
  const bad = validateChecklist({ requirements: [], min_years: 99, education: 'wizard' }, '', []).clean;
  assert.equal(bad.min_years, undefined);
  assert.equal(bad.education, undefined);
});

test('titleWords: drops the team suffix and seniority words', () => {
  assert.deepEqual(titleWords('Senior Manager, Software Engineering – Data Platform'), ['manager', 'software', 'engineering']);
  assert.deepEqual(titleWords('Staff Machine Learning Engineer (Ads)'), ['machine', 'learning', 'engineer']);
});

test('originalResumePath: finds the resume setup saved in the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-ats-'));
  assert.equal(originalResumePath(root), null);
  writeFileSync(join(root, 'resume.docx'), '');
  assert.equal(originalResumePath(root), join(root, 'resume.docx'));
});
