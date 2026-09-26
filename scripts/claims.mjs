#!/usr/bin/env node
// jobpilot claims — the candidate-side claim self-check, ported from the
// resume-claim-verification skill's validate_report.py / generate_report.py
// (https://github.com/Krutarth22/resume-claim-verification, same author).
//
// That skill is reviewer-side: a recruiter checks a candidate's claims
// against public evidence and writes a neutral dossier. Here the "reviewer"
// is the user checking their OWN resume before a recruiter does — same five
// neutral labels, same prohibited-field/prohibited-conclusion guard, same
// "unverified does not mean false" framing. `candidate_label` is always
// forced to "You": this is never a report about someone else.
//
//   node claims.mjs validate <report.json>
//   node claims.mjs save <draft.json>      validate, stamp profile_sha256, write <workspace>/claims.json
//   node claims.mjs render <report.json> <out.pdf>
//   node claims.mjs for-job <id>
//
// See skills/review/references/claim-rubric.md for the assessment rules.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMainModule } from './lib/main.mjs';
import { workspaceRoot, profilePath, readEval, findJob } from './lib/workspace.mjs';
import { extractSkills } from './lib/skills.mjs';
import { renderHtmlToPdf } from './render-resume.mjs';

// ── Schema constants (mirrors validate_report.py exactly) ───────────────

export const ASSESSMENTS = new Set([
  'Supported',
  'Plausible but unverified',
  'Needs clarification',
  'Material inconsistency',
  'Not assessable',
]);
export const CONFIDENCE_LEVELS = new Set(['High', 'Medium', 'Low']);
export const OVERALL_CONCLUSIONS = new Set([
  'No material issues found',
  'Clarification recommended',
  'Human review recommended',
  'Insufficient evidence',
]);

// Self-check adds `profile_sha256` (optional): sha256 of profile.md at build
// time, used by `for-job` to detect a stale claims.json after profile.md changes.
const TOP_LEVEL_FIELDS = new Set([
  'report_version', 'candidate_label', 'review_date', 'reviewed_inputs',
  'overall_conclusion', 'summary', 'claims', 'sources', 'limitations',
  'profile_sha256',
]);
const CLAIM_FIELDS = new Set([
  'id', 'category', 'claim', 'assessment', 'confidence', 'observations',
  'inference', 'evidence', 'alternative_explanations', 'follow_up_questions', 'next_step',
]);
const EVIDENCE_FIELDS = new Set(['source', 'finding', 'url']);
const SOURCE_FIELDS = new Set(['label', 'url', 'accessed']);

const PROHIBITED_KEY_PARTS = [
  'fake', 'fraud', 'score', 'hire', 'ranking',
  'race', 'ethnicity', 'religion', 'gender', 'sex', 'disability',
  'pregnancy', 'national_origin', 'marital_status', 'sexual_orientation',
];
const PROHIBITED_CONCLUSION_PATTERNS = [
  /\b(?:resume|candidate|experience|project)\s+is\s+fake\b/i,
  /\b(?:candidate|person|applicant)\s+(?:lied|is\s+(?:a\s+)?liar)\b/i,
  /\bcommitted\s+fraud\b/i,
  /\b(?:do\s+not|don't)\s+hire\b/i,
  /\b(?:hire|reject)\s+(?:the\s+)?candidate\b/i,
];

export const STANDARD_LIMITATIONS = [
  'Finding nothing online does not mean the claim is false.',
  'Private or confidential work may be impossible to confirm from public sources.',
  'A matching name or profile may belong to someone else.',
  'This report does not prove that anyone lied or committed fraud. A person must make every hiring decision.',
];

// Plain, reader-facing labels — never show the internal assessment value in
// a report a candidate (or a recruiter) will actually read.
export const PLAIN_LABELS = {
  'Supported': 'Matches the evidence',
  'Plausible but unverified': 'Not enough evidence',
  'Needs clarification': 'Needs an explanation',
  'Material inconsistency': "Important details don't match",
  'Not assessable': 'Unable to check',
};

export class ClaimValidationError extends Error {}

function requireObject(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClaimValidationError(`${path} must be an object`);
  }
  return value;
}

function rejectUnknownFields(obj, allowed, path) {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k)).sort();
  if (unknown.length > 0) throw new ClaimValidationError(`${path} contains unknown fields: ${JSON.stringify(unknown)}`);
}

