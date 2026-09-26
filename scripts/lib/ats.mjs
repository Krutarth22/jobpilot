// ATS score: how well a resume file will do inside an applicant tracking
// system for one job, 0–100. Pure code, no AI — the same file and job
// always give the same score.
//
// ATS software doesn't publish a match number; it parses the file into
// fields and recruiters search them. So the score measures exactly those
// two things, plus the format basics that make parsing work:
//
//   Keywords  50  job's must-have terms 30 · other job terms 10 · job title 10
//   Readable  30  real text 10 · standard headings 10 · contact info 5 · clean characters 5
//   Format    20  length 10 · date ranges 5 · file type 5
//
// Each term counts once, so repeating a keyword never raises the score.

import { extname, basename } from 'node:path';
import { extractTerms } from './skills.mjs';
import { jdTerms } from './signals.mjs';

const TERM_CAP = 20; // a 40-term JD can't make every term worth nothing

const HEADINGS = {
  Experience: /^\s*(?:work |professional |relevant )?(?:experience|employment(?: history)?|work history)\s*:?\s*$/im,
  Education: /^\s*education(?: (?:and|&) (?:training|certifications?))?\s*:?\s*$/im,
  Skills: /^\s*(?:technical |core |key )?(?:skills|competencies|technologies)(?: (?:and|&) \w+)?\s*:?\s*$/im,
};
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\d\s().-]{8,}\d)/;
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_RANGE = new RegExp(
  `(?:${MONTHS}\\s+)?(?:\\d{1,2}/)?(?:19|20)\\d{2}\\s*(?:[-–—]|to)\\s*(?:(?:${MONTHS}\\s+)?(?:\\d{1,2}/)?(?:19|20)\\d{2}|present|current|now)`,
  'gi',
);
const TITLE_STOP = new Set(['and', 'the', 'for', 'of', 'with', 'sr', 'jr', 'senior', 'junior', 'staff', 'principal', 'lead', 'ii', 'iii', 'iv']);

// Terms are compared lowercased but shown with their display names.
const DISPLAY = new Map();
const lower = (xs) => new Set([...xs].map((x) => {
  const key = String(x).toLowerCase();
  if (!DISPLAY.has(key) || DISPLAY.get(key) === key) DISPLAY.set(key, String(x));
  return key;
}));
const display = (keys) => keys.map((k) => DISPLAY.get(k) || k);
const round = (n) => Math.round(n * 10) / 10;

/** Core words of a job title, without the team suffix or seniority words:
 * "Senior Manager, Software Engineering – Data Platform" → manager, software, engineering. */
export function titleWords(title) {
  const role = String(title || '').split(/\s[-–—|]\s|\(/)[0];
  return role.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 2 && !TITLE_STOP.has(w));
}

