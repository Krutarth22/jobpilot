import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paperFor, maxPagesFor, resumeFileName, tailoredPaths } from '../scripts/lib/resume-output.mjs';
import { buildTailored } from '../scripts/review.mjs';
import { profilePath } from '../scripts/lib/workspace.mjs';

test('paperFor: explicit setting wins; otherwise Letter for US/Canada, A4 elsewhere', () => {
  assert.equal(paperFor({ paper: 'a4', locations: { cities: ['New York'] } }), 'a4');
  assert.equal(paperFor({ locations: { cities: ['New York'] } }), 'letter');
  assert.equal(paperFor({ locations: { cities: ['Austin, TX'] } }), 'letter');
  assert.equal(paperFor({ locations: { cities: ['Toronto'] } }), 'letter');
  assert.equal(paperFor({ locations: { cities: ['Berlin'] }, comp: { currency: 'EUR' } }), 'a4');
  assert.equal(paperFor({ locations: { cities: ['Berlin, DE'] }, comp: { currency: 'EUR' } }), 'a4'); // not Delaware
  assert.equal(paperFor({ locations: { cities: ['Bengaluru, IN'] }, comp: { currency: 'INR' } }), 'a4'); // not Indiana
  assert.equal(paperFor({ comp: { currency: 'USD' } }), 'letter');
});

test('maxPagesFor: 1 page under 10 years, 2 from 10 or when unknown; explicit wins', () => {
  assert.equal(maxPagesFor({ years_experience: 6 }), 1);
  assert.equal(maxPagesFor({ years_experience: 11 }), 2);
  assert.equal(maxPagesFor({}), 2);
  assert.equal(maxPagesFor({ years_experience: 6, max_pages: 2 }), 2);
});

test('resumeFileName: named after the person, never the company', () => {
  assert.equal(resumeFileName({ name: 'Jordan Rivera' }), 'Jordan-Rivera-Resume.pdf');
  assert.equal(resumeFileName({ name: 'José  María O\'Neil' }), 'Jose-Maria-O-Neil-Resume.pdf');
  assert.equal(resumeFileName({}), 'Resume.pdf');
});

test('tailoredPaths: one folder per job', () => {
  const p = tailoredPaths('/w', { id: '12', company: 'Figma, Inc.' }, { name: 'Jordan Rivera', years_experience: 4 });
  assert.equal(p.dir, join('/w', 'out', '12-figma-inc'));
  assert.equal(p.pdf, join('/w', 'out', '12-figma-inc', 'Jordan-Rivera-Resume.pdf'));
  assert.equal(p.maxPages, 1);
});

function workspace(html) {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-build-'));
  writeFileSync(profilePath(root), '---\nname: Jordan Rivera\n---\n## Experience\nEngineer at Acme Corp, 2019-2024. Python.\n');
  const job = { id: '1', company: 'Acme', title: 'Engineer' };
  const paths = tailoredPaths(root, job, { name: 'Jordan Rivera' });
  if (html !== null) {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.html, html);
  }
  return { root, job, paths, profile: { name: 'Jordan Rivera' } };
}

test('build: no HTML yet → blocked, says where to write it', async () => {
  const { root, job, profile } = workspace(null);
  const r = await buildTailored(root, job, { profile, profileBody: '' });
  assert.equal(r.status, 1);
  assert.match(r.error, /write the tailored HTML/);
});

test('build: an unfilled placeholder blocks the PDF', async () => {
  const { root, job, paths, profile } = workspace('<h1>Jordan Rivera</h1><span>{{GITHUB}}</span>');
  const r = await buildTailored(root, job, { profile, profileBody: '' });
  assert.equal(r.status, 1);
  assert.match(r.error, /\{\{GITHUB\}\}/);
  assert.equal(existsSync(paths.pdf), false);
});

test('build: a fact-gate failure blocks the PDF', async () => {
  const { root, job, paths, profile } = workspace('<h1>Jordan Rivera</h1><ul><li>Cut costs 90% with Kubernetes</li></ul>');
  const r = await buildTailored(root, job, { profile, profileBody: readFileSync(profilePath(root), 'utf8') });
  assert.equal(r.status, 1);
  assert.match(r.error, /fact gate/);
  assert.ok(r.factGate.violations.length > 0);
  assert.equal(existsSync(paths.pdf), false);
});

// ── Real renders (Playwright chromium, as tests/review.test.mjs already uses) ──

import { renderHtmlToPdf } from '../scripts/render-resume.mjs';

const page = (body) => `<html><head><style>body{font-family:Helvetica;font-size:10.5pt}</style></head><body>${body}</body></html>`;

test('render: counts pages and flags text running past the page edge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobpilot-render-'));
  const long = await renderHtmlToPdf(page('<ul>' + '<li>A reasonably long bullet about shipping reliable systems.</li>'.repeat(120) + '</ul>'), join(dir, 'long.pdf'), { format: 'letter' });
  assert.ok(long.pages >= 2);
  assert.deepEqual(long.overflow, []);
  const wide = await renderHtmlToPdf(page('<p style="white-space:nowrap">https://example.com/an-extremely-long-link-that-cannot-wrap-anywhere-on-this-line-at-all-ever/and-keeps-going-well-past-the-right-margin-of-a-letter-page</p>'), join(dir, 'wide.pdf'), { format: 'letter' });
  assert.equal(wide.pages, 1);
  assert.equal(wide.overflow.length, 1);
});

