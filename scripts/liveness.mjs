#!/usr/bin/env node
// jobpilot liveness — is this posting still open?
//
//   node liveness.mjs <posting-url>     → prints {"verdict": "active|expired|uncertain", "signal": "..."}
//
// Greenhouse, Lever and Ashby postings are checked against the ATS's own API
// first. Other URLs fall back to page-text signals adapted from career-ops
// liveness-core.mjs (MIT). Expired signals WIN
// over generic Apply text: many ATSs keep a generic Apply button on closed
// postings. Used by `review` and `apply` to warn before wasting effort on a
// dead posting. Heuristic only — a verdict of `uncertain` means check the page.

import { fetchJson, fetchPage } from './lib/_http.mjs';
import { normalizeUrl } from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';

function normalizeForMatch(text = '') {
  if (typeof text !== 'string') return '';
  return text
    .replace(/['’ʼ′´`]/g, "'")
    .replace(/[“”″]/g, '"')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

// Closure banners (with typographic normalization — pages render “n’est plus
// disponible” with U+2019, so patterns are spelled accent/ASCII-normalized).
export const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /\b(?:job|jobs|position|role|posting|opening|vacancy|requisition|req|listing)\b[\s\S]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expiree|n'est plus disponible)/i,
  /(cette )?offre n'est plus (disponible|en ligne|active)/i,
  /(offre|poste|annonce) (deja )?pourvu(e)?/i,
];

// Anti-bot interstitials must NOT read as expired — they are uncertain.
export const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /performing security verification/i,
  /checking your browser before/i,
  /verify you are (a |not a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required.*cloudflare/i,
  /\bray id\b/i,
];

export const APPLY_PATTERNS = [
  /\bapply\b/i,
  /submit application/i,
  /start application/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
];

const MIN_CONTENT_CHARS = 300;

/**
 * Classify a posting page. Expired signals win over generic Apply text;
 * short bodies without a recognized Apply control are `uncertain`, never
 * silently `active`.
 */
export function classifyLiveness({ status = 0, bodyText = '' } = {}) {
  const text = normalizeForMatch(bodyText);

  if (status === 404 || status === 410) {
    return { verdict: 'expired', signal: `HTTP ${status}` };
  }
  if (status !== 0 && status >= 400) {
    return { verdict: 'uncertain', signal: `HTTP ${status}` };
  }
  if (BOT_CHALLENGE_PATTERNS.some((p) => p.test(text))) {
    return { verdict: 'uncertain', signal: 'anti-bot challenge page' };
  }
  const expired = HARD_EXPIRED_PATTERNS.find((p) => p.test(text));
  if (expired) {
    return { verdict: 'expired', signal: `closure text matched ${expired}` };
  }
  const hasApply = APPLY_PATTERNS.some((p) => p.test(text));
  const enoughContent = text.length >= MIN_CONTENT_CHARS;
  if (hasApply && enoughContent) {
    return { verdict: 'active', signal: `apply control + ${text.length} chars of content` };
  }
  if (!hasApply && !enoughContent) {
    return { verdict: 'uncertain', signal: `only ${text.length} chars, no apply control` };
  }
  return { verdict: 'uncertain', signal: hasApply ? 'apply control but thin content' : 'content but no apply control' };
}

/** Visible text only: JS-rendered boards (Ashby, Lever) ship bundles full of
 * words like "apply" that would otherwise read as a live posting. */
export function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

// Greenhouse redirects a closed job to its board with ?error=true.
export function isClosedRedirect(finalUrl) {
  try {
    return new URL(finalUrl).searchParams.get('error') === 'true';
  } catch {
    return false;
  }
}

/**
 * The ATS's own API is the most reliable signal for the three boards jobpilot
 * scans. Returns null for any other URL (or when the API can't decide).
 */
export async function checkViaApi(url, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const [slug, id] = u.pathname.split('/').filter(Boolean);
  const byStatus = async (apiUrl) => {
    try {
      await fetchJsonFn(apiUrl, { redirect: 'error' });
      return { verdict: 'active', signal: `listed in ${u.hostname} API` };
    } catch (err) {
      if (err?.status === 404) return { verdict: 'expired', signal: `404 from ${u.hostname} API` };
      return null;
    }
  };
  if (u.hostname === 'jobs.lever.co' && slug && id) {
    return byStatus(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`);
  }
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    const ghId = u.searchParams.get('gh_jid') || u.pathname.match(/\/jobs\/(\d+)/)?.[1];
    if (slug && ghId) return byStatus(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${ghId}`);
  }
  if (u.hostname === 'jobs.ashbyhq.com' && slug && id) {
    try {
      const json = await fetchJsonFn(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`, { timeoutMs: 30_000, redirect: 'error' });
      const listed = (json?.jobs || []).some((j) => normalizeUrl(j.jobUrl || '') === normalizeUrl(url));
      return listed
        ? { verdict: 'active', signal: 'listed in Ashby board API' }
        : { verdict: 'expired', signal: 'no longer in Ashby board API' };
    } catch {
      return null;
    }
  }
  return null;
}

export async function checkUrl(url) {
  const api = await checkViaApi(url);
  if (api) return api;
  try {
    const page = await fetchPage(url, { timeoutMs: 20_000 });
    if (isClosedRedirect(page.url)) return { verdict: 'expired', signal: `redirected to ${page.url}` };
    return classifyLiveness({ status: 200, bodyText: visibleText(page.text) });
  } catch (err) {
    const status = err?.status;
    if (status === 404 || status === 410) return { verdict: 'expired', signal: `HTTP ${status}` };
    return { verdict: 'uncertain', signal: err instanceof Error ? err.message : String(err) };
  }
}

if (isMainModule(import.meta.url)) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node liveness.mjs <posting-url>');
    process.exit(1);
  }
  checkUrl(url).then((r) => console.log(JSON.stringify(r, null, 2)));
}