function rejectProhibitedKeys(value, path = 'report') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectProhibitedKeys(item, `${path}[${i}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/-/g, '_');
    if (PROHIBITED_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw new ClaimValidationError(`${path}.${key} is a prohibited decision or sensitive field`);
    }
    rejectProhibitedKeys(item, `${path}.${key}`);
  }
}

function requiredText(obj, key, path) {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw new ClaimValidationError(`${path}.${key} must be a non-empty string`);
  return value.trim();
}

function stringList(obj, key, path, { allowEmpty = true } = {}) {
  const value = obj[key];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new ClaimValidationError(`${path}.${key} must be a${allowEmpty ? '' : ' non-empty'} list of strings`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || !item.trim()) throw new ClaimValidationError(`${path}.${key}[${i}] must be a non-empty string`);
    return item.trim();
  });
}

function checkProhibitedConclusion(text, path) {
  for (const pattern of PROHIBITED_CONCLUSION_PATTERNS) {
    if (pattern.test(text)) throw new ClaimValidationError(`${path} contains a prohibited hiring or fraud determination`);
  }
}

function validateEvidence(raw, path) {
  const item = requireObject(raw, path);
  rejectUnknownFields(item, EVIDENCE_FIELDS, path);
  const result = { source: requiredText(item, 'source', path), finding: requiredText(item, 'finding', path) };
  if ('url' in item) result.url = requiredText(item, 'url', path);
  return result;
}

function validateSource(raw, path) {
  const item = requireObject(raw, path);
  rejectUnknownFields(item, SOURCE_FIELDS, path);
  const result = { label: requiredText(item, 'label', path) };
  for (const key of ['url', 'accessed']) if (key in item) result[key] = requiredText(item, key, path);
  return result;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalize a claims report. Throws ClaimValidationError with a
 * descriptive message on any violation. Mirrors validate_report.py's rules
 * exactly, plus the self-check twist: candidate_label is forced to "You"
 * and an optional profile_sha256 field is allowed through.
 */
export function validateClaims(raw) {
  const report = requireObject(raw, 'report');
  rejectProhibitedKeys(report);
  rejectUnknownFields(report, TOP_LEVEL_FIELDS, 'report');

  const result = {
    report_version: requiredText(report, 'report_version', 'report'),
    candidate_label: requiredText(report, 'candidate_label', 'report'),
    review_date: requiredText(report, 'review_date', 'report'),
    reviewed_inputs: stringList(report, 'reviewed_inputs', 'report', { allowEmpty: false }),
    overall_conclusion: requiredText(report, 'overall_conclusion', 'report'),
    summary: requiredText(report, 'summary', 'report'),
  };
  if (result.report_version !== '1.0') throw new ClaimValidationError("report.report_version must be '1.0'");
  if (!ISO_DATE_RE.test(result.review_date) || Number.isNaN(Date.parse(result.review_date))) {
    throw new ClaimValidationError('report.review_date must use YYYY-MM-DD');
  }
  if (!OVERALL_CONCLUSIONS.has(result.overall_conclusion)) {
    throw new ClaimValidationError(`report.overall_conclusion must be one of ${JSON.stringify([...OVERALL_CONCLUSIONS].sort())}`);
  }
  checkProhibitedConclusion(result.summary, 'report.summary');
  // The self-check is always about the user — never let a stray label
  // (or someone else's name) leak into a document that will be shared.
  result.candidate_label = 'You';
  if ('profile_sha256' in report) result.profile_sha256 = requiredText(report, 'profile_sha256', 'report');

  const rawClaims = report.claims;
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) throw new ClaimValidationError('report.claims must be a non-empty list');
  const seenIds = new Set();
  result.claims = rawClaims.map((rawClaim, index) => {
    const path = `report.claims[${index}]`;
    const claim = requireObject(rawClaim, path);
    rejectUnknownFields(claim, CLAIM_FIELDS, path);
    const normalized = {
      id: requiredText(claim, 'id', path),
      category: requiredText(claim, 'category', path),
      claim: requiredText(claim, 'claim', path),
      assessment: requiredText(claim, 'assessment', path),
      confidence: requiredText(claim, 'confidence', path),
      observations: stringList(claim, 'observations', path),
      inference: requiredText(claim, 'inference', path),
      alternative_explanations: stringList(claim, 'alternative_explanations', path),
      follow_up_questions: stringList(claim, 'follow_up_questions', path),
      next_step: requiredText(claim, 'next_step', path),
    };
    if (seenIds.has(normalized.id)) throw new ClaimValidationError(`duplicate claim id: ${normalized.id}`);
    seenIds.add(normalized.id);
    if (!ASSESSMENTS.has(normalized.assessment)) throw new ClaimValidationError(`${path}.assessment must be one of ${JSON.stringify([...ASSESSMENTS].sort())}`);
    if (!CONFIDENCE_LEVELS.has(normalized.confidence)) throw new ClaimValidationError(`${path}.confidence must be one of ${JSON.stringify([...CONFIDENCE_LEVELS].sort())}`);
    checkProhibitedConclusion(normalized.inference, `${path}.inference`);
    const rawEvidence = claim.evidence;
    if (!Array.isArray(rawEvidence)) throw new ClaimValidationError(`${path}.evidence must be a list`);
    normalized.evidence = rawEvidence.map((item, i) => validateEvidence(item, `${path}.evidence[${i}]`));
    if (normalized.assessment === 'Supported' && normalized.evidence.length === 0) {
      throw new ClaimValidationError(`${path}: Supported claims require evidence`);
    }
    if (normalized.assessment === 'Needs clarification' || normalized.assessment === 'Material inconsistency') {
      if (normalized.follow_up_questions.length === 0) throw new ClaimValidationError(`${path}: flagged claims require follow-up questions`);
      if (normalized.alternative_explanations.length === 0) throw new ClaimValidationError(`${path}: flagged claims require alternative explanations`);
    }
    return normalized;
  });

  const rawSources = report.sources;
  if (!Array.isArray(rawSources)) throw new ClaimValidationError('report.sources must be a list');
  result.sources = rawSources.map((item, i) => validateSource(item, `report.sources[${i}]`));

  result.limitations = stringList(report, 'limitations', 'report');
  for (const limitation of STANDARD_LIMITATIONS) {
    if (!result.limitations.includes(limitation)) result.limitations.push(limitation);
  }

  const counts = {};
  for (const assessment of ASSESSMENTS) counts[assessment] = 0;
  for (const claim of result.claims) counts[claim.assessment] += 1;
  const ordered = [...ASSESSMENTS].sort();
  result.counts = Object.fromEntries(ordered.map((a) => [a, counts[a]]));

  // Largest-remainder rounding: whole percentages that sum to exactly 100.
  const total = result.claims.length;
  const rawPct = Object.fromEntries(ordered.map((a) => [a, (100 * counts[a]) / total]));
  const percentages = Object.fromEntries(ordered.map((a) => [a, Math.floor(rawPct[a])]));
  let remaining = 100 - ordered.reduce((sum, a) => sum + percentages[a], 0);
  const remainder = [...ordered].sort((a, b) => {
    const diff = (rawPct[b] - percentages[b]) - (rawPct[a] - percentages[a]);
    return diff !== 0 ? diff : (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const assessment of remainder) {
    if (remaining <= 0) break;
    percentages[assessment] += 1;
    remaining -= 1;
  }
  result.percentages = percentages;
  return result;
}

/** sha256 of profile.md's current content — the staleness key for for-job. */
export function hashProfile(root) {
  const p = profilePath(root);
  if (!existsSync(p)) return null;
  return createHash('sha256').update(readFileSync(p, 'utf8')).digest('hex');
}

export const claimsPath = (root) => join(root, 'claims.json');

// ── HTML report (render command) ─────────────────────────────────────────

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STATUS_CLASS = {
  'Supported': 'ok', 'Plausible but unverified': 'unknown', 'Needs clarification': 'flag',
  'Material inconsistency': 'bad', 'Not assessable': 'unknown',
};

function buildHtml(report) {
  const order = ['Supported', 'Plausible but unverified', 'Needs clarification', 'Material inconsistency', 'Not assessable'];
  const total = report.claims.length;
  const profileRows = order.map((a) => `<tr class="${STATUS_CLASS[a]}"><td>${esc(PLAIN_LABELS[a])}</td><td>${report.percentages[a]}% (${report.counts[a]}/${total})</td></tr>`).join('\n');
  const claimBlocks = report.claims.map((c) => `
    <section class="claim ${STATUS_CLASS[c.assessment]}">
      <h3>${esc(c.id)} — ${esc(c.category)}</h3>
      <p><b>Claim:</b> ${esc(c.claim)}</p>
      <p><b>Result:</b> ${esc(PLAIN_LABELS[c.assessment])} (${esc(c.confidence)} confidence)</p>
      <p><b>What was checked / found:</b></p>
      <ul>${(c.observations.length ? c.observations : ['No reliable information was available to check this claim.']).map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
      ${c.evidence.length ? `<ul>${c.evidence.map((e) => `<li>${esc(e.source)}: ${esc(e.finding)}${e.url ? ` (${esc(e.url)})` : ''}</li>`).join('')}</ul>` : ''}
      <p><b>What this suggests:</b> ${esc(c.inference)}</p>
      <p><b>Next step:</b> ${esc(c.next_step)}</p>
      ${c.alternative_explanations.length ? `<p><b>Other possible explanations</b></p><ul>${c.alternative_explanations.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      ${c.follow_up_questions.length ? `<p><b>Follow-up questions</b></p><ol>${c.follow_up_questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
    </section>`).join('\n');
  const sources = report.sources.length
    ? `<ol>${report.sources.map((s) => `<li>${esc(s.label)}${s.url ? ` — ${esc(s.url)}` : ''}${s.accessed ? ` (accessed ${esc(s.accessed)})` : ''}</li>`).join('')}</ol>`
    : '<p>No external sources were used.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Resume Claim Self-Check</title><style>
    body { font-family: Helvetica, Arial, sans-serif; color: #1f2933; margin: 0.6in; font-size: 10.5pt; line-height: 1.4; }
    h1 { color: #16324f; font-size: 20pt; margin-bottom: 4px; }
    h2 { color: #16324f; font-size: 14pt; margin-top: 22px; border-bottom: 1px solid #d7dee5; padding-bottom: 4px; }
    h3 { color: #246b9e; font-size: 11.5pt; margin-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; }
    td { border: 1px solid #d7dee5; padding: 6px 8px; font-size: 9.5pt; }
    .callout { background: #fff8e6; border: 1px solid #d9a521; padding: 10px 14px; margin: 10px 0; }
    .claim { border-top: 1px solid #d7dee5; padding-top: 10px; margin-top: 10px; page-break-inside: avoid; }
    .claim.ok td, tr.ok td:first-child { border-left: 4px solid #2e8b57; }
    .claim.flag td, tr.flag td:first-child { border-left: 4px solid #d9a521; }
    .claim.bad td, tr.bad td:first-child { border-left: 4px solid #c0392b; }
    .claim.unknown td, tr.unknown td:first-child { border-left: 4px solid #888; }
    footer { margin-top: 24px; font-size: 8.5pt; color: #40566b; }
  </style></head><body>
    <h1>Resume Claim Self-Check</h1>
    <p><b>Candidate:</b> ${esc(report.candidate_label)}<br>
       <b>Review date:</b> ${esc(report.review_date)}<br>
       <b>Inputs reviewed:</b> ${esc(report.reviewed_inputs.join(', '))}</p>
    <div class="callout"><b>${esc(report.overall_conclusion)}</b></div>
    <h2>Summary</h2>
    <p>${esc(report.summary)}</p>
    <h2>Results at a glance</h2>
    <table>${profileRows}</table>
    <div class="callout">"Not enough evidence" does not mean a claim is false — it means the check did not find enough independent proof. Only "Important details don't match" means the evidence directly disagrees with a claim. These percentages are not a fake-resume score.</div>
    <h2>Claim-by-claim review</h2>
    ${claimBlocks}
    <h2>Sources</h2>
    ${sources}
    <h2>What this report cannot tell you</h2>
    <ul>${report.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <footer>Generated by jobpilot's claim self-check (ported from resume-claim-verification). This is not a hiring recommendation.</footer>
  </body></html>`;
}

// ── for-job: which claims are relevant to this posting ───────────────────

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'you', 'are', 'was', 'were', 'been', 'has', 'had',
  'experience', 'years', 'year', 'work', 'working', 'team', 'teams', 'strong', 'ability', 'across', 'including']);

function significantWords(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9+.#-]{3,}/g)?.filter((w) => !STOPWORDS.has(w)) || []);
}

/**
 * Which claims touch a job's must-haves: skill overlap first (canonical
 * skill vocabulary), then plain word overlap against the requirement texts.
 * Claims flagged "Needs clarification" or "Material inconsistency" use a
 * lower bar — a recruiter is more likely to probe those, so a self-check
 * should surface them even on a weaker match.
 */
export function claimsForJob(claims, checklist) {
  const all = Array.isArray(checklist?.requirements) ? checklist.requirements : [];
  // Must-haves are what a recruiter screens on; fall back to everything only
  // when the checklist doesn't mark types.
  const must = all.filter((r) => r.type === 'must');
  const requirements = must.length > 0 ? must : all;
  const requirementText = requirements.map((r) => r.text || '').join(' ');
  const mustHaveSkills = new Set([...extractSkills(requirementText)].map((s) => s.toLowerCase()));
  const requirementWords = significantWords(requirementText);

  return claims.filter((claim) => {
    const claimSkills = extractSkills(`${claim.claim} ${claim.category}`);
    const skillHit = [...claimSkills].some((s) => mustHaveSkills.has(s.toLowerCase()));
    if (skillHit) return true;
    const claimWords = significantWords(`${claim.claim} ${claim.category}`);
    const overlap = [...claimWords].filter((w) => requirementWords.has(w)).length;
    const flagged = claim.assessment === 'Needs clarification' || claim.assessment === 'Material inconsistency';
    return overlap >= (flagged ? 1 : 2);
  });
}

// ── CLI ───────────────────────────────────────────────────────────────────

async function cmdValidate(rest) {
  const [file] = rest;
  if (!file) { console.error('Usage: node claims.mjs validate <report.json>'); process.exit(1); }
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const report = validateClaims(raw);
  console.log(JSON.stringify(report, null, 2));
}

async function cmdSave(rest) {
  const [file] = rest;
  if (!file) { console.error('Usage: node claims.mjs save <draft.json>'); process.exit(1); }
  const root = workspaceRoot();
  const raw = JSON.parse(await readFile(file, 'utf8'));
  // Stamp before validating so the stored file is exactly what validated.
  // counts/percentages are never stored: they're re-derived on every load.
  const stamped = { ...raw, profile_sha256: hashProfile(root) };
  delete stamped.counts;
  delete stamped.percentages;
  const report = validateClaims(stamped);
  await writeFile(claimsPath(root), `${JSON.stringify(stamped, null, 2)}\n`);
  const flagged = report.claims.filter((c) => c.assessment === 'Needs clarification' || c.assessment === 'Material inconsistency').length;
  console.log(`✅ saved ${claimsPath(root)} — ${report.claims.length} claims, ${flagged} flagged`);
}

async function cmdRender(rest) {
  const [inputPath, outputPath] = rest;
  if (!inputPath || !outputPath) { console.error('Usage: node claims.mjs render <report.json> <out.pdf>'); process.exit(1); }
  const raw = JSON.parse(await readFile(inputPath, 'utf8'));
  const report = validateClaims(raw);
  const { size } = await renderHtmlToPdf(buildHtml(report), outputPath);
  console.log(`✅ PDF generated: ${outputPath} (${(size / 1024).toFixed(1)} KB)`);
}

async function cmdForJob(rest) {
  const [id] = rest;
  if (!id) { console.error('Usage: node claims.mjs for-job <id>'); process.exit(1); }
  const root = workspaceRoot();
  const path = claimsPath(root);
  if (!existsSync(path)) {
    console.error('claims.json not found — run the claim self-check (see skills/review/SKILL.md) first.');
    process.exit(1);
  }
  const report = validateClaims(JSON.parse(await readFile(path, 'utf8')));
  const currentHash = hashProfile(root);
  // No stamp means we can't tell which profile it was built from — treat as stale.
  if (currentHash && report.profile_sha256 !== currentHash) {
    console.error('claims.json is stale — profile.md changed since the last self-check (or it was never stamped). Rebuild it and save with `claims.mjs save`.');
    process.exit(2);
  }
  const job = findJob(root, id);
  if (!job) { console.error(`no job matching "${id}" in jobs.csv`); process.exit(1); }
  const evalFile = readEval(root, job.id);
  const relevant = claimsForJob(report.claims, evalFile?.checklist);
  console.log(JSON.stringify({
    id: job.id, company: job.company, title: job.title,
    claims: relevant.map((c) => ({ ...c, plainLabel: PLAIN_LABELS[c.assessment] })),
  }, null, 2));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'validate') return cmdValidate(rest);
  if (cmd === 'save') return cmdSave(rest);
  if (cmd === 'render') return cmdRender(rest);
  if (cmd === 'for-job') return cmdForJob(rest);
  console.error('Usage: node claims.mjs <validate|save|render|for-job> ...');
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
