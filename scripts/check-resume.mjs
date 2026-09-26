#!/usr/bin/env node
// jobpilot check-resume — the code-enforced no-fabrication gate (C3) plus a
// deterministic bullet lint (C5).
//
//   node check-resume.mjs <tailored.html|tailored.pdf> [--resume out/file.html]
//
// Every number, date, company/title line and skill in the tailored resume
// must trace to profile.md. A fact violation exits non-zero and blocks PDF
// rendering (the review skill runs this BEFORE render). Bullet-lint findings
// are style advice: reported, never blocking.
//
// Idea adapted from career-ops verify-cv-facts.mjs (MIT).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isMainModule } from './lib/main.mjs';
import { workspaceRoot, profilePath } from './lib/workspace.mjs';
import { extractSkills } from './lib/skills.mjs';
import { extractText } from './parse-resume.mjs';
import { claimsPath, validateClaims } from './claims.mjs';

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

// Unit classes: a claim only traces to the profile when the SAME number
// appears with the SAME kind of unit. "Cut costs 40%" must not be vouched
// for by "a team of 40 engineers".
const UNIT_CLASS = {
  '%': 'pct', percent: 'pct', x: 'x',
  ms: 'ms', hr: 'time', hrs: 'time', hour: 'time', hours: 'time',
  day: 'days', days: 'days', week: 'weeks', weeks: 'weeks', month: 'months', months: 'months',
  users: 'count', customers: 'count', engineers: 'count', people: 'count', repo: 'count', repos: 'count', services: 'count', teams: 'count',
};
const MAGNITUDE = { k: 1e3, m: 1e6, b: 1e9, million: 1e6, billion: 1e9 };

function toValue(raw, magnitude) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * (MAGNITUDE[String(magnitude || '').toLowerCase()] || 1) * 1000) / 1000 : null;
}

/** Metric claims as canonical "class:value" keys ("pct:40", "money:2000000"). */
export function extractMetrics(text) {
  const clean = foldDigits(text);
  const claims = new Map(); // key → the phrase as written
  for (const m of clean.matchAll(/[$€£]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|b|million|billion)?\b/gi)) {
    const v = toValue(m[1], m[2]);
    if (v !== null) claims.set(`money:${v}`, m[0].trim());
  }
  for (const m of clean.matchAll(/(?<![$€£\d.,])(\d[\d,]*(?:\.\d+)?)\s*(k|m|million|billion)?\s*(%|percent|x\b|ms\b|hrs?\b|hours?\b|days?\b|weeks?\b|months?\b|users\b|customers\b|engineers\b|people\b|repos?\b|services\b|teams\b)/gi)) {
    const v = toValue(m[1], m[2]);
    const unit = UNIT_CLASS[m[3].toLowerCase()];
    if (v !== null && unit) claims.set(`${unit}:${v}`, m[0].trim());
  }
  for (const m of clean.matchAll(/(?<![$€£\d.,])(\d[\d,]*(?:\.\d+)?)\s*(k|million|billion)\b(?!\s*(?:%|percent|x\b|ms\b|hrs?\b|hours?\b|days?\b|weeks?\b|months?\b|users\b|customers\b|engineers\b|people\b|repos?\b|services\b|teams\b))/gi)) {
    const v = toValue(m[1], m[2]);
    if (v !== null) claims.set(`num:${v}`, m[0].trim());
  }
  return claims;
}

function extractDates(text) {
  return new Set((foldDigits(text).match(/\b(?:19|20)\d{2}\b/g) || []));
}

// ── C5: bullet lint ─────────────────────────────────────────────────────

const WEAK_OPENINGS = /^(?:responsible for|worked on|worked with|helped(?: with| to)?|involved in|assisted (?:with|in)|tasked with|duties included|participated in|in charge of|was part of)\b/i;
const MAX_BULLET_CHARS = 190; // ~2 lines at 10.5pt across 7in

const stripMarker = (line) => String(line).replace(/^\s*[•\-*]\s+/, '');

