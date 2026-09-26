import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atsScore, titleWords } from '../scripts/lib/ats.mjs';
import { originalResumePath } from '../scripts/review.mjs';

const JD = `Lead and grow a team of engineers building our observability platform:
metrics, logs and distributed tracing on Datadog and Prometheus. Set the technical
strategy. Ship anomaly detection. Strong distributed systems foundation. Kubernetes a plus.`;
const CHECKLIST = { requirements: [
  { text: 'Hands-on observability with Datadog', type: 'must' },
  { text: 'Distributed systems foundation', type: 'must' },
  { text: 'Kubernetes', type: 'nice' },
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
• Set the technical strategy for tracing; shipped anomaly detection
Senior Software Engineer — Contoso    Jun 2016 – Feb 2021
• Built distributed systems on Kubernetes
${filler}
Skills
Python, Go, Kubernetes, Datadog, Prometheus
Education
B.S. Computer Science, State University, 2016`;

const ctx = { jdText: JD, checklist: CHECKLIST, jobTitle: TITLE, profile: { skills: ['datadog', 'kubernetes'] }, profileBody: GOOD };

test('ats: a clean, relevant resume scores high with nothing to fix', () => {
  const r = atsScore({ ...ctx, text: GOOD, pages: 1, fileName: 'alex.pdf' });
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.deepEqual(r.fixes, []);
  assert.equal(r.parts.keywords.of + r.parts.readable.of + r.parts.format.of, 100);
});

test('ats: non-standard headings and missing dates cost points and say how to fix', () => {
  const weak = GOOD.replace('Experience\n', 'Where I have worked\n').replace(/Mar 2021 – Present|Jun 2016 – Feb 2021/g, '');
  const r = atsScore({ ...ctx, text: weak, pages: 1, fileName: 'alex.pdf' });
  assert.ok(r.score < atsScore({ ...ctx, text: GOOD, pages: 1, fileName: 'alex.pdf' }).score);
  assert.ok(r.fixes.some((f) => /headings: Experience/.test(f)));
  assert.ok(r.fixes.some((f) => /date range/.test(f)));
});

test('ats: a file with no readable text (scanned image) is capped at 10', () => {
  const r = atsScore({ ...ctx, text: 'Alex Morgan', pages: 1, fileName: 'scan.pdf' });
  assert.ok(r.score <= 10);
  assert.match(r.fixes[0], /scanned image/);
});

test('ats: repeating a keyword never raises the score', () => {
  const base = atsScore({ ...ctx, text: GOOD, pages: 1, fileName: 'a.pdf' }).score;
  const stuffed = atsScore({ ...ctx, text: `${GOOD}\n${'Datadog Prometheus Kubernetes '.repeat(40)}`, pages: 1, fileName: 'a.pdf' }).score;
  assert.ok(stuffed <= base);
});

test('ats: missing keywords split into ones your profile backs and real gaps, with display names', () => {
  const thin = GOOD.replace(/Datadog and Prometheus /, '').replace('Python, Go, Kubernetes, Datadog, Prometheus', 'Python, Go');
  const r = atsScore({ ...ctx, text: thin, pages: 1, fileName: 'a.pdf', profileBody: 'Ran Datadog for 3 years.' });
  assert.ok(r.keywordsYouCanAdd.includes('Datadog'));
  assert.ok(r.keywordGaps.includes('Prometheus'));
  assert.ok(r.fixes.some((f) => /Add keywords your experience backs: .*Datadog/.test(f)));
});

test('ats: without a job description or checklist the keyword part is skipped, not zeroed', () => {
  const r = atsScore({ text: GOOD, pages: 1, fileName: 'a.pdf', jobTitle: '' });
  assert.equal(r.parts.keywords, null);
  assert.ok(r.score >= 90);
});

test('ats: length and file type', () => {
  assert.equal(atsScore({ ...ctx, text: GOOD, pages: 3, fileName: 'a.pdf' }).parts.format.checks.length, 5);
  assert.equal(atsScore({ ...ctx, text: GOOD, pages: 4, fileName: 'a.pdf' }).parts.format.checks.length, 0);
  assert.equal(atsScore({ ...ctx, text: GOOD, pages: null, fileName: 'a.docx' }).parts.format.pagesEstimated, true);
  assert.equal(atsScore({ ...ctx, text: GOOD, pages: 1, fileName: 'a.md' }).parts.format.checks.fileType, 0);
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
