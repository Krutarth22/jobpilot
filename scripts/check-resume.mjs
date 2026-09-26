#!/usr/bin/env node
// jobpilot check-resume — the code-enforced no-fabrication gate (C3) plus a
// deterministic bullet lint (C5).
//
//   node check-resume.mjs <tailored.html|tailored.pdf> [--resume out/file.html]
//
// Every number, date, company/title line and skill in the tailored resume
// must trace to profile.md. Anything that fails is listed; a non-zero exit
// blocks PDF rendering (the review skill runs this BEFORE render).
//
// Idea adapted from career-ops verify-cv-facts.mjs (MIT).

import { readFile } from 'node:fs/promises';
import { isMainModule } from './lib/main.mjs';
import { workspaceRoot, profilePath } from './lib/workspace.mjs';
import { extractSkills } from './lib/skills.mjs';
import { extractText } from './parse-resume.mjs';

function foldDigits(text) {
  return String(text).normalize('NFKC').replace(/\u066a/g, '%').replace(/[\u00a0\u202f]/g, ' ');
}

function norm(s) {
  return foldDigits(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Strip HTML to text, keeping line structure (bullets stay lines). */
export function htmlToLines(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

function extractMetrics(text) {
  // Numbers worth tracing: percentages, money, multipliers, counts with a
  // unit word. Bare years are handled separately as dates.
  const clean = foldDigits(text);
  const claims = new Set();
  for (const m of clean.matchAll(/(\d[\d,.]*)\s*(?:%|percent|x\b|k\b|m\b|ms\b|hrs?\b|hours?\b|days?\b|weeks?\b|months?\b|users\b|customers\b|engineers\b|people\b|repos?\b|services\b|teams\b|million\b|billion\b)/gi)) {
    claims.add(m[0].toLowerCase().replace(/[.,]$/, ''));
  }
  for (const m of clean.matchAll(/[$€£]\s?\d[\d,.]*\s?[kmb]?/gi)) claims.add(m[0].toLowerCase().replace(/[.,]$/, ''));
  return claims;
}

function extractDates(text) {
  return new Set((foldDigits(text).match(/\b(?:19|20)\d{2}\b/g) || []));
}

// ── C5: bullet lint ─────────────────────────────────────────────────────

const WEAK_OPENINGS = /^(?:responsible for|worked on|worked with|helped(?: with| to)?|involved in|assisted (?:with|in)|tasked with|duties included|participated in|in charge of|was part of)\b/i;
const MAX_BULLET_CHARS = 190; // ~2 lines at 10.5pt across 7in

export function lintBullets(bullets, profileBullets = []) {
  const findings = [];
  const openings = new Map();
  const profileMetricRatio = profileBullets.length > 0
    ? profileBullets.filter((b) => /\d/.test(b)).length / profileBullets.length
    : 0;
  const resumeMetricBullets = bullets.filter((b) => /\d/.test(b)).length;

  bullets.forEach((bullet, i) => {
    if (WEAK_OPENINGS.test(bullet)) findings.push({ bullet: i + 1, issue: 'weak opening', detail: bullet.slice(0, 60) });
    if (bullet.length > MAX_BULLET_CHARS) findings.push({ bullet: i + 1, issue: 'too long (>2 lines)', detail: `${bullet.length} chars` });
    const first = (bullet.match(/[A-Za-z]+/) || [''])[0].toLowerCase();
    openings.set(first, (openings.get(first) || 0) + 1);
  });
  for (const [word, n] of openings) {
    if (n > 1) findings.push({ bullet: '-', issue: `repeated opening "${word}" ×${n}`, detail: 'vary the verbs' });
  }
  // Metric preservation: if most original bullets carried numbers, the
  // rewritten set should too (reframing never drops the evidence).
  if (profileMetricRatio >= 0.5 && bullets.length > 0 && resumeMetricBullets / bullets.length < profileMetricRatio * 0.75) {
    findings.push({
      bullet: '-',
      issue: 'metrics lost',
      detail: `${Math.round(profileMetricRatio * 100)}% of profile bullets carry numbers, only ${resumeMetricBullets}/${bullets.length} of the rewritten ones do`,
    });
  }
  return findings;
}

// ── C3: the fact gate ───────────────────────────────────────────────────

/**
 * Pure audit: tailored text (+ optional role/company lines) vs profile.
 * @returns {{ok: boolean, violations: string[], lint: object[]}}
 */
export function auditResume({ tailoredText, roleLines = [], bullets = [], profileText }) {
  const profile = norm(profileText);
  const violations = [];

  // 1. Every date (year) in the resume appears in the profile.
  for (const year of extractDates(tailoredText)) {
    if (!profile.includes(year)) violations.push(`date ${year} not in profile.md`);
  }
  // 2. Every metric-like claim appears in the profile (folded, normalized):
  // the exact phrasing, or at least the bare number with word boundaries.
  const profileMetrics = extractMetrics(profileText);
  for (const claim of extractMetrics(tailoredText)) {
    const numeric = claim.match(/\d[\d,.]*/)?.[0] ?? '';
    const inProfile = profileMetrics.has(claim)
      || new RegExp(`\\b${numeric.replace(/[.,]/g, '')}\\b`).test(foldDigits(profileText));
    if (!inProfile) violations.push(`metric "${claim}" not in profile.md`);
  }
  // 3. Company/title lines (the role headings): the company segment must
  // trace to the profile; date segments are covered by the date check and
  // the posting city is presentation, not a claim.
  for (const line of roleLines) {
    const segments = line.split('·').map((s) => norm(s)).filter(Boolean);
    const company = segments[0];
    if (company && !/\d/.test(company) && !profile.includes(company)) {
      violations.push(`"${company}" in role line not in profile.md`);
    }
  }
  // 4. Every skill is known to the profile (front matter or prose).
  const known = new Set([...extractSkills(profileText)].map((s) => s.toLowerCase()));
  for (const skill of extractSkills(tailoredText)) {
    if (!known.has(skill.toLowerCase())) violations.push(`skill "${skill}" not in profile.md`);
  }

  const lint = lintBullets(bullets, (profileText.match(/^\s*[•\-*]\s+(.+)$/gm) || []));
  return { ok: violations.length === 0 && lint.length === 0, violations, lint };
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function loadTailoredText(file) {
  if (/\.pdf$/i.test(file)) return extractText(file);
  return (await readFile(file, 'utf8'));
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node check-resume.mjs <tailored.html|pdf> [--jd <jd.txt>]');
    process.exit(1);
  }
  const root = workspaceRoot();
  const profileText = await readFile(profilePath(root), 'utf8');
  let tailored = await loadTailoredText(file);
  const lines = tailored.includes('<') ? htmlToLines(tailored) : tailored.split('\n').map((l) => l.trim()).filter(Boolean);

  const bullets = lines.filter((l) => /^[•\-*]\s+/.test(l));
  // Role headings: lines that look like "Company · Location" or a bare job title
  const roleLines = lines.filter((l) => /·/.test(l) || /^[A-Z][\w.&' ]+(?:Engineer|Manager|Designer|Director|Lead|Developer|Scientist|Analyst)(?:[ ,:-].*)?$/.test(l));

  const audit = auditResume({ tailoredText: tailored, roleLines, bullets, profileText });
  console.log(JSON.stringify({ ok: audit.ok, violations: audit.violations, lint: audit.lint }, null, 2));
  if (!audit.ok) {
    console.error(`❌ fact gate FAILED: ${audit.violations.length} violation(s), ${audit.lint.length} lint finding(s). Fix the source (profile.md) or the bullet — do not render.`);
    process.exit(1);
  }
  console.error('✅ fact gate passed: every number, date, company/title and skill traces to profile.md');
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
