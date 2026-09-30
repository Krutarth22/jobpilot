// ATS-readiness + job-match score for one resume file against one job,
// 0–100. Pure code, no AI: the same file, job and checklist always give the
// same score. No ATS publishes a match number, so this is our own audit of
// the two things that decide whether a resume gets seen: does it credibly
// show what the job asks, and can software recover its structure.
//
//   Requirements  40  each requirement the `match` checklist lists, weighted
//                     must 1.0 / nice 0.45, credited by verdict x how well the
//                     resume shows it (proof in a bullet beats a skills list)
//   Skills        25  must-have terms 15 · nice terms 5 · JD vocabulary 5,
//                     each term worth its best evidence, older tools worth less
//   Experience    15  title 5 · seniority 3 · relevant years 4 · recency 3
//   Parseability  15  text 4 · sections 3 · roles recovered 3 · contact 2 ·
//                     reading order 2 · clean characters 1
//   Hygiene        5  file type · dates · contact · length · anomalies
//
// Ceilings: each must-have the checklist marks `missing` (the profile can't
// back it) caps the score, however good the file is: 79 / 69 / 59.
// Without a checklist the Requirements part is left out and the score says so.

import { extname, basename } from 'node:path';
import { extractTerms, canonicalize, PRACTICE_TERMS } from './skills.mjs';
import { jdTerms, extractYears, extractLevel, levelDistance } from './signals.mjs';

const TERM_CAP = 20; // a 40-term JD can't make every term worth nothing
const DEFAULT_CAPS = [79, 69, 59];
const WEIGHT = { must: 1, nice: 0.45 };
const VERDICT = { met: 1, partial: 0.5, missing: 0 };
const NOT_SHOWN = 0.25; // the profile backs it but the resume text doesn't visibly show it
const IMPACT = ['critical', 'high', 'medium', 'format'];

