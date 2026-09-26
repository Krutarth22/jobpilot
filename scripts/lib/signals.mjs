// Code-extracted signals from a job description + posting row. NO AI here —
// the same JD always yields the same signals, which is what makes scores
// auditable. Used by score.mjs (component scores + knockouts + the keyword
// pre-score) and by review.mjs.

import { extractSkills } from './skills.mjs';

// Level ladder — two tracks (IC and management) mapped onto ONE scale, so
// "steps away" comparisons work across tracks too (an IC senior targeting a
// manager role is one step, not three: staff/principal sit between them on
// the IC ladder only).
export const LEVELS = ['ic-mid', 'ic-senior', 'staff', 'principal', 'manager', 'senior-manager', 'director'];
const LEVEL_SCALE = { 'ic-mid': 0, 'ic-senior': 1, staff: 2, principal: 3, manager: 2, 'senior-manager': 3, director: 4 };

const TITLE_LEVEL_PATTERNS = [
  [/director|head of|vp\b|vice president/i, 'director'],
  [/senior manager|sr\.? manager|group lead/i, 'senior-manager'],
  [/\bmanager\b|\blead\b/i, 'manager'],
  [/principal|distinguished|architect\b/i, 'principal'],
  [/staff/i, 'staff'],
  [/senior|sr\.?\b|lead engineer/i, 'ic-senior'],
];

const JD_LEVEL_PATTERNS = [
  [/director[- ]level|head of/i, 'director'],
  [/senior manager/i, 'senior-manager'],
  [/people[- ]management|managing (a team|engineers|managers)/i, 'manager'],
  [/principal (engineer|architect)/i, 'principal'],
  [/staff (engineer|level)/i, 'staff'],
  [/senior\b/i, 'ic-senior'],
];

function fromPatterns(text, patterns) {
  for (const [re, level] of patterns) if (re.test(text)) return level;
  return null;
}

/** Level index; unknown levels return null. */
export function levelIndex(level) {
  const i = LEVELS.indexOf(String(level || '').toLowerCase());
  return i === -1 ? null : i;
}

export function levelDistance(a, b) {
  const ia = LEVEL_SCALE[String(a || '').toLowerCase()];
  const ib = LEVEL_SCALE[String(b || '').toLowerCase()];
  if (ia === undefined || ib === undefined) return null;
  return Math.abs(ia - ib);
}

/**
 * Years-of-experience requirement: "5+ years", "at least 8 years",
 * "8-12 years", "minimum 3 years of experience". Takes the LOWER bound of a
 * range — the knock-out-relevant number is the floor.
 * @returns {{years: number, source: string}|null}
 */
export function extractYears(jdText = '') {
  const patterns = [
    /(\d{1,2})\s*\+?\s*(?:to|[-–—])\s*(\d{1,2})\s*\+?\s*years?/i,
    /(?:at least|minimum(?:\s+of)?|min\.?|over|more than)\s+(\d{1,2})\s*\+?\s*years?/i,
    /(\d{1,2})\s*\+\s*years?/i,
    /(\d{1,2})\s*(?:\+)?\s*years?\s+(?:of\s+)?(?:professional|relevant|industry|hands-?on)?\s*(?:work\s+)?experience/i,
  ];
  for (const re of patterns) {
    const m = jdText.match(re);
    if (m) {
      const years = Number(m[1]);
      if (Number.isFinite(years) && years > 0 && years <= 40) {
        return { years, source: m[0].trim() };
      }
    }
  }
  return null;
}

/**
 * Level from the title first (most reliable), then the JD prose.
 * @returns {{level: string, source: 'title'|'jd'}|null}
 */
export function extractLevel(title = '', jdText = '') {
  const fromTitle = fromPatterns(title || '', TITLE_LEVEL_PATTERNS);
  if (fromTitle) return { level: fromTitle, source: 'title' };
  const fromJd = fromPatterns(jdText || '', JD_LEVEL_PATTERNS);
  if (fromJd) return { level: fromJd, source: 'jd' };
  return null;
}

