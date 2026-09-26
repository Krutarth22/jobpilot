#!/usr/bin/env node
// jobpilot score — deterministic scorer. The AI extracts facts (the
// requirement checklist with evidence); this script computes the numbers.
// Same checklist + same signals → same score, every time.
//
//   node score.mjs <id>                                  # score from an existing evals/<id>.json checklist
//   node score.mjs <id> --checklist-file <path|->        # ingest a checklist JSON, then score
//
// Checklist shape (written by the match skill's AI pass):
//   { "requirements": [
//       { "text": "5+ years ML in production", "type": "must", "category": "skills",
//         "verdict": "met", "evidence": "profile: 'Led ranking models at Acme 2019-2024'" } ],
//     "domain": { "verdict": "partial", "evidence": "..." } }
//
// Verdicts: met | partial | missing. A "met" whose evidence doesn't quote
// profile.md is DOWNGRADED to partial by code — a quote-less met is a claim,
// not evidence.

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  workspaceRoot, findJob, updateJobs, readEval, writeEval,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { loadProfile } from './lib/profile.mjs';
import { fetchDescription } from './jobs.mjs';
import {
  extractYears, extractLevel, extractWorkMode, extractSalary, parseSalaryColumn,
  extractRequiredLanguages, keywordPreScore, levelDistance,
} from './lib/signals.mjs';

export const NEUTRAL = 50; // an "unknown" signal scores neutral, never zero

const VERDICT_POINTS = { met: 1, partial: 0.5, missing: 0 };

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// ── A1: checklist validation ────────────────────────────────────────────

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'is', 'was', 'my', 'our', 'i', 'we']);
export const MIN_QUOTE_WORDS = 4;

/** The quoted spans of an evidence string, or the whole string (minus a
 * leading "profile:") when nothing is quoted. Single quotes are matched
 * greedily so an apostrophe inside the quote ("Acme's") survives. */
function quotedSpans(evidence) {
  const text = String(evidence || '');
  const spans = [...text.matchAll(/"([^"]+)"|“([^”]+)”|'(.+)'/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return spans.length > 0 ? spans : [text.replace(/^\s*profile\s*:\s*/i, '')];
}

/**
 * A "met" verdict must QUOTE profile.md: the whole quoted span must appear
 * (normalized, on word boundaries) in the profile body, and be either at
 * least MIN_QUOTE_WORDS words with 2+ content words, or made up only of
 * the profile's listed skills. Matching any short run inside a longer claim is
 * not enough — "experience with python" must not vouch for "experience with
 * python and kafka at scale".
 */
export function evidenceBacked(evidence, profileBody, profileSkills = []) {
  const prof = ` ${normalizeText(profileBody)} `;
  if (!prof.trim()) return false;
  const skills = new Set(profileSkills.map(normalizeText));
  for (const span of quotedSpans(evidence)) {
    const quote = normalizeText(span);
    if (!quote || !prof.includes(` ${quote} `)) continue;
    const words = quote.split(' ');
    const contentWords = words.filter((w) => !STOPWORDS.has(w));
    if (words.length >= MIN_QUOTE_WORDS && contentWords.length >= 2) return true;
    // A short quote is fine when it is (part of) the skills list itself:
    // "Python, PyTorch, Kubernetes" — every item must be a listed skill.
    const items = String(span).split(/[,;/|]/).map(normalizeText).filter(Boolean);
    if (items.length > 0 && items.every((item) => skills.has(item))) return true;
  }
  return false;
}

/** Validate + downgrade. Returns {clean, downgraded: [{text, reason}]} */
export function validateChecklist(checklist, profileBody, profileSkills = []) {
  const downgraded = [];
  const requirements = (Array.isArray(checklist?.requirements) ? checklist.requirements : [])
    .map((req) => {
      const verdict = ['met', 'partial', 'missing'].includes(req?.verdict) ? req.verdict : 'missing';
      if (verdict === 'met' && !evidenceBacked(req?.evidence, profileBody, profileSkills)) {
        downgraded.push({ text: req?.text || '', reason: 'met without a profile.md quote' });
        return { ...req, verdict: 'partial' };
      }
      return { ...req, verdict };
    });
  let domain = null;
  if (checklist?.domain) {
    const verdict = ['met', 'partial', 'missing'].includes(checklist.domain.verdict) ? checklist.domain.verdict : 'missing';
    if (verdict === 'met' && !evidenceBacked(checklist.domain.evidence, profileBody, profileSkills)) {
      downgraded.push({ text: '(domain)', reason: 'met without a profile.md quote' });
      domain = { ...checklist.domain, verdict: 'partial' };
    } else {
      domain = { ...checklist.domain, verdict };
    }
  }
  return { clean: { requirements, domain }, downgraded };
}