const HEADINGS = {
  summary: /^\s*(?:professional |executive |career )?(?:summary|profile|objective|about(?: me)?)\s*:?\s*$/i,
  experience: /^\s*(?:work |professional |relevant )?(?:experience|employment(?: history)?|work history)\s*:?\s*$/i,
  education: /^\s*education(?: (?:and|&) (?:training|certifications?))?\s*:?\s*$/i,
  skills: /^\s*(?:technical |core |key )?(?:skills|competencies|technologies)(?: (?:and|&) \w+)?\s*:?\s*$/i,
};
const STANDARD = ['experience', 'education', 'skills'];
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\d\s().-]{8,}\d)/;
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const RANGE_SRC = `(?:(${MONTHS})\\s+)?(?:\\d{1,2}/)?((?:19|20)\\d{2})\\s*(?:[-–—]|to)\\s*(?:(?:(${MONTHS})\\s+)?(?:\\d{1,2}/)?((?:19|20)\\d{2})|(present|current|now))`;
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TITLE_STOP = new Set(['and', 'the', 'for', 'of', 'with', 'sr', 'jr', 'senior', 'junior', 'staff', 'principal', 'lead', 'ii', 'iii', 'iv']);
const BULLET_MARK = /^\s*[•·\-–*▪◦]\s?/;
const DEGREE_LEVEL = [
  ['phd', /\b(?:ph\.?d\.?|doctorate|doctor of)\b/i],
  ['master', /\b(?:master'?s?|m\.?s\.?c?\.?|mba|m\.?eng)\b/i],
  ['bachelor', /\b(?:bachelor'?s?|b\.?s\.?c?\.?|b\.?a\.?|b\.?eng|b\.?tech)\b/i],
];
const LEVEL_RANK = { bachelor: 1, master: 2, phd: 3 };
// Fundamentals stay credited however long ago; recency only trims tools and platforms.
const FUNDAMENTALS = new Set(['python', 'sql', 'java', 'javascript', 'c++', 'c', 'go', 'git', 'linux', 'bash', 'html', 'css', 'r']);
const PRACTICE_NAMES = new Set(PRACTICE_TERMS.map(([n]) => n.toLowerCase()));

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

/** Core words of a job title, without the team suffix or seniority words. */
export function titleWords(title) {
  const role = String(title || '').split(/\s[-–—|]\s|\(/)[0];
  return role.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 2 && !TITLE_STOP.has(w));
}

// ── Reading the resume text ─────────────────────────────────────────────

function dateOf(month, year, end) {
  const m = month ? MONTH_INDEX[month.slice(0, 3).toLowerCase()] : (end ? 11 : 0);
  return new Date(Number(year), m ?? 0, 1);
}

function parseRange(line) {
  const m = line.match(new RegExp(RANGE_SRC, 'i'));
  if (!m) return null;
  const start = dateOf(m[1], m[2], false);
  const ongoing = Boolean(m[5]);
  return { start, end: ongoing ? null : dateOf(m[3], m[4], true), ongoing };
}

/** Sections, and one record per dated role: header (title/company lines) and body. */
export function readResume(text = '') {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections = { summary: [], experience: [], education: [], skills: [], other: [] };
  const found = [];
  let current = 'other';
  lines.forEach((line, i) => {
    const name = Object.keys(HEADINGS).find((h) => HEADINGS[h].test(line));
    if (name) { current = name; found.push(name); return; }
    sections[current].push({ line, i });
  });
  const region = sections.experience.length ? sections.experience
    : [...sections.summary, ...sections.other, ...sections.skills].filter((l) => !sections.education.includes(l));
  const dated = region.map((l, k) => ({ ...l, k, range: parseRange(l.line) })).filter((l) => l.range);
  // A role's title and company sit on the one or two short lines above its date line
  // (columns often split them into separate lines).
  const isHeaderLine = (l) => l && !BULLET_MARK.test(l.line) && l.line.length < 90 && !/[.!?]$/.test(l.line) && !parseRange(l.line);
  const headerOf = (k) => {
    const lines = [];
    for (let j = k - 1; j >= 0 && lines.length < 2 && isHeaderLine(region[j]); j--) lines.unshift(region[j].line);
    return lines;
  };
  const roles = dated.map((d, n) => {
    const above = headerOf(d.k);
    const next = dated[n + 1];
    const stop = next ? next.k - headerOf(next.k).length : region.length;
    const body = region.slice(d.k + 1, Math.max(d.k + 1, stop)).map((l) => l.line);
    const header = [...above, d.line].join(' ');
    return { header, title: above[0] || d.line, body, ...d.range };
  });
  const bullets = (body) => {
    const groups = [];
    body.forEach((l, i) => {
      if (BULLET_MARK.test(l) || i === 0 || /[.!?]$/.test(body[i - 1])) groups.push(l);
      else groups[groups.length - 1] += ` ${l}`;
    });
    return groups;
  };
  return {
    lines, sections, headingsFound: [...new Set(found)],
    roles: roles.map((r) => ({ ...r, bullets: bullets(r.body) })),
    text: (arr) => arr.map((l) => l.line).join('\n'),
  };
}

const monthsBetween = (a, b) => Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
const roleEnd = (r, now) => r.end || now;

/** Merged months across roles (overlapping roles count once). */
function monthsCovered(roles, now) {
  const spans = roles.map((r) => [r.start.getTime(), roleEnd(r, now).getTime()]).sort((a, b) => a[0] - b[0]);
  let total = 0; let curEnd = null; let curStart = null;
  for (const [s, e] of spans) {
    if (curEnd === null || s > curEnd) { if (curEnd !== null) total += curEnd - curStart; curStart = s; curEnd = e; }
    else curEnd = Math.max(curEnd, e);
  }
  if (curEnd !== null) total += curEnd - curStart;
  return total / (1000 * 60 * 60 * 24 * 30.44);
}

function recency(role, now) {
  const years = monthsBetween(roleEnd(role, now), now) / 12;
  return years <= 2 ? 1 : years <= 4 ? 0.9 : years <= 6 ? 0.75 : 0.55;
}

// ── Evidence: where a term shows up, and how convincing that is ─────────

function evidenceIndex(doc, profile, now) {
  const skills = profile?.skills || [];
  const terms = (text) => new Set([...extractTerms(text, skills)].map((t) => t.toLowerCase()));
  const inSkills = terms(doc.text(doc.sections.skills));
  const inSummary = terms(doc.text(doc.sections.summary));
  const inOther = terms(doc.text([...doc.sections.education, ...doc.sections.other]));
  const roles = doc.roles.map((r) => {
    const all = terms(`${r.header}\n${r.body.join('\n')}`);
    const quantified = new Set();
    for (const b of r.bullets) if (/\d/.test(b)) for (const t of terms(b)) quantified.add(t);
    return { all, quantified, role: r };
  });
  return function evidence(key) {
    let best = 0;
    if (inSkills.has(key)) best = 0.55;
    if (inSummary.has(key)) best = Math.max(best, 0.6);
    if (inOther.has(key)) best = Math.max(best, 0.5);
    let inRoles = 0;
    const exempt = FUNDAMENTALS.has(key) || PRACTICE_NAMES.has(key);
    for (const r of roles) {
      if (!r.all.has(key)) continue;
      inRoles++;
      best = Math.max(best, (r.quantified.has(key) ? 0.9 : 0.8) * (exempt ? 1 : recency(r.role, now)));
    }
    return inRoles >= 2 ? Math.min(1, best + 0.1) : best;
  };
}

function contentWords(text) {
  return [...new Set(norm(text).split(' ').filter((w) => w.length >= 4 && !['with', 'that', 'this', 'have', 'from', 'your', 'years', 'year', 'experience', 'ability', 'strong', 'proven', 'demonstrated'].includes(w)))];
}

// ── Scoring ────────────────────────────────────────────────────────────

function component(weight, subs) {
  const live = subs.filter((s) => s.of > 0);
  const possible = live.reduce((a, s) => a + s.of, 0);
  if (possible === 0) return null;
  const earned = live.reduce((a, s) => a + s.got, 0);
  return { points: round(weight * earned / possible), of: weight, subs: live.map((s) => ({ ...s, got: round(s.got, 2) })) };
}

const cleanChecklist = (cl) => (cl && Array.isArray(cl.requirements) ? cl : null);

function capsFor(profile) {
  const c = profile?.ats?.caps;
  return Array.isArray(c) && c.length === 3 && c.every((n) => Number.isFinite(Number(n)) && n >= 0 && n <= 100) ? c.map(Number) : DEFAULT_CAPS;
}

/**
 * Score one resume file's text against one job. Returns the 0–100 score,
 * its five parts with every sub-score, and findings ranked by impact.
 * `profile`/`profileBody` split missing keywords into ones the profile backs
 * (safe to add) and real gaps.
 */
export function atsScore({
  text = '', pages = null, fileName = '', jdText = '', checklist = null, jobTitle = '', profile = {}, profileBody = '', now = new Date(),
}) {
  const doc = readResume(text);
  const evidence = evidenceIndex(doc, profile, now);
  const cl = cleanChecklist(checklist);
  const rows = (cl?.requirements || []).map((r) => ({ ...r, type: r.type === 'nice' ? 'nice' : 'must' }));
  const findings = [];
  const find = (impact, message, lost = 0) => findings.push({ impact, message, lost: round(lost) });
  const wordCount = (text.match(/[A-Za-z]{2,}/g) || []).length;
  const hasText = wordCount >= 50;
  const lowerText = text.toLowerCase();

  // Job terms by importance.
  const skillsOf = profile.skills || [];
  const termsOf = (s) => [...extractTerms(s, skillsOf)].map((t) => t.toLowerCase());
  const mustTerms = cl ? [...new Set(rows.filter((r) => r.type === 'must').flatMap((r) => termsOf(r.text || '')))] : [];
  const niceTerms = cl ? [...new Set(rows.filter((r) => r.type === 'nice').flatMap((r) => termsOf(r.text || '')))].filter((t) => !mustTerms.includes(t)) : [];
  const jdAll = [...new Set(jdTerms(jdText || '', profile || {}).map((t) => t.toLowerCase()))];
  const display = new Map();
  for (const t of [...extractTerms(jdText || '', skillsOf), ...extractTerms(rows.map((r) => r.text || '').join('\n'), skillsOf)]) display.set(t.toLowerCase(), t);
  const show = (keys) => keys.map((k) => display.get(k) || k);

  // Requirements (40).
  let requirements = null;
  const misses = [];
  if (cl) {
    const items = rows.map((r) => {
      const terms = termsOf(r.text || '');
      let shown;
      if (terms.length) {
        shown = terms.reduce((a, t) => a + evidence(t), 0) / terms.length;
      } else {
        const words = contentWords(r.text);
        const inRoles = doc.roles.map((x) => norm(`${x.header} ${x.body.join(' ')}`)).join(' ');
        const share = (hay) => (words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0);
        shown = share(inRoles) >= 0.6 ? 0.8 : share(norm(text)) >= 0.6 ? 0.55 : 0;
      }
      const verdict = ['met', 'partial', 'missing'].includes(r.verdict) ? r.verdict : 'missing';
      const shownFactor = Math.max(NOT_SHOWN, shown);
      return { text: r.text || '', type: r.type, verdict, weight: WEIGHT[r.type], shown: round(shownFactor, 2), credit: VERDICT[verdict] * shownFactor };
    });

    // Years and education as requirements of their own, unless a row already covers them.
    const askYears = Number.isFinite(Number(cl.min_years)) && Number(cl.min_years) > 0 ? Number(cl.min_years) : extractYears(jdText)?.years ?? null;
    const relevantRoles = relevantRolesOf(doc.roles, [...mustTerms, ...niceTerms, ...jdAll], titleWords(jobTitle), skillsOf);
    const relevantYears = monthsCovered(relevantRoles, now) / 12;
    if (askYears && !rows.some((r) => /\b\d+\s*\+?\s*years?\b|years of/i.test(r.text || ''))) {
      items.push({ text: `${askYears}+ years of relevant experience`, type: 'must', verdict: 'met', weight: 1, shown: round(yearsCredit(relevantYears, askYears), 2), credit: yearsCredit(relevantYears, askYears), derived: true });
    }
    const wantEdu = ['bachelor', 'master', 'phd'].includes(cl.education) ? cl.education : null;
    if (wantEdu && !rows.some((r) => /\bdegree\b|\bbachelor|\bmaster'?s?\b|\bph\.?d\b|\bb\.?s\b|\bm\.?s\b/i.test(r.text || ''))) {
      const have = DEGREE_LEVEL.find(([, re]) => re.test(text))?.[0];
      const credit = !have ? 0 : LEVEL_RANK[have] >= LEVEL_RANK[wantEdu] ? 1 : 0.5;
      items.push({ text: `${wantEdu}'s-level degree`, type: 'must', verdict: 'met', weight: 1, shown: credit, credit, derived: true });
    }
    for (const cert of (Array.isArray(cl.certifications) ? cl.certifications : []).slice(0, 10)) {
      if (rows.some((r) => norm(r.text).includes(norm(cert)))) continue;
      const credit = lowerText.includes(String(cert).toLowerCase()) ? 1 : 0;
      items.push({ text: `${cert} certification`, type: 'nice', verdict: 'met', weight: WEIGHT.nice, shown: credit, credit, derived: true });
    }

    const totalW = items.reduce((a, i) => a + i.weight, 0);
    if (totalW > 0) {
      const ratio = items.reduce((a, i) => a + i.weight * i.credit, 0) / totalW;
      requirements = { points: round(40 * ratio), of: 40, items: items.map((i) => ({ ...i, credit: round(i.credit, 2) })) };
      for (const i of items) {
        const lost = 40 * i.weight * (1 - i.credit) / totalW;
        if (i.verdict === 'missing' && i.type === 'must' && !i.derived) misses.push(i.text);
        if (i.verdict === 'missing') find(i.type === 'must' ? 'critical' : 'medium', `${i.type === 'must' ? 'Must-have' : 'Nice-to-have'} "${i.text}": your profile doesn't back it, so the resume can't show it.`, lost);
        else if (i.credit < 0.6 * VERDICT[i.verdict] + 1e-9 && lost >= 0.5) find('high', `"${i.text}" is ${i.verdict === 'met' ? 'backed by your profile' : 'partly backed'} but the resume shows it weakly or not at all: put it in an experience bullet with the result.`, lost);
      }
    }
  }

  // Skills & keywords (25).
  const limited = !cl;
  const must = limited ? jdAll : mustTerms;
  const mean = (keys) => keys.reduce((a, k) => a + evidence(k), 0) / Math.min(keys.length, TERM_CAP);
  const allJd = [...new Set([...must, ...niceTerms, ...jdAll])];
  const skillsPart = allJd.length === 0 ? null : component(25, [
    { name: 'mustHaveTerms', got: must.length ? 15 * Math.min(1, mean(must)) : 0, of: must.length ? 15 : 0 },
    { name: 'niceTerms', got: niceTerms.length ? 5 * Math.min(1, mean(niceTerms)) : 0, of: niceTerms.length ? 5 : 0 },
    { name: 'jobVocabulary', got: 5 * (allJd.filter((k) => evidence(k) > 0).length / Math.min(allJd.length, TERM_CAP)), of: 5 },
  ]);
  const backed = new Set([...skillsOf.map((s) => String(canonicalize(s)).toLowerCase()), ...extractTerms(profileBody, skillsOf)].map((s) => String(s).toLowerCase()));
  const missingAll = [...new Set([...must, ...niceTerms])].filter((k) => evidence(k) === 0);
  const keywordsYouCanAdd = show(missingAll.filter((k) => backed.has(k)));
  const keywordGaps = show(missingAll.filter((k) => !backed.has(k)));
  const skillsOnly = must.filter((k) => { const e = evidence(k); return e > 0 && e <= 0.6; });
  if (keywordsYouCanAdd.length) find('high', `Add keywords your experience backs: ${keywordsYouCanAdd.slice(0, 8).join(', ')}.`, skillsPart ? 15 * keywordsYouCanAdd.length / Math.min(Math.max(must.length, 1), TERM_CAP) : 0);
  if (skillsOnly.length) find('high', `Only listed, never shown in a role: ${show(skillsOnly).slice(0, 6).join(', ')}. Add a bullet that uses each.`, 15 * 0.3 * skillsOnly.length / Math.min(Math.max(must.length, 1), TERM_CAP));

  // Title & experience (15).
  const tw = titleWords(jobTitle);
  const titleTier = () => {
    if (!tw.length) return null;
    const best = Math.max(0, ...doc.roles.map((r) => { const w = new Set(norm(r.header).split(' ')); return tw.filter((x) => w.has(x)).length / tw.length; }));
    return best >= 1 ? 5 : best >= 0.66 ? 4 : best >= 0.33 ? 2.5 : 0;
  };
  const tt = titleTier();
  const jobLevel = extractLevel(jobTitle, jdText || '')?.level;
  const dist = jobLevel && profile.level ? levelDistance(profile.level, jobLevel) : null;
  const seniority = dist === null ? null : [3, 2, 1][dist] ?? 0;
  const jobKeys = [...must, ...niceTerms];
  const relevant = relevantRolesOf(doc.roles, jobKeys.length ? jobKeys : jdAll, tw, skillsOf);
  const askYears = cl && Number.isFinite(Number(cl.min_years)) && Number(cl.min_years) > 0 ? Number(cl.min_years) : extractYears(jdText || '')?.years ?? null;
  const relYears = monthsCovered(relevant, now) / 12;
  const recentCredit = (() => {
    if (!doc.roles.length || (!jobKeys.length && !jdAll.length && !tw.length)) return doc.roles.length ? null : 0;
    const latest = doc.roles[0];
    if (!relevant.includes(latest)) { const r = relevant[0]; return r ? (monthsBetween(roleEnd(r, now), now) / 12 <= 2 ? 2 : monthsBetween(roleEnd(r, now), now) / 12 <= 4 ? 1 : 0) : 0; }
    return 3;
  })();
  const experience = component(15, [
    { name: 'title', got: tt ?? 0, of: tt === null ? 0 : 5 },
    { name: 'seniority', got: seniority ?? 0, of: seniority === null ? 0 : 3 },
    { name: 'relevantYears', got: askYears ? 4 * yearsCredit(relYears, askYears) : 0, of: askYears ? 4 : 0 },
    { name: 'recentRelevantRole', got: recentCredit ?? 0, of: recentCredit === null ? 0 : 3 },
  ]);
  if (tt !== null && tt < 5) find('medium', `The job's title wording (${tw.join(' ')}) isn't in any role title; use it where it's true for you.`, 5 - tt);
  if (seniority !== null && seniority < 3) find('medium', `Seniority: the job reads as ${jobLevel}, your profile says ${profile.level}.`, 3 - seniority);
  if (askYears && yearsCredit(relYears, askYears) < 1) find('medium', `The job asks for ${askYears}+ years; the resume shows about ${round(relYears)} relevant years. Make sure every relevant role has dates and bullets.`, 4 * (1 - yearsCredit(relYears, askYears)));
  if (recentCredit !== null && recentCredit < 3) find('medium', 'Your most recent role reads as unrelated to this job. Lead its bullets with the work that matches.', 3 - recentCredit);

  // Parseability (15).
  const headingsFound = STANDARD.filter((h) => doc.headingsFound.includes(h));
  const garbled = (text.match(/\(cid:\d+\)|�/g) || []).length;
  const exp = Array.isArray(profile.experience) ? profile.experience : [];
  const companies = [...new Set(exp.map((e) => norm(e.company)).filter(Boolean))];
  const haystack = norm(text);
  const rate = companies.length ? companies.filter((c) => haystack.includes(c)).length / companies.length : (doc.roles.length ? 1 : 0);
  const top = doc.lines.slice(0, 10).join('\n');
  const newestFirst = doc.roles.every((r, i) => i === 0 || r.start <= doc.roles[i - 1].start);
  const parse = component(15, [
    { name: 'text', got: hasText ? 4 : 0, of: 4 },
    { name: 'sections', got: 3 * headingsFound.length / 3, of: 3 },
    { name: 'rolesRecovered', got: rate >= 0.9 ? 3 : 3 * rate, of: 3 },
    { name: 'contact', got: (EMAIL.test(text) ? 1 : 0) + (PHONE.test(text) ? 1 : 0), of: 2 },
    { name: 'readingOrder', got: (EMAIL.test(top) ? 1 : 0) + (newestFirst && doc.roles.length ? 1 : doc.roles.length ? 0 : 0), of: 2 },
    { name: 'cleanCharacters', got: garbled === 0 ? 1 : garbled < 5 ? 0.4 : 0, of: 1 },
  ]);
  if (!hasText) find('format', 'The file has almost no readable text; it may be a scanned image. Export it as a text PDF or DOCX.', 15);
  if (headingsFound.length < 3) find('format', `Use standard section headings: ${STANDARD.filter((h) => !headingsFound.includes(h)).join(', ')}.`, 3 - headingsFound.length);
  if (rate < 0.9) find('format', `Only ${Math.round(rate * 100)}% of your employers were recovered from the text; check that company names are plain text.`, 3 * (1 - rate));
  if (!EMAIL.test(top)) find('format', 'Put your email and phone number as plain text at the top of the page, not in a header or footer.', 1);
  if (!newestFirst) find('format', 'Roles should run newest first.', 1);
  if (garbled) find('format', 'Some characters come out garbled; use a standard font.', 1);

  // Hygiene (5).
  const ext = extname(fileName || '').toLowerCase();
  const words = (text.match(/\S+/g) || []).length;
  const estPages = pages ?? Math.max(1, Math.ceil(words / 550));
  const ranges = (text.match(new RegExp(RANGE_SRC, 'gi')) || []).length;
  const perPage = words / estPages;
  const hygiene = component(5, [
    { name: 'fileType', got: ext === '.pdf' || ext === '.docx' ? 1 : 0, of: 1 },
    { name: 'dates', got: ranges >= 2 ? 1 : ranges === 1 ? 0.5 : 0, of: 1 },
    { name: 'contact', got: EMAIL.test(text) && PHONE.test(text) ? 1 : EMAIL.test(text) ? 0.5 : 0, of: 1 },
    { name: 'length', got: estPages <= 2 ? 1 : estPages === 3 ? 0.7 : 0.3, of: 1 },
    { name: 'anomalies', got: garbled === 0 && perPage >= 150 && perPage <= 1100 ? 1 : 0.5, of: 1 },
  ]);
  if (ext !== '.pdf' && ext !== '.docx') find('format', 'Send a PDF or DOCX.', 1);
  if (ranges < 2) find('format', 'Give each role a date range like "Jan 2020 - Present".', 1 - Math.min(1, ranges * 0.5));
  if (estPages > 2) find('format', `Now ${estPages} pages; 2 or fewer reads better.`, estPages === 3 ? 0.3 : 0.7);

  // Total, with ceilings.
  const parts = { requirements, skills: skillsPart, experience, parse, hygiene };
  const live = Object.values(parts).filter(Boolean);
  const raw = (live.reduce((a, p) => a + p.points, 0) / live.reduce((a, p) => a + p.of, 0)) * 100;
  let score = Math.round(raw);
  let cap = null;
  if (misses.length) {
    const limit = capsFor(profile)[Math.min(misses.length, 3) - 1];
    if (score > limit) { cap = { limit, because: misses }; score = limit; }
  }
  if (!hasText) score = Math.min(score, 10);
  if (limited) find('high', 'No requirement checklist for this job yet. Run match for it to unlock the requirements score (40 points).', 0);
  if (cap) find('critical', `Score capped at ${cap.limit}: ${misses.length} must-have${misses.length > 1 ? 's' : ''} your profile can't back.`, 0);

  findings.sort((a, b) => IMPACT.indexOf(a.impact) - IMPACT.indexOf(b.impact) || b.lost - a.lost);
  return {
    score,
    raw: Math.round(raw),
    cap,
    limited,
    file: basename(fileName || ''),
    parts,
    findings,
    fixes: findings.map((f) => f.message),
    keywordsYouCanAdd,
    keywordGaps,
    note: 'ATS-readiness + job-match score: how credibly the resume shows what the job asks (evidence in a role beats a skills list, recent beats old) and whether software can recover its structure. No ATS publishes a score; this is an audit, not a simulation.',
  };
}

function yearsCredit(have, ask) {
  const ratio = have / ask;
  return ratio >= 1 ? 1 : ratio >= 0.8 ? 0.85 : ratio >= 0.6 ? 0.65 : clamp01(ratio);
}

/** Roles whose text shows at least two of the job's terms, or one of its title words in the role title. */
function relevantRolesOf(roles, jobKeys, tw, skills) {
  const keys = new Set(jobKeys);
  return roles.filter((r) => {
    const terms = [...extractTerms(`${r.header}\n${r.body.join('\n')}`, skills)].filter((t) => keys.has(t.toLowerCase()));
    const title = new Set(norm(r.header).split(' '));
    return terms.length >= 2 || (tw.length > 0 && tw.some((w) => title.has(w)));
  });
}
