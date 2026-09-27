// profile.md parser — machine-readable YAML front matter + human-readable prose.
//
// Setup writes YAML front matter at the top of profile.md; everything below it
// stays free-form. The front matter is the machine layer every scorer reads:
//
//   ---
//   years_experience: 11
//   level: manager            # ic-mid | ic-senior | staff | principal | manager | senior-manager | director
//   target_titles: [Engineering Manager, Senior Backend Engineer]
//   skills: [python, pytorch, kubernetes]   # canonical names (see lib/skills.mjs)
//   languages: [english]
//   locations: { remote: preferred, cities: [New York], relocate: false }
//   comp: { currency: USD, min_base: 250000, min_total: 350000, multipliers: { "company:Stripe": 1.8, "stage:public": 1.7, default: 1.4 } }
//   deal_breakers: { onsite_only: true, needs_sponsorship: false, clearance: false }
//   weights: { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 }
//   anchors:
//     - { title: ..., company: ..., summary: ..., score: 70 }
//   links: { github: ..., website: ..., linkedin: ..., other: [...] }
//   ---
//
// A MISSING FIELD means that signal is scored "unknown" (neutral) — never
// guessed. See score.mjs.

import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { profilePath } from './workspace.mjs';

/**
 * Split profile.md text into { frontmatter, body, hasFrontmatter }.
 * Front matter must be the first thing in the file, fenced by `---` lines.
 * Malformed YAML returns hasFrontmatter:false and treats everything as body —
 * a broken front matter must never silently zero a signal; the empty
 * frontmatter makes every signal "unknown" and the caller can warn.
 */
export function parseProfile(text = '') {
  const normalized = String(text).replace(/^\uFEFF/, '');
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  let frontmatter = {};
  try {
    const parsed = yaml.load(match[1]);
    frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  }
  return { frontmatter, body: normalized.slice(match[0].length).trim(), hasFrontmatter: true };
}

const DEFAULT_WEIGHTS = { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 };

/** Normalized view of the front matter with defaults applied where safe. */
export function normalizeProfile(frontmatter = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(frontmatter.weights || {}) };
  const wsum = Object.values(weights).reduce((a, b) => a + (Number(b) || 0), 0);
  return {
    ...frontmatter,
    years_experience: Number.isFinite(Number(frontmatter.years_experience))
      ? Number(frontmatter.years_experience) : undefined,
    level: typeof frontmatter.level === 'string' ? frontmatter.level.trim().toLowerCase() : undefined,
    target_titles: Array.isArray(frontmatter.target_titles) ? frontmatter.target_titles.map(String) : [],
    skills: Array.isArray(frontmatter.skills)
      ? frontmatter.skills.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : [],
    languages: Array.isArray(frontmatter.languages)
      ? frontmatter.languages.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
      : [],
    locations: frontmatter.locations && typeof frontmatter.locations === 'object' ? frontmatter.locations : {},
    comp: frontmatter.comp && typeof frontmatter.comp === 'object' ? frontmatter.comp : {},
    deal_breakers: frontmatter.deal_breakers && typeof frontmatter.deal_breakers === 'object'
      ? frontmatter.deal_breakers : {},
    // Weights are renormalized only when their sum is off — scoring needs the
    // raw intent preserved, so a user-set 40/25/15/10/10 stays as written.
    weights: wsum > 0 ? weights : DEFAULT_WEIGHTS,
    anchors: Array.isArray(frontmatter.anchors) ? frontmatter.anchors : [],
    // Tailored-resume output (lib/resume-output.mjs): the name for the file
    // recruiters see, paper size, and a page limit. Missing → inferred.
    name: typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '',
    paper: ['letter', 'a4'].includes(String(frontmatter.paper).toLowerCase()) ? String(frontmatter.paper).toLowerCase() : undefined,
    max_pages: Number(frontmatter.max_pages) > 0 ? Number(frontmatter.max_pages) : undefined,
    // Age penalty for the ranked list (lib/rank.mjs); missing → defaults.
    ranking: frontmatter.ranking && typeof frontmatter.ranking === 'object' ? frontmatter.ranking : {},
    // Links the resume itself points to (GitHub, personal site, LinkedIn, …).
    // Passed through as-is: claims.mjs's self-check treats a missing link as
    // "Not assessable", never adverse — it never guesses a URL.
    links: frontmatter.links && typeof frontmatter.links === 'object' && !Array.isArray(frontmatter.links)
      ? {
        ...frontmatter.links,
        other: Array.isArray(frontmatter.links.other) ? frontmatter.links.other.map(String) : [],
      }
      : {},
  };
}

/** Parse profile.md from a workspace root. Missing file → all-unknown profile. */
export function loadProfile(root) {
  const p = profilePath(root);
  if (!existsSync(p)) return { profile: normalizeProfile({}), body: '', hasFrontmatter: false, exists: false };
  const { frontmatter, body, hasFrontmatter } = parseProfile(readFileSync(p, 'utf8'));
  return { profile: normalizeProfile(frontmatter), body, hasFrontmatter, exists: true };
}

/**
 * Set one top-level front matter field, rewriting only that field's lines
 * (as one flow-style line) so the rest of profile.md — comments, other
 * fields, prose — stays byte-for-byte. A missing field is added at the end
 * of the front matter. Throws rather than write a file that no longer
 * parses back to the intended value.
 */
export function setFrontmatterField(text, key, value) {
  const src = String(text);
  const match = src.match(/^(﻿?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!match) throw new Error('profile.md has no front matter');
  const [, open, fm, close] = match;
  const flow = yaml.dump(value, { flowLevel: 0, lineWidth: -1 }).trim().replace(/^\{(.*)\}$/, '{ $1 }');
  const line = `${key}: ${flow}`;
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(l));
  if (start === -1) {
    lines.push(line);
  } else {
    let end = start + 1;
    while (end < lines.length && (/^\s+\S/.test(lines[end]) || (lines[end].trim() === '' && /^\s+\S/.test(lines[end + 1] || '')))) end++;
    lines.splice(start, end - start, line);
  }
  const out = open + lines.join('\n') + close + src.slice(match[0].length);
  const check = parseProfile(out);
  if (!check.hasFrontmatter || JSON.stringify(check.frontmatter[key]) !== JSON.stringify(value)) {
    throw new Error(`could not rewrite "${key}" in profile.md front matter safely`);
  }
  return out;
}