/**
 * Work mode from the location string + JD text. "onsite_only" is true only
 * on an explicit requirement ("must be on-site", "5 days in office",
 * "no remote") — an absence of remote language is NOT evidence.
 * @returns {{mode: 'remote'|'hybrid'|'onsite'|null, onsite_only: boolean, source: string}}
 */
export function extractWorkMode(location = '', jdText = '') {
  const haystack = `${location} ${jdText}`;
  if (/\bno remote\b|not remote|must be (?:on[- ]?site|in the office)|on[- ]?site only|\b(?:4|5)\s*days? (?:a|per) week in (?:the )?office|in[- ]?office \d days?/i.test(jdText)) {
    return { mode: 'onsite', onsite_only: true, source: 'jd text' };
  }
  if (/\bhybrid\b/i.test(haystack)) return { mode: 'hybrid', onsite_only: false, source: 'location/jd' };
  if (/\b(?:remote|work from home|distributed|wfh)\b/i.test(haystack)) return { mode: 'remote', onsite_only: false, source: 'location/jd' };
  if (/\bon[- ]?site\b/i.test(haystack)) return { mode: 'onsite', onsite_only: false, source: 'location/jd' };
  return { mode: null, onsite_only: false, source: 'none' };
}

// ── Salary ──────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const CURRENCY_WORDS = { usd: 'USD', eur: 'EUR', gbp: 'GBP', cad: 'CAD', aud: 'AUD' };

function toNumber(raw, suffix) {
  let s = String(raw).replace(/[,\s]/g, '');
  // European thousands: exactly-3-digit dot groups ("90.000" → 90000).
  // A real decimal ("90.5") never has exactly three digits after the dot.
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  const k = String(suffix || '').toLowerCase();
  if (k === 'k') n *= 1_000;
  if (k === 'm') n *= 1_000_000;
  return n;
}

/**
 * Pay-transparency extraction over JD text (and it also parses the
 * "USD 120k-150k" form the salary column itself stores). Requires a currency
 * marker; hourly rates are ignored. Returns annualized min/max.
 * @returns {{min: number, max: number, currency: string, source: string}|null}
 */
export function extractSalary(text = '') {
  const t = String(text || '');
  if (/\$?\d{1,3}(?:,\d{3})*\s*(?:per\s+hour|\/\s*hour|\/hr\b|an hour)/i.test(t)) {
    // Hourly posting: annualize a 2080-hour year only when an explicit
    // hourly range exists — better an estimate than a 40x-too-low number.
    const m = t.match(/(?:USD|\$)\s?(\d{2,3})\s*(?:[-–—to]{1,3}\s*(?:USD|\$)?\s*(\d{2,3}))?\s*(?:per\s*hour|\/\s*hour|\/hr\b)/i);
    if (m) {
      const lo = Number(m[1]) * 2080;
      const hi = (m[2] ? Number(m[2]) : Number(m[1])) * 2080;
      return { min: lo, max: hi, currency: 'USD', source: 'hourly range (annualized)' };
    }
    return null;
  }
  const re = /(?:USD|EUR|GBP|CAD|AUD|[$€£])\s*(\d{2,3}(?:[.,]\d{3})+|\d{2,4}(?:\.\d+)?)\s*(k|m)?\s*(?:[-–—]\s*|\bto\b\s*)?(?:USD|EUR|GBP|CAD|AUD|[$€£])?\s*(\d{2,3}(?:[.,]\d{3})+|\d{2,4}(?:\.\d+)?)?\s*(k|m)?/gi;
  for (const m of t.matchAll(re)) {
    const currencyWord = Object.keys(CURRENCY_WORDS).find((k) => m[0].toLowerCase().startsWith(k));
    let currency = currencyWord ? CURRENCY_WORDS[currencyWord] : CURRENCY_SYMBOLS[m[0][0]];
    if (!currency) continue;
    const min = toNumber(m[1], m[2]);
    const max = m[3] !== undefined ? toNumber(m[3], m[4] || m[2]) : min;
    if (min == null || max == null) continue;
    // Sanity: annual salaries. A bare "180" is 180k only with the k suffix;
    // without it, require 4 digits (1000+) — "20-30" with no suffix is noise.
    if (min < 10_000 || max < min || max > 5_000_000) continue;
    // 3-digit unsuffixed numbers that are actually hourly or thousands
    // shorthand got handled above; anything left in 1000..9999 is suspect.
    if (min < 30_000 && !m[2] && !/[.,]\d{3}/.test(m[1])) continue;
    // Only trust a range or a number flagged as salary-like context nearby.
    const ctx = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    const salaryContext = /salarn|compensation|base|pay|annum|annual|per year|\/yr|total/i.test(ctx) || /k\b/i.test(m[0]) || max >= 50_000;
    if (!salaryContext) continue;
    return {
      min,
      max: Math.max(min, max),
      currency,
      source: m[0].trim(),
    };
  }
  return null;
}

