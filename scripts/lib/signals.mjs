// Code-extracted signals from a job description + posting row. NO AI here —
// the same JD always yields the same signals, which is what makes scores
// auditable. Used by score.mjs (component scores + knockouts + the keyword
// pre-score) and by review.mjs.

import { extractSkills, extractTerms } from './skills.mjs';

// Level ladder — two tracks (IC and management) mapped onto ONE scale.
// Switching tracks costs one extra step: a manager applying to a staff IC
// role, or a senior IC applying to a manager role, is a real mismatch even
// when the rungs line up.
export const LEVELS = ['ic-mid', 'ic-senior', 'staff', 'principal', 'manager', 'senior-manager', 'director'];
const LEVEL_SCALE = { 'ic-mid': 0, 'ic-senior': 1, staff: 2, principal: 3, manager: 2, 'senior-manager': 3, director: 4 };
const MANAGEMENT = new Set(['manager', 'senior-manager', 'director']);

// "Product Manager", "Account Manager" … are job functions, not people
// management; strip them before level matching so "Senior Product Manager"
// reads as a senior IC, not a senior manager.
const NON_PEOPLE_MANAGER = /\b(product|program|project|account|marketing|sales|partner|community|customer success)\s+manager\b/gi;

const TITLE_LEVEL_PATTERNS = [
  [/\bdirector\b|\bhead of\b|\bvp\b|\bvice president\b/i, 'director'],
  [/\b(?:senior|sr\.?)\s+(?:[\w-]+\s+)?manager\b|\bgroup (?:engineering )?manager\b|\bmanager of managers\b/i, 'senior-manager'],
  [/\bmanager\b/i, 'manager'], // includes "Tech Lead Manager"; a bare "Lead" is an IC (below)
  [/\bprincipal\b|\bdistinguished\b|\barchitect\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\bsenior\b|\bsr\b\.?|\blead\b|\biii\b/i, 'ic-senior'],
  [/\bii\b|\bmid[- ]level\b|\bintermediate\b/i, 'ic-mid'],
];

// Prose is noisy ("you'll work with senior leaders"), so the JD only
// counts when it states the level of THIS role.
const JD_LEVEL_PATTERNS = [
  [/director[- ]level|head of/i, 'director'],
  [/senior manager/i, 'senior-manager'],
  [/people[- ]management|managing (a team|engineers|managers)/i, 'manager'],
  [/principal (engineer|architect)/i, 'principal'],
  [/staff (engineer|level)/i, 'staff'],
  [/\bsenior[- ]level\b/i, 'ic-senior'],
];

// A plain individual-contributor title with no level word ("Software
// Engineer", "Data Scientist") is mid-level at nearly every company.
const IC_TITLE = /\b(engineer|developer|scientist|analyst|designer|researcher)\b/i;

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
  const la = String(a || '').toLowerCase();
  const lb = String(b || '').toLowerCase();
  const ia = LEVEL_SCALE[la];
  const ib = LEVEL_SCALE[lb];
  if (ia === undefined || ib === undefined) return null;
  return Math.abs(ia - ib) + (MANAGEMENT.has(la) !== MANAGEMENT.has(lb) ? 1 : 0);
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
 * Level from the title first (most reliable), then an explicit statement in
 * the JD, then the plain-IC-title default.
 * @returns {{level: string, source: 'title'|'jd'|'title-default'}|null}
 */
export function extractLevel(title = '', jdText = '') {
  const cleanTitle = String(title || '').replace(NON_PEOPLE_MANAGER, '$1 role');
  const fromTitle = fromPatterns(cleanTitle, TITLE_LEVEL_PATTERNS);
  if (fromTitle) return { level: fromTitle, source: 'title' };
  const fromJd = fromPatterns(jdText || '', JD_LEVEL_PATTERNS);
  if (fromJd) return { level: fromJd, source: 'jd' };
  if (IC_TITLE.test(cleanTitle)) return { level: 'ic-mid', source: 'title-default' };
  return null;
}