test('build: a clean resume renders on Letter, named after the person, with previews', async () => {
  const html = readFileSync(new URL('../templates/resume.html', import.meta.url), 'utf8')
    .replace(/\{\{NAME\}\}/g, 'Jordan Rivera').replace('{{EMAIL}}', 'jordan@example.com').replace('{{PHONE}}', '+1 555 010 2233')
    .replace('{{LOCATION}}', 'New York').replace(/\s*<span class="c-(linkedin|github|website)">\{\{[A-Z]+\}\}<\/span>/g, '')
    .replace('{{SUMMARY}}', 'Engineer at Acme Corp.').replace('{{ROLE_TITLE}}', 'Engineer').replace('{{DATES}}', '2019-2024')
    .replace('{{COMPANY}}', 'Acme Corp').replace('{{ROLE_LOCATION}}', 'New York').replace('{{BULLET}}', 'Built Python services at Acme Corp')
    .replace('{{SKILL_GROUP}}', 'Languages').replace('{{SKILLS}}', 'Python').replace('{{SCHOOL_LOCATION}}', 'New York')
    .replace('{{DEGREE}}', 'B.S.').replace('{{GRAD_YEAR}}', '2019').replace('{{SCHOOL}}', 'State University');
  const { root, job, paths, profile } = workspace(html);
  writeFileSync(profilePath(root), '---\nname: Jordan Rivera\n---\nJordan Rivera, New York. Engineer at Acme Corp, 2019-2024. Built Python services at Acme Corp. B.S., State University, 2019.\n');
  const r = await buildTailored(root, job, { profile: { ...profile, locations: { cities: ['New York'] } }, profileBody: '' });
  assert.equal(r.factGate?.ok, true, JSON.stringify(r));
  assert.equal(r.paper, 'letter');
  assert.equal(r.pages, 1);
  assert.ok(r.pdf.endsWith('Jordan-Rivera-Resume.pdf'));
  assert.ok(existsSync(paths.pdf));
  assert.ok(r.previews.length >= 1 && r.previews.every((p) => existsSync(p)));
  assert.equal(typeof r.atsScore.after, 'number');
});

import { normalizeStyle, styleCss, bundledFont, DEFAULT_STYLE } from '../scripts/lib/resume-style.mjs';
import { extractStyle } from '../scripts/extract-style.mjs';
import { normalizeProfile } from '../scripts/lib/profile.mjs';

test('normalizeStyle: keeps valid fields, falls back per field, never throws', () => {
  assert.deepEqual(normalizeStyle(undefined), DEFAULT_STYLE);
  const s = normalizeStyle({ font: 'Lora"; x{', family: 'serif', ink: 'red', sizes: { body: 9, name: 999 }, header: 'center', contact: ['email', 'fax'], sections: ['Summary', 'Work History'], bullet: 'ab' });
  assert.equal(s.font, 'Lora x');
  assert.equal(s.family, 'serif');
  assert.equal(s.ink, DEFAULT_STYLE.ink);
  assert.equal(s.sizes.body, 9);
  assert.equal(s.sizes.name, DEFAULT_STYLE.sizes.name);
  assert.deepEqual(s.contact, ['email']);
  assert.deepEqual(s.sections, ['summary', 'work-history']);
  assert.equal(s.bullet, DEFAULT_STYLE.bullet);
  assert.deepEqual(normalizeProfile({ resume_style: { header: 'center' } }).resume_style.header, 'center');
});

test('styleCss: order, header alignment, icons, and bundled font embedding', () => {
  const css = styleCss({ font: 'Merriweather', family: 'serif', header: 'center', icons: true, contact: ['email'], sections: ['education', 'summary'] }, { format: 'letter' });
  assert.match(css, /size: Letter/);
  assert.match(css, /text-align: center/);
  assert.match(css, /\.s-education \{ order: 1; \}/);
  assert.match(css, /\.s-summary \{ order: 2; \}/);
  assert.match(css, /\.c-email::before/);
  assert.doesNotMatch(css, /\.c-phone::before/);
  assert.match(css, /@font-face/);
  assert.ok(bundledFont('Merriweather')[300]);
  assert.doesNotMatch(styleCss({ font: 'Nonexistent Sans' }), /@font-face/);
});

test('extractStyle: reads the look from a real PDF', async () => {
  const { resume_style, pages } = await extractStyle(new URL('./fixtures/sample-resume.pdf', import.meta.url).pathname);
  assert.ok(pages >= 1);
  assert.ok(resume_style.sizes.name >= resume_style.sizes.body);
  assert.ok(['center', 'left'].includes(resume_style.header));
});

test('build: over the 2-page limit is reported as a problem (exit 3), the PDF is still written', async () => {
  const bullets = '<li>Built Python services at Acme Corp</li>'.repeat(140);
  const { root, job, paths, profile } = workspace(`<h1>Jordan Rivera</h1><p>Acme Corp</p><ul>${bullets}</ul>`);
  const r = await buildTailored(root, job, { profile: { ...profile, max_pages: 2 }, profileBody: 'Built Python services at Acme Corp' });
  assert.ok(r.pages > 2, `expected more than 2 pages, got ${r.pages}`);
  assert.equal(r.status, 3);
  assert.ok(r.problems.some((p) => /limit is 2/.test(p)));
});
