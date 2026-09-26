import test from 'node:test';
import assert from 'node:assert/strict';
import { auditResume, lintBullets, htmlToLines } from '../scripts/check-resume.mjs';
import { mustHaveCoverage, keywordCoverage, thirtySecondScreen, atsRoundTrip, mustHaveKeywords } from '../scripts/review.mjs';

const PROFILE = `
## Experience
Led the platform team at Acme Corp (Berlin) from 2019 to 2024. Cut p99 latency 40 percent by rebuilding the ingestion pipeline serving 2 million users.
- Grew the team from 4 to 11 engineers
- Owned the Kubernetes migration, 30 services
## Skills
Python, PyTorch, Kubernetes, Kafka, AWS, React.
`;

test('fact guard: clean resume passes', () => {
  const tailored = `
Acme Corp · 2019-2024 · Berlin
• Cut p99 latency 40 percent, serving 2 million users
• Owned the Kubernetes migration across 30 services
Skills: Python, Kubernetes, Kafka`;
  const audit = auditResume({ tailoredText: tailored, roleLines: ['Acme Corp · 2019-2024 · Berlin'], bullets: [], profileText: PROFILE });
  assert.equal(audit.ok, true, JSON.stringify(audit.violations));
});

test('fact guard: an injected fake metric is caught', () => {
  const tailored = `
Acme Corp · 2019-2024 · Berlin
• Cut p99 latency 40 percent, serving 2 million users
• Reduced cloud spend by 63 percent
Skills: Python`;
  const audit = auditResume({ tailoredText: tailored, roleLines: [], bullets: [], profileText: PROFILE });
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some((v) => v.includes('63 percent') || v.includes('63')));
});

test('fact guard: invented skill and invented year are caught', () => {
  const tailored = 'Skills: Python, Rust, LangChain\nLed teams since 2015 at Acme Corp';
  const audit = auditResume({ tailoredText: tailored, roleLines: [], bullets: [], profileText: PROFILE });
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some((v) => v.includes('LangChain')));
  assert.ok(audit.violations.some((v) => v.includes('2015')));
});

test('fact guard: skill alias counts as known (k8s ≡ Kubernetes)', () => {
  const tailored = 'Skills: k8s, Python';
  const audit = auditResume({ tailoredText: tailored, roleLines: [], bullets: [], profileText: PROFILE });
  assert.equal(audit.ok, true, JSON.stringify(audit.violations));
});

test('bullet lint: weak openings, length, repeated verbs, lost metrics', () => {
  const findings = lintBullets([
    'Responsible for the ingestion pipeline',
    'Worked on latency improvements and then also worked on caching and then also on the queue system and the deployment tooling and then also on the on-call rotation and lots of other things that made this bullet run way past two lines in the final resume layout',
    'Led the migration',
    'Led the rewrite',
  ], ['- Cut latency 40% serving 2 million users', '- Grew team from 4 to 11']);
  assert.ok(findings.some((f) => f.issue.includes('weak opening')));
  assert.ok(findings.some((f) => f.issue.includes('too long')));
  assert.ok(findings.some((f) => f.issue.includes('repeated opening "led"')));
  assert.ok(findings.some((f) => f.issue.includes('metrics lost')));
});

test('bullet lint: strong, varied, metric-bearing bullets pass clean', () => {
  const findings = lintBullets([
    'Cut p99 latency 40% by rebuilding ingestion',
    'Grew the team from 4 to 11 engineers',
  ], ['- Cut p99 latency 40% by rebuilding ingestion', '- Grew the team from 4 to 11 engineers']);
  assert.deepEqual(findings, []);
});

// ── Scorecard ───────────────────────────────────────────────────────────

test('must-have coverage: met=1, partial=0.5, from the checklist', () => {
  const checklist = { requirements: [
    { type: 'must', category: 'skills', verdict: 'met' },
    { type: 'must', category: 'skills', verdict: 'partial' },
    { type: 'must', category: 'skills', verdict: 'missing' },
    { type: 'nice', category: 'skills', verdict: 'met' }, // excluded
  ] };
  assert.deepEqual(mustHaveCoverage(checklist), { met: 1, of: 3, pct: 50 });
  assert.deepEqual(mustHaveCoverage({ requirements: [] }), { met: 0, of: 0, pct: null });
});