// "3 days a week in the office" is hybrid, not on-site only.
const PARTIAL_OFFICE_DAYS = /\b(?:[1-4]|one|two|three|four)\s*(?:days?|x)\s*(?:a|per|\/)\s*week\b|\bin[- ]?office\s*(?:[1-4]|one|two|three|four)\s*days?\b/i;
const FULLY_ONSITE = /\bno remote\b|must be (?:on[- ]?site|in the office)|\bon[- ]?site only\b|\bfully (?:on[- ]?site|in[- ]office)\b|\b(?:5|five)\s*days? (?:a|per) week\b|\bin[- ]?office (?:5|five) days\b/i;
// Negated remote language must not read as "remote".
const NOT_REMOTE = /\bnot (?:a )?remote\b|\bnot (?:eligible|available|open) for remote\b|\bremote (?:work )?(?:is )?not (?:available|an option|possible|offered)\b|\bnon[- ]remote\b/gi;

/**
 * Work mode from the location string + JD text. "onsite_only" is true only
 * on an explicit full-time requirement ("must be on-site", "5 days a week",
 * "no remote") — partial office days are hybrid, and an absence of remote
 * language is NOT evidence.
 * @returns {{mode: 'remote'|'hybrid'|'onsite'|null, onsite_only: boolean, source: string}}
 */
export function extractWorkMode(location = '', jdText = '') {
  if (PARTIAL_OFFICE_DAYS.test(jdText)) return { mode: 'hybrid', onsite_only: false, source: 'jd text (office days)' };
  if (FULLY_ONSITE.test(jdText)) return { mode: 'onsite', onsite_only: true, source: 'jd text' };
  const haystack = `${location} ${jdText}`;
  if (/\bhybrid\b/i.test(haystack)) return { mode: 'hybrid', onsite_only: false, source: 'location/jd' };
  const withoutNegations = haystack.replace(NOT_REMOTE, ' ');
  const negated = withoutNegations !== haystack;
  if (/\b(?:remote|work from home|distributed|wfh)\b/i.test(withoutNegations)) return { mode: 'remote', onsite_only: false, source: 'location/jd' };
  if (negated) return { mode: 'onsite', onsite_only: false, source: 'jd text (remote ruled out)' };
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
    const salaryContext = /salar(?:y|ies)|compensation|base|pay|annum|annual|per year|\/yr|total/i.test(ctx) || /k\b/i.test(m[0]) || max >= 50_000;
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
// Below this many recognizable JD terms the overlap is too thin to judge a
// checklist by — the cross-check is skipped, and score.mjs says so.
export const MIN_PRESCORE_TERMS = 5;

/** The terms the cross-check recognizes in a JD: hard skills, practice
 * terms, and the user's own listed skills. */
export function jdTerms(jdText, profile = {}) {
  return [...extractTerms(jdText, profile.skills || [])];
}

/**
 * Coverage of the JD's recognizable terms by the profile's, 0–100. This is
 * the PRE-score the checklist score is cross-checked against (score.mjs
 * flags |checklist - prescore| > 25 for a recheck). null when the JD has
 * fewer than MIN_PRESCORE_TERMS recognizable terms.
 */
export function keywordPreScore(jdText, profile, profileBody = '') {
  const terms = jdTerms(jdText, profile);
  if (terms.length < MIN_PRESCORE_TERMS) return null;
  const known = new Set([
    ...(profile.skills || []).map((s) => s.toLowerCase()),
    ...[...extractTerms(profileBody, profile.skills || [])].map((t) => t.toLowerCase()),
  ]);
  const denom = Math.min(terms.length, JD_SKILL_CAP);
  const overlap = terms.filter((t) => known.has(t.toLowerCase())).length;
  return Math.min(100, Math.round((overlap / denom) * 100));
}

/** JD skills for the review scorecard (keyword coverage %). */
export function jdSkillList(jdText, profile = {}) {
  return jdTerms(jdText, profile);
}