// ── Component scores ────────────────────────────────────────────────────

/** Skills = weighted coverage. must ×2, nice ×1; met=1, partial=.5, missing=0. */
export function skillsScore(requirements) {
  const skillReqs = requirements.filter((r) => (r.category || 'skills') === 'skills');
  if (skillReqs.length === 0) return { pct: null, metCount: 0, total: 0 }; // unknown → neutral
  let points = 0;
  let max = 0;
  let metCount = 0;
  for (const r of skillReqs) {
    const mult = r.type === 'nice' ? 1 : 2; // anything not explicitly nice is must
    points += VERDICT_POINTS[r.verdict] * mult;
    max += mult;
    if (r.verdict === 'met') metCount++;
  }
  return { pct: Math.round((points / max) * 100), metCount, total: skillReqs.length };
}

/** Seniority from code signals vs the profile's years + level. */
export function seniorityScore(signals, profile) {
  const parts = [];
  const req = signals.years; // {years} | null
  const myYears = profile.years_experience;
  if (req && Number.isFinite(myYears)) {
    const deficit = req.years - myYears;
    parts.push(deficit <= 0 ? 90 : deficit < 1 ? 75 : deficit < 2 ? 40 : 15);
  }
  const jdLevel = signals.level?.level ?? null;
  if (jdLevel && profile.level) {
    const d = levelDistance(jdLevel, profile.level);
    if (d !== null) parts.push(d === 0 ? 100 : d === 1 ? 80 : d === 2 ? 50 : 10);
  }
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** Location: work mode vs the profile's remote preference + city match. */
export function locationScore(signals, job, profile) {
  const loc = profile.locations || {};
  const pref = typeof loc.remote === 'string' ? loc.remote.toLowerCase() : null; // required|preferred|ok
  const mode = signals.workMode?.mode ?? null;
  const cities = Array.isArray(loc.cities) ? loc.cities.map((c) => String(c).toLowerCase()) : [];
  const postingLocation = String(job.location || '').toLowerCase();
  const cityHit = cities.find((c) => c && postingLocation.includes(c));

  let modeScore = null;
  if (mode && pref) {
    if (pref === 'required') modeScore = mode === 'remote' ? 100 : mode === 'hybrid' ? 50 : 10;
    else if (pref === 'preferred') modeScore = mode === 'remote' ? 100 : mode === 'hybrid' ? 70 : 20;
    else modeScore = mode === 'remote' ? 90 : mode === 'hybrid' ? 95 : 100; // remote-agnostic
  }
  if (cityHit && (modeScore === null || modeScore < 100)) modeScore = 100;
  if (modeScore === null && !cities.length && !mode) return null;
  if (modeScore === null) modeScore = cities.length ? 40 : NEUTRAL;
  return Math.round(modeScore);
}

/** Total comp (A5): base × level/stage multiplier vs comp.min_total.
 * Posted ranges are base-only; offers are scored on total. */
export function totalCompMultiplier(profile, level, stage) {
  const multipliers = profile.comp?.multipliers;
  if (!multipliers || typeof multipliers !== 'object') return 1; // no table → 1.0, comp scored as base
  const lvl = String(level || '').toLowerCase();
  const stg = String(stage || '').toLowerCase();
  for (const key of [stg ? `${lvl}@${stg}` : null, lvl, 'default']) {
    if (key && Number.isFinite(Number(multipliers[key]))) return Number(multipliers[key]);
  }
  return Number.isFinite(Number(multipliers.default)) ? Number(multipliers.default) : 1;
}

export function compScore(signals, profile, level, stage) {
  const salary = signals.salary; // {min,max,currency} | null
  const minTotal = Number(profile.comp?.min_total);
  if (!salary || !Number.isFinite(minTotal) || minTotal <= 0) return { pct: null, est: false, ratio: null };
  // A salary in another currency can't be compared without an exchange
  // rate: unknown (neutral), never a low score.
  if (profile.comp?.currency && salary.currency && profile.comp.currency !== salary.currency) {
    return { pct: null, est: false, ratio: null, currencyMismatch: `${salary.currency} vs ${profile.comp.currency}` };
  }
  const multiplier = totalCompMultiplier(profile, level, stage);
  const est = multiplier !== 1;
  const mid = (salary.min + salary.max) / 2;
  const total = mid * multiplier;
  const ratio = total / minTotal;
  let pct;
  if (ratio >= 1) pct = 100;
  else if (ratio >= 0.7) pct = 20 + ((ratio - 0.7) / 0.3) * 80;
  else pct = (ratio / 0.7) * 20;
  return { pct: Math.round(clamp(pct)), est, ratio };
}

// ── Knockouts (A4) ──────────────────────────────────────────────────────

export function detectKnockouts(signals, job, profile) {
  const kos = [];
  const db = profile.deal_breakers || {};
  const jd = signals.jdText || '';

  if (db.needs_sponsorship && /no sponsorship|cannot (?:sponsor|support) (?:work )?visas?|not (?:offering|provide) sponsorship|authorized to work without sponsorship|must be (?:a us |a u\.s\. )?citizen/i.test(jd)) {
    kos.push('sponsorship needed but not offered');
  }
  if (db.clearance === false && /security clearance|active (?:ts\/sci|secret|top secret)/i.test(jd)) {
    kos.push('security clearance required');
  }
  if (db.onsite_only && signals.workMode?.onsite_only) {
    kos.push('on-site only');
  }
  // No `languages` in the profile = unknown, not "speaks nothing".
  const requiredLangs = signals.requiredLanguages || [];
  const known = (profile.languages || []).map((l) => String(l).toLowerCase());
  const missingLangs = known.length > 0 ? requiredLangs.filter((l) => !known.includes(l)) : [];
  if (missingLangs.length > 0) {
    kos.push(`required language missing: ${missingLangs.join(', ')}`);
  }
  const jdLevel = signals.level?.level ?? null;
  if (jdLevel && profile.level) {
    const d = levelDistance(jdLevel, profile.level);
    if (d !== null && d > 2) kos.push(`level more than 2 steps away (${profile.level} vs ${jdLevel})`);
  }
  return kos;
}

// ── The scorer ──────────────────────────────────────────────────────────

export const KNOCKOUT_CAP = 40;

/**
 * Pure scoring kernel: checklist + signals + profile → fit, breakdown,
 * components. Same inputs → same outputs, always.
 */
export function computeScore(checklist, signals, profile) {
  const weights = profile.weights;
  const { pct: skillsPct, metCount, total } = skillsScore(checklist.requirements);
  const seniorityPct = seniorityScore(signals, profile);
  const domainPct = checklist.domain ? VERDICT_POINTS[checklist.domain.verdict] * 100 : null;
  const locationPct = locationScore(signals, signals.job || {}, profile);
  const comp = compScore(signals, profile, signals.level?.level, signals.stage);

  const components = {
    skills: { pct: skillsPct, weight: weights.skills },
    seniority: { pct: seniorityPct, weight: weights.seniority },
    domain: { pct: domainPct, weight: weights.domain },
    location: { pct: locationPct, weight: weights.location },
    comp: { pct: comp.pct, weight: weights.comp },
  };

  // The keyword pre-score cross-check (A6): a checklist far above the raw
  // keyword overlap smells like hallucinated "met" verdicts.
  const prescore = signals.prescore;
  const checklistSkills = skillsPct === null ? NEUTRAL : skillsPct;
  const recheck = prescore !== null && Math.abs(prescore - checklistSkills) > 25;

  let fit = 0;
  let wsum = 0;
  for (const c of Object.values(components)) {
    fit += (c.pct === null ? NEUTRAL : c.pct) * c.weight;
    wsum += c.weight;
  }
  fit = wsum > 0 ? Math.round(fit / wsum) : 0;

  const knockouts = detectKnockouts(signals, signals.job || {}, profile);
  const capped = knockouts.length > 0 && fit > KNOCKOUT_CAP;
  if (capped) fit = KNOCKOUT_CAP;

  const letters = { skills: 'S', seniority: 'Sn', domain: 'D', location: 'L', comp: 'C' };
  let breakdown = Object.entries(components)
    .map(([k, c]) => `${letters[k]}${c.pct === null ? '?' : Math.round(c.pct * c.weight / 100)}/${c.weight}`)
    .join(' ');
  if (knockouts.length > 0) breakdown += ` KO(${knockouts.length})`;
  if (comp.est) breakdown += ' est.';

  return {
    fit,
    breakdown,
    components,
    knockouts,
    prescore,
    recheck,
    capped,
    skillsCoverage: total > 0 ? { met: metCount, of: total } : null,
    compEstimate: comp.ratio !== null && comp.est ? { ratio: Math.round(comp.ratio * 100) / 100 } : null,
  };
}

/** Assemble the code signals for one job (JD text + row + profile). */
export function buildSignals(jdText, job, profile, { profileBody, stage } = {}) {
  const salary =
    (job.salary ? parseSalaryColumn(job.salary) : null)
    || extractSalary(jdText)
    || null;
  return {
    job: { id: job.id, company: job.company, title: job.title, location: job.location || '' },
    jdText,
    years: extractYears(jdText),
    level: extractLevel(job.title || '', jdText),
    workMode: extractWorkMode(job.location || '', jdText),
    salary,
    requiredLanguages: extractRequiredLanguages(jdText),
    prescore: keywordPreScore(jdText, profile, profileBody || ''),
    stage: stage || null,
  };
}

/** Replace the previous score's recheck/knockout notes instead of piling
 * them up on every re-score; everything else in notes is kept. */
export function scoreNotes(existing, fresh) {
  const kept = String(existing || '').split(' | ')
    .filter((part) => part && !/^(recheck|knockout):/.test(part.trim()));
  return [...kept, ...(fresh.length > 0 ? [fresh.join('; ')] : [])].join(' | ');
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function main(argv) {
  const [id, ...rest] = argv;
  if (!id) {
    console.error('Usage: node score.mjs <id> [--checklist-file <path|->]');
    process.exit(1);
  }
  let checklistFile = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--checklist-file') checklistFile = rest[++i];
    else { console.error(`unknown argument "${rest[i]}"`); process.exit(1); }
  }

  const root = workspaceRoot({ create: true });
  const job = findJob(root, id);
  if (!job) { console.error(`no job matching "${id}" in jobs.csv`); process.exit(1); }
  const { profile, body: profileBody, hasFrontmatter } = loadProfile(root);
  if (!hasFrontmatter) {
    console.error('⚠️  profile.md has no YAML front matter — every signal scores neutral. Run /jobpilot:setup to add it.');
  }

  let checklist;
  if (checklistFile) {
    const raw = checklistFile === '-' ? await readFile(0, 'utf8') : await readFile(checklistFile, 'utf8');
    checklist = JSON.parse(raw);
  } else {
    const existing = readEval(root, job.id);
    // Accept either a bare checklist ({requirements, domain}) as the skill
    // writes it, or a previously-scored eval file ({checklist: {...}}).
    checklist = existing?.checklist || (existing?.requirements ? existing : null);
  }
  if (!checklist) {
    console.error(`no checklist found — write one into evals/${job.id}.json (or pass --checklist-file). The match skill does this.`);
    process.exit(1);
  }

  const { clean, downgraded } = validateChecklist(checklist, profileBody, profile.skills);
  if (downgraded.length > 0) {
    for (const d of downgraded) console.error(`⬇️  downgraded to partial: "${d.text}" — ${d.reason}`);
  }

  const jdText = await fetchDescription(root, job);
  // Company stage for the total-comp multiplier (A5): optional `stage:` on the
  // companies.yml entry ("public" | "startup" | ...).
  let stage = null;
  try {
    const companies = yaml.load(await readFile(`${root}/companies.yml`, 'utf8')).companies || [];
    stage = companies.find((c) => String(c.name).toLowerCase() === String(job.company).toLowerCase())?.stage || null;
  } catch { /* stage stays null → multiplier falls back to level/default */ }
  const signals = buildSignals(jdText, job, profile, { profileBody, stage });
  const score = computeScore(clean, signals, profile);

  const prior = readEval(root, job.id) || {};
  const entry = {
    ...prior,
    id: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    checklist: clean,
    signals: { ...signals, jdText: undefined, jd_chars: jdText.length },
    score: {
      ...score,
      scored_at: new Date().toISOString(),
      weights_used: { ...profile.weights },
    },
  };
  // Keep a history trail when re-scoring an already-scored job.
  if (prior.score?.fit !== undefined && prior.score?.fit !== score.fit) {
    entry.history = [...(prior.history || []), { fit: prior.score.fit, breakdown: prior.score.breakdown, at: prior.score.scored_at }];
  }
  writeEval(root, job.id, entry);
  const notes = [];
  if (score.recheck) notes.push(`recheck: checklist score differs from keyword pre-score (${score.prescore})`);
  if (score.knockouts.length > 0) notes.push(`knockout: ${score.knockouts.join('; ')}`);
  updateJobs(root, job.id, {
    fit: String(score.fit),
    breakdown: score.breakdown,
    notes: scoreNotes(job.notes, notes),
  });

  console.log(JSON.stringify({
    id: job.id,
    fit: score.fit,
    breakdown: score.breakdown,
    knockouts: score.knockouts,
    prescore: score.prescore,
    recheck: score.recheck,
    skillsCoverage: score.skillsCoverage,
  }, null, 2));
  if (score.recheck) {
    console.error('🔁 recheck flagged: re-run the checklist once and score again.');
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