test('keyword coverage: missing skills listed, null with no JD', () => {
  const profile = { skills: ['python'] };
  const kc = keywordCoverage('Need Python and Kafka and Airflow', profile, 'also knows Docker');
  assert.equal(kc.pct, 33);
  assert.deepEqual(kc.missing, ['Kafka', 'Airflow']);
  assert.deepEqual(keywordCoverage('', profile, ''), { pct: null, missing: [] });
});

// ── 30-second screen ────────────────────────────────────────────────────

const SCREEN_PROFILE = {
  level: 'ic-senior',
  experience: [
    { title: 'Senior Backend Engineer', company: 'Acme', start: '2022-01', end: 'present' },
    { title: 'Backend Engineer', company: 'Beta', start: '2019-06', end: '2021-12' },
  ],
};

test('30-second screen: strong profile + numbered bullets = pass', () => {
  // A realistic 1-page resume length (~300 words) so the length check passes.
  const filler = Array.from({ length: 16 }, (_, i) =>
    `• Shipped service number ${i + 12} with 40 percent better p99 latency and 2 million users on the platform for the team`).join('\n');
  const s = thirtySecondScreen({
    profile: SCREEN_PROFILE,
    profileBody: '',
    tailoredText: `<h2>Experience</h2><ul><li>Cut latency 40%</li><li>Grew team 4 to 11</li><li>Shipped 12 services</li>${filler}</ul>`,
  });
  assert.equal(s.verdict, 'pass');
  const recognizable = s.checks.find((c) => c.check.includes('recognizable'));
  assert.equal(recognizable.verdict, 'ai'); // left to the review skill's AI
});

test('30-second screen: unnumbered bullets + old role + gap = fail with reasons', () => {
  const s = thirtySecondScreen({
    profile: { ...SCREEN_PROFILE, experience: [
      { title: 'Junior Engineer', company: 'Acme', start: '2015-01', end: '2017-12' },
      { title: 'Backend Engineer', company: 'Beta', start: '2020-06', end: '2021-12' }, // 2.5y gap
    ] },
    profileBody: '',
    tailoredText: '<ul><li>Did engineering things</li><li>More things</li><li>Other things</li></ul>',
  });
  assert.equal(s.verdict, 'fail');
  assert.ok(s.checks.some((c) => c.check.includes('gaps') && c.verdict === 'fail'));
  assert.ok(s.checks.some((c) => c.check.includes('top 3 bullets') && c.verdict === 'fail'));
  assert.ok(s.reasons.length >= 1 && s.reasons.length <= 3);
});

test('30-second screen: unknowns never fabricate verdicts', () => {
  const s = thirtySecondScreen({ profile: {}, profileBody: '- one bullet' });
  assert.ok(s.checks.filter((c) => c.verdict === 'unknown').length >= 3);
});

// ── ATS round-trip ──────────────────────────────────────────────────────

test('mustHaveKeywords: skills from non-missing checklist rows', () => {
  const kws = mustHaveKeywords({ requirements: [
    { text: '5 years of Kubernetes and Kafka', verdict: 'met' },
    { text: 'Rust', verdict: 'missing' },
  ] });
  assert.ok(kws.includes('Kubernetes'));
  assert.ok(kws.includes('Kafka'));
  assert.ok(!kws.includes('Rust'));
});

test('atsRoundTrip: headings + skills survive a rendered PDF', async () => {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/jp-ats-'));
  const htmlPath = `${dir}/resume.html`;
  const pdfPath = `${dir}/resume.pdf`;
  const html = `<html><head><style>@page{size:A4;margin:0.6in}</style></head><body>
    <h1>Jordan Rivera</h1><h2>Experience</h2><p>Built Python and Kubernetes platforms</p>
    <h2>Skills</h2><p>Python, Kubernetes, Kafka, React, TypeScript</p></body></html>`;
  await (await import('node:fs/promises')).writeFile(htmlPath, html);
  const { renderHtmlToPdf } = await import('../scripts/render-resume.mjs');
  await renderHtmlToPdf(html, pdfPath);
  const result = await atsRoundTrip(pdfPath, htmlPath);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.headingsChecked, 3); // h1 name + 2 h2 sections
});
