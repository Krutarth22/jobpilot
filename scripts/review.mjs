#!/usr/bin/env node
// jobpilot review — the measurable recruiter view (C1, C2, C4).
//
//   node review.mjs <id> [--resume out/tailored.pdf|html]
//   node review.mjs ats <tailored.pdf> <tailored.html>   # ATS round-trip only
//
// Numbers first: must-have coverage from the eval checklist (no second AI
// pass), keyword coverage from the canonical skill vocabulary, a 30-second
// recruiter screen (code over profile.md + the tailored resume; the one
// judgment call — "is the domain recognizable" — is left to the skill's AI),
// and the ATS round-trip on the rendered PDF.

import { readFile } from 'node:fs/promises';
import {
  workspaceRoot, findJob, readEval,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { loadProfile } from './lib/profile.mjs';
import { extractSkills } from './lib/skills.mjs';
import { jdSkillList, extractLevel, levelDistance } from './lib/signals.mjs';
import { fetchDescription } from './jobs.mjs';
import { htmlToLines } from './check-resume.mjs';
import { extractText } from './parse-resume.mjs';

// ── C1: scorecard ───────────────────────────────────────────────────────

export function mustHaveCoverage(checklist) {
  const musts = (checklist?.requirements || []).filter((r) => (r.type || 'must') === 'must' && (r.category || 'skills') === 'skills');
  if (musts.length === 0) return { met: 0, of: 0, pct: null };
  const met = musts.filter((r) => r.verdict === 'met').length;
  const partial = musts.filter((r) => r.verdict === 'partial').length;
  return { met, of: musts.length, pct: Math.round(((met + 0.5 * partial) / musts.length) * 100) };
}

export function keywordCoverage(jdText, profile, profileBody) {
  const jdSkills = jdSkillList(jdText);
  if (jdSkills.length === 0) return { pct: null, missing: [] };
  const known = new Set([...(profile.skills || []).map((s) => s.toLowerCase()), ...[...extractSkills(profileBody)].map((s) => s.toLowerCase())]);
  const missing = jdSkills.filter((s) => !known.has(s.toLowerCase()));
  return { pct: Math.round(((jdSkills.length - missing.length) / jdSkills.length) * 100), missing };
}

// ── C2: 30-second screen ────────────────────────────────────────────────

const MAX_AGE_YEARS = 3;
const GAP_MONTHS = 6;

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function parseYM(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{1,2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}

/**
 * Code-checkable screen items. `recognizable` is deliberately NOT judged
 * here — the review skill's AI does that one (it needs market knowledge).
 */
export function thirtySecondScreen({ profile, profileBody, tailoredText = '', now = new Date() }) {
  const checks = [];
  const experience = Array.isArray(profile.experience) ? profile.experience : [];
  const recent = experience[0];

  // 1. Most recent title matches the target level (±1 step on the dual scale).
  if (recent?.title && profile.level) {
    const actual = extractLevel(recent.title, '')?.level;
    const d = actual ? levelDistance(actual, profile.level) : null;
    checks.push(d === null
      ? { check: 'recent title matches target level', verdict: 'unknown', detail: `can't level "${recent.title}"` }
      : d <= 1
        ? { check: 'recent title matches target level', verdict: 'pass', detail: `${recent.title} vs level ${profile.level}` }
        : { check: 'recent title matches target level', verdict: 'fail', detail: `${recent.title} is ${d} steps from ${profile.level}` });
  } else {
    checks.push({ check: 'recent title matches target level', verdict: 'unknown', detail: 'needs experience[0].title and level in profile front matter' });
  }

  // 2. Relevant experience is recent (last role ended within 3 years).
  if (recent) {
    const end = recent.end === 'present' || !recent.end ? now : parseYM(recent.end);
    if (end) {
      const ageYears = monthsBetween(end, now) / 12;
      checks.push(ageYears <= MAX_AGE_YEARS
        ? { check: 'relevant experience is recent', verdict: 'pass', detail: `last role ended ${recent.end || 'present'}` }
        : { check: 'relevant experience is recent', verdict: 'fail', detail: `last role ended ${recent.end} (${ageYears.toFixed(1)}y ago)` });
    } else {
      checks.push({ check: 'relevant experience is recent', verdict: 'unknown', detail: `can't parse end "${recent.end}"` });
    }
  } else {
    checks.push({ check: 'relevant experience is recent', verdict: 'unknown', detail: 'needs experience[] in profile front matter' });
  }

  // 3. Top 3 bullets carry numbers.
  const bullets = (tailoredText ? htmlToLines(tailoredText) : profileBody.split('\n').map((l) => l.trim()))
    .filter((l) => /^[•\-*]\s+/.test(l));
  if (bullets.length >= 3) {
    const withNumbers = bullets.slice(0, 3).filter((b) => /\d/.test(b)).length;
    checks.push({
      check: 'top 3 bullets carry numbers',
      verdict: withNumbers >= 2 ? 'pass' : withNumbers === 1 ? 'borderline' : 'fail',
      detail: `${withNumbers}/3`,
    });
  } else {
    checks.push({ check: 'top 3 bullets carry numbers', verdict: 'unknown', detail: `only ${bullets.length} bullet(s) found` });
  }

  // 4. Domain recognizable → AI (see review skill).
  checks.push({ check: 'company or domain recognizable for this role', verdict: 'ai', detail: 'the review skill judges this' });

  // 5. Unexplained employment gaps > 6 months between consecutive roles.
  if (experience.length >= 2) {
    const sorted = experience
      .map((e) => ({ ...e, s: parseYM(e.start), e: e.end === 'present' || !e.end ? now : parseYM(e.end) }))
      .filter((e) => e.s)
      .sort((a, b) => b.s - a.s);
    let gap = null;
    for (let i = 0; i < sorted.length - 1; i++) {
      const newer = sorted[i].s;
      const olderEnd = sorted[i + 1].e;
      if (olderEnd && monthsBetween(olderEnd, newer) > GAP_MONTHS) { gap = `${sorted[i + 1].end} → ${sorted[i].start}`; break; }
    }
    checks.push(gap
      ? { check: 'no unexplained employment gaps', verdict: 'fail', detail: `gap: ${gap}` }
      : { check: 'no unexplained employment gaps', verdict: 'pass', detail: 'none > 6 months' });
  } else {
    checks.push({ check: 'no unexplained employment gaps', verdict: 'unknown', detail: 'needs ≥2 experience[] entries' });
  }

  // 6. Length appropriate (resume word count when available, else profile).
  const text = tailoredText ? htmlToLines(tailoredText).join(' ') : profileBody;
  const words = text.split(/\s+/).filter(Boolean).length;
  const source = tailoredText ? 'tailored resume' : 'profile (no resume given)';
  if (tailoredText) {
    checks.push(words >= 250 && words <= 850
      ? { check: 'length appropriate', verdict: 'pass', detail: `${words} words (${source})` }
      : { check: 'length appropriate', verdict: 'borderline', detail: `${words} words (${source}; 250–850 is the 1–2 page band)` });
  } else {
    checks.push({ check: 'length appropriate', verdict: 'unknown', detail: 'pass --resume to check the tailored resume' });
  }

  const hardFail = checks.some((c) => c.verdict === 'fail');
  const borderline = checks.some((c) => c.verdict === 'borderline');
  const verdict = hardFail ? 'fail' : borderline ? 'borderline' : 'pass';
  const reasons = checks
    .filter((c) => c.verdict === 'fail' || c.verdict === 'borderline')
    .slice(0, 3)
    .map((c) => `${c.check}: ${c.detail}`);
  return { verdict, reasons, checks };
}

// ── C4: ATS round-trip ──────────────────────────────────────────────────

function headings(html) {
  const out = [];
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

export async function atsRoundTrip(pdfPath, htmlPath) {
  const html = await readFile(htmlPath, 'utf8');
  const pdfText = await extractText(pdfPath);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const pdfNorm = norm(pdfText);

  const violations = [];
  // 1. Every section heading survives extraction.
  const hs = headings(html);
  for (const h of hs) {
    if (!pdfNorm.includes(norm(h))) violations.push(`heading "${h}" lost in PDF extraction`);
  }
  // 2. Reading order holds (no columns tearing the flow apart).
  const positions = hs.map((h) => pdfNorm.indexOf(norm(h))).filter((p) => p >= 0);
  const sorted = [...positions].sort((a, b) => a - b);
  if (positions.length >= 2 && positions.some((p, i) => p !== sorted[i])) {
    violations.push('reading order broken: headings appear in a different order in the extracted PDF');
  }
  // 3. Every skill in the HTML survives extraction.
  const htmlSkills = extractSkills(html);
  const pdfSkills = extractSkills(pdfText);
  for (const s of htmlSkills) {
    if (!pdfSkills.has(s)) violations.push(`skill "${s}" garbled or lost in PDF extraction`);
  }
  return { ok: violations.length === 0, violations, headingsChecked: hs.length, pdfWords: pdfText.split(/\s+/).length };
}

/** Must-have keywords of a job's checklist that must survive extraction. */
export function mustHaveKeywords(checklist) {
  return [...new Set((checklist?.requirements || [])
    .filter((r) => r.verdict !== 'missing')
    .flatMap((r) => [...extractSkills(r.text || '')]))];
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function main(argv) {
  const [cmd, ...rest] = argv;
  const root = workspaceRoot();

  if (cmd === 'ats') {
    const [pdfPath, htmlPath] = rest;
    if (!pdfPath || !htmlPath) { console.error('Usage: review.mjs ats <pdf> <html>'); process.exit(1); }
    const result = await atsRoundTrip(pdfPath, htmlPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const id = cmd;
  if (!id) {
    console.error('Usage: node review.mjs <id> [--resume out/tailored.pdf] | ats <pdf> <html>');
    process.exit(1);
  }
  const job = findJob(root, id);
  if (!job) { console.error(`no job matching "${id}" in jobs.csv`); process.exit(1); }
  const { profile, body: profileBody } = loadProfile(root);
  const evalFile = readEval(root, job.id);
  const checklist = evalFile?.checklist;
  const resumeArg = rest.indexOf('--resume') !== -1 ? rest[rest.indexOf('--resume') + 1] : null;

  let jdText = '';
  try { jdText = await fetchDescription(root, job); } catch { /* description optional for the scorecard */ }

  let tailoredText = '';
  if (resumeArg) {
    tailoredText = /\.pdf$/i.test(resumeArg) ? await extractText(resumeArg) : await readFile(resumeArg, 'utf8');
  }

  const mustHave = mustHaveCoverage(checklist);
  const keywords = keywordCoverage(jdText, profile, profileBody);
  const screen = thirtySecondScreen({ profile, profileBody, tailoredText });
  const ats = resumeArg && /\.pdf$/i.test(resumeArg) ? await atsRoundTrip(resumeArg, resumeArg.replace(/\.pdf$/i, '.html')) : null;

  const scorecard = {
    id: job.id,
    company: job.company,
    title: job.title,
    mustHave,
    keywordCoverage: keywords,
    screen,
    ats,
    note: 'must-have % comes from the match checklist; screen checks are code over profile.md + resume; "recognizable" and prose verdicts are the review skill\'s AI',
  };
  console.log(JSON.stringify(scorecard, null, 2));
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