export function lintBullets(rawBullets, profileBullets = []) {
  const findings = [];
  const bullets = rawBullets.map(stripMarker); // "• Responsible for…" must still read as a weak opening
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
  // 2. Every metric claim appears in the profile as the same number with the
  // same kind of unit (see extractMetrics).
  const profileMetrics = extractMetrics(profileText);
  for (const [key, phrase] of extractMetrics(tailoredText)) {
    if (!profileMetrics.has(key)) violations.push(`metric "${phrase}" not in profile.md`);
  }
  // 3. Role lines ("Title · Company · Location · 2019–2026"): every text
  // segment — title, company, location — must trace to the profile. Date
  // segments are covered by the date check.
  for (const line of roleLines) {
    for (const segment of line.split(/[·|]/).map((s) => norm(s)).filter(Boolean)) {
      if (!/\d/.test(segment) && !profile.includes(segment)) {
        violations.push(`"${segment}" in role line not in profile.md`);
      }
    }
  }
  // 4. Every skill is known to the profile (front matter or prose).
  const known = new Set([...extractSkills(profileText)].map((s) => s.toLowerCase()));
  for (const skill of extractSkills(tailoredText)) {
    if (!known.has(skill.toLowerCase())) violations.push(`skill "${skill}" not in profile.md`);
  }

  const lint = lintBullets(bullets, (profileText.match(/^\s*[•\-*]\s+(.+)$/gm) || []));
  // Only facts gate the render; lint is advice the user can take or leave.
  return { ok: violations.length === 0, violations, lint };
}

// ── Fact gate ↔ claim self-check advisory bridge ────────────────────────
// If the user has run the review skill's claim self-check (claims.json),
// warn — never block — when a tailored bullet's wording lands on a claim
// already flagged "Material inconsistency" there. The fact gate only checks
// numbers/dates/skills trace to profile.md; it has no opinion on whether a
// TRUE claim is still worded in a way a recruiter would push back on.

function significantWords(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9+.#-]{3,}/g) || []);
}

/** Bullets whose wording overlaps a claim already flagged "Material
 * inconsistency" in claims.json. Advisory only — never touches `ok`. */
export function claimWarnings(bullets, claimsReport) {
  const material = (claimsReport?.claims || []).filter((c) => c.assessment === 'Material inconsistency');
  if (material.length === 0) return [];
  const warnings = [];
  for (const bullet of bullets) {
    const bulletWords = significantWords(bullet);
    for (const claim of material) {
      const claimWords = significantWords(claim.claim);
      if (claimWords.size === 0) continue;
      const overlap = [...claimWords].filter((w) => bulletWords.has(w)).length;
      if (overlap / claimWords.size >= 0.5) {
        warnings.push({
          bullet, claimId: claim.id, claim: claim.claim,
          message: `overlaps claim ${claim.id} ("${claim.claim}"), flagged "Important details don't match" in claims.json — verify the wording before using it`,
        });
      }
    }
  }
  return warnings;
}

async function loadClaimsReport(root) {
  const p = claimsPath(root);
  if (!existsSync(p)) return null;
  try {
    return validateClaims(JSON.parse(await readFile(p, 'utf8')));
  } catch {
    return null; // advisory hook: a broken claims.json never blocks the fact gate
  }
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
  const claimsReport = await loadClaimsReport(root);
  const claimWarns = claimsReport ? claimWarnings(bullets, claimsReport) : [];
  console.log(JSON.stringify({ ok: audit.ok, violations: audit.violations, lint: audit.lint, claimWarnings: claimWarns }, null, 2));
  if (!audit.ok) {
    console.error(`❌ fact gate FAILED: ${audit.violations.length} violation(s). Fix the source (profile.md) or the bullet — do not render.`);
    process.exit(1);
  }
  console.error('✅ fact gate passed: every number, date, company/title and skill traces to profile.md');
  if (audit.lint.length > 0) console.error(`✏️  ${audit.lint.length} style suggestion(s) from the bullet lint — optional.`);
  if (claimWarns.length > 0) console.error(`⚠️  ${claimWarns.length} bullet(s) overlap a claim flagged "Important details don't match" in claims.json — advisory only, does not block.`);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