/** Format a numeric range for the jobs.csv salary column (also parseable by
 * extractSalary above). */
export function formatSalary(salary) {
  if (!salary || !salary.currency) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const { min, max, currency } = salary;
  return min === max ? `${currency} ${k(min)}` : `${currency} ${k(min)}-${k(max)}`;
}

/** Parse the jobs.csv salary column back into numbers (round-trip of
 * formatSalary; tolerant of the provider's raw display too). */
export function parseSalaryColumn(text = '') {
  const parsed = extractSalary(text);
  if (parsed) return parsed;
  // "USD 120k-150k" has no decimal, may fail the context guard above when
  // standalone — try a dedicated pass.
  const m = String(text).match(/^(USD|EUR|GBP|CAD|AUD)\s*(\d{1,4})(k)?\s*[-–]\s*(\d{1,4})(k)?$/i);
  if (m) {
    const mult = (k) => (k ? 1000 : 1);
    return {
      min: Number(m[2]) * mult(m[3]),
      max: Number(m[4]) * mult(m[5]),
      currency: CURRENCY_WORDS[m[1].toLowerCase()],
      source: 'jobs.csv salary column',
    };
  }
  return null;
}

// ── Required languages ─────────────────────────────────────────────────

const LANGUAGE_WORDS = ['english', 'german', 'french', 'spanish', 'dutch', 'italian', 'portuguese', 'japanese', 'mandarin', 'korean', 'arabic', 'swedish', 'danish', 'norwegian', 'finnish', 'polish', 'turkish', 'hindi'];

/** Languages the JD requires at fluency/working level. */
export function extractRequiredLanguages(jdText = '') {
  const found = new Set();
  for (const lang of LANGUAGE_WORDS) {
    const re = new RegExp(`\\b(?:fluent|native|proficient|business|working|advanced)\\s+(?:in\\s+)?${lang}\\b|\\b${lang}\\s+(?:language\\s+)?(?:fluency|proficiency|is required|required)\\b`, 'i');
    if (re.test(jdText)) found.add(lang);
  }
  return [...found];
}

// ── Keyword pre-score (A6 cross-check) ─────────────────────────────────

const JD_SKILL_CAP = 20; // dilution guard: a 60-skill JD can't dilute coverage to noise

/**
 * Coverage of the JD's canonical skills by the profile's known skills,
 * 0–100. This is the PRE-score the checklist score is cross-checked against
 * (score.mjs flags |checklist - prescore| > 25 for a recheck).
 */
export function keywordPreScore(jdText, profile, profileBody = '') {
  const jdSkills = [...extractSkills(jdText)];
  if (jdSkills.length === 0) return null;
  const known = new Set([...(profile.skills || []).map((s) => s.toLowerCase()), ...[...extractSkills(profileBody)].map((s) => s.toLowerCase())]);
  const denom = Math.min(jdSkills.length, JD_SKILL_CAP);
  const overlap = jdSkills.filter((s) => known.has(s.toLowerCase())).length;
  return Math.round((overlap / denom) * 100);
}

/** JD skills for the review scorecard (keyword coverage %). */
export function jdSkillList(jdText) {
  return [...extractSkills(jdText)];
}