function keywordPart({ text, jdText, checklist, jobTitle, profile }) {
  const found = lower(extractTerms(text, profile?.skills || []));
  const musts = (checklist?.requirements || []).filter((r) => r.type === 'must');
  const mustTerms = [...lower(extractTerms(musts.map((r) => r.text || '').join('\n'), profile?.skills || []))];
  const jobTerms = [...lower(jdTerms(jdText || '', profile || {}))];
  const otherTerms = jobTerms.filter((t) => !mustTerms.includes(t));
  if (mustTerms.length === 0 && jobTerms.length === 0) return null;

  // No checklist yet → all 40 keyword points ride on the job's terms.
  const [mustPts, otherPts] = mustTerms.length > 0 ? [30, 10] : [0, 40];
  const pool = mustTerms.length > 0 ? otherTerms : jobTerms;
  const share = (terms, pts) => (terms.length === 0 ? pts
    : pts * Math.min(1, terms.filter((t) => found.has(t)).length / Math.min(terms.length, TERM_CAP)));

  const words = new Set(text.toLowerCase().split(/[^a-z0-9+#]+/));
  const tw = titleWords(jobTitle);
  const titlePts = tw.length === 0 ? 10 : 10 * (tw.filter((w) => words.has(w)).length / tw.length);

  const missingMust = mustTerms.filter((t) => !found.has(t));
  const missingOther = pool.filter((t) => !found.has(t));
  return {
    points: round(share(mustTerms, mustPts) + share(pool, otherPts) + titlePts),
    of: 50,
    mustHave: { found: mustTerms.length - missingMust.length, of: mustTerms.length, missing: missingMust },
    otherTerms: { found: pool.length - missingOther.length, of: pool.length, missing: missingOther },
    // (missing lists hold lowercase keys; atsScore maps them to display names)
    title: { words: tw, found: tw.filter((w) => words.has(w)) },
  };
}

function readablePart(text) {
  const wordCount = (text.match(/[A-Za-z]{2,}/g) || []).length;
  // A scanned image yields next to no text; a short resume still has 50+ words.
  const hasText = wordCount >= 50;
  const headings = Object.entries(HEADINGS).filter(([, re]) => re.test(text)).map(([h]) => h);
  const garbled = (text.match(/\(cid:\d+\)|�/g) || []).length;
  const checks = {
    realText: hasText ? 10 : 0,
    headings: round(10 * headings.length / 3),
    contact: (EMAIL.test(text) ? 3 : 0) + (PHONE.test(text) ? 2 : 0),
    cleanCharacters: garbled === 0 ? 5 : garbled < 5 ? 2 : 0,
  };
  return {
    points: round(Object.values(checks).reduce((a, b) => a + b, 0)),
    of: 30,
    checks,
    wordCount,
    headingsFound: headings,
    headingsMissing: Object.keys(HEADINGS).filter((h) => !headings.includes(h)),
    garbled,
  };
}

function formatPart({ text, pages, fileName }) {
  // DOCX has no pages until it's opened; ~550 words fill a page.
  const wordCount = (text.match(/\S+/g) || []).length;
  const estPages = pages ?? Math.max(1, Math.ceil(wordCount / 550));
  const ranges = (text.match(DATE_RANGE) || []).length;
  const ext = extname(fileName || '').toLowerCase();
  const checks = {
    length: estPages <= 2 ? 10 : estPages === 3 ? 5 : 0,
    dateRanges: ranges >= 2 ? 5 : ranges === 1 ? 3 : 0,
    fileType: ext === '.pdf' || ext === '.docx' ? 5 : 0,
  };
  return {
    points: round(Object.values(checks).reduce((a, b) => a + b, 0)),
    of: 20,
    checks,
    pages: estPages,
    pagesEstimated: pages == null,
    dateRanges: ranges,
  };
}

/**
 * Score one resume file's text against one job. Returns the 0–100 score,
 * its three parts, and plain-language fixes. `profile`/`profileBody` split
 * missing keywords into ones the profile backs (safe to add) and real gaps.
 */
export function atsScore({ text = '', pages = null, fileName = '', jdText = '', checklist = null, jobTitle = '', profile = {}, profileBody = '' }) {
  const keywords = keywordPart({ text, jdText, checklist, jobTitle, profile });
  const readable = readablePart(text);
  const format = formatPart({ text, pages, fileName });

  // No job description or checklist: score the other two parts out of 100.
  const parts = [keywords, readable, format].filter(Boolean);
  const earned = parts.reduce((a, p) => a + p.points, 0);
  const possible = parts.reduce((a, p) => a + p.of, 0);
  let score = Math.round((earned / possible) * 100);
  // A file the ATS can't read as text scores almost nothing, however it looks.
  if (!readable.checks.realText) score = Math.min(score, 10);

  const backed = lower(extractTerms(profileBody, profile.skills || []));
  for (const s of profile.skills || []) backed.add(String(s).toLowerCase());
  const missing = keywords ? [...keywords.mustHave.missing, ...keywords.otherTerms.missing] : [];
  const canAdd = display(missing.filter((t) => backed.has(t)));
  const gaps = display(missing.filter((t) => !backed.has(t)));
  if (keywords) {
    keywords.mustHave.missing = display(keywords.mustHave.missing);
    keywords.otherTerms.missing = display(keywords.otherTerms.missing);
  }

  const fixes = [];
  if (!readable.checks.realText) fixes.push('The file has almost no readable text — it may be a scanned image. Export it as a text PDF or DOCX.');
  if (canAdd.length) fixes.push(`Add keywords your experience backs: ${canAdd.slice(0, 8).join(', ')}.`);
  if (keywords && keywords.title.found.length < keywords.title.words.length) fixes.push(`Use the job's title wording where it's true for you (${keywords.title.words.join(' ')}).`);
  if (readable.headingsMissing.length) fixes.push(`Use standard section headings: ${readable.headingsMissing.join(', ')}.`);
  if (readable.checks.contact < 5) fixes.push('Put your email and phone number as plain text at the top.');
  if (readable.garbled) fixes.push('Some characters come out garbled — use a standard font.');
  if (format.checks.length < 10) fixes.push(`Shorten to 2 pages or fewer (now ${format.pages}).`);
  if (format.checks.dateRanges < 5) fixes.push('Give each role a date range like "Jan 2020 – Present".');
  if (format.checks.fileType === 0) fixes.push('Send a PDF or DOCX.');

  return {
    score,
    file: basename(fileName || ''),
    parts: { keywords, readable, format },
    keywordsYouCanAdd: canAdd,
    keywordGaps: gaps,
    fixes,
    note: 'Measures what an ATS does with your file: parse it, then let recruiters search it. Each keyword counts once — repeating one never helps.',
  };
}
