#!/usr/bin/env node
// jobpilot liveness — is this posting still open?
//
//   node liveness.mjs <posting-url>     → prints {"verdict": "active|expired|uncertain", "signal": "..."}
//
// Signals adapted from career-ops liveness-core.mjs (MIT). Expired signals WIN
// over generic Apply text: many ATSs keep a generic Apply button on closed
// postings. Used by `review` and `apply` to warn before wasting effort on a
// dead posting. Heuristic only — a verdict of `uncertain` means check the page.

import { resolve } from 'node:path';
import { fetchText } from './lib/_http.mjs';
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

export async function checkUrl(url) {
  try {
    const text = await fetchText(url, { timeoutMs: 20_000 });
    return classifyLiveness({ status: 200, bodyText: text });
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
