// Ashby provider — public posting-api endpoint.
// Adapted from career-ops providers/ashby.mjs (MIT), slimmed to plain fetch.
//
// Kept from the original: (1) a longer timeout + backoff retry, because the
// posting-api has a ~10s+ server-side latency floor and rate-limits repeated
// unauthenticated hits; (2) secondaryLocations folding, so an EU-eligible role
// whose primary label is "Canada" still matches "Europe" / "Berlin";
// (3) compensation parsing (annualized) for the match rubric's comp signal.

import { fetchJson, sleep, toEpochMs } from '../lib/_http.mjs';

const TIMEOUT_MS = 30_000;
const RETRIES = 2;

const INTERVAL_MULTIPLIERS = {
  '1 HOUR': 2080, '1 DAY': 260, '1 WEEK': 52, '2 WEEK': 26,
  '0.5 MONTH': 24, '1 MONTH': 12, '2 MONTH': 6, '3 MONTH': 4,
  '6 MONTH': 2, '1 YEAR': 1,
};

export function parseCompensation(job) {
  const comp = job?.compensation;
  if (!comp) return null;
  const multiplier = INTERVAL_MULTIPLIERS[comp.interval || '1 YEAR'];
  if (!multiplier) return null;
  const normalizeNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const minValue = normalizeNum(comp.minValue);
  const maxValue = normalizeNum(comp.maxValue);
  const currency = typeof comp.currency === 'string' ? comp.currency.trim().toUpperCase() : '';
  if (minValue == null && maxValue == null) return null;
  const min = minValue != null ? minValue * multiplier : null;
  const max = maxValue != null ? maxValue * multiplier : null;
  if (min == null && max == null) return null;
  const resolvedMin = min ?? max;
  const resolvedMax = max ?? min;
  return { min: Math.min(resolvedMin, resolvedMax), max: Math.max(resolvedMin, resolvedMax), currency };
}

export function apiUrlFor(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.ashbyhq.com') throw new Error(`ashby: untrusted hostname "${parsed.hostname}"`);
  return url;
}

function formatLocation(j) {
  const parts = [];
  if (typeof j.location === 'string' && j.location.trim()) parts.push(j.location.trim());
  if (Array.isArray(j.secondaryLocations)) {
    for (const s of j.secondaryLocations) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.location === 'string' && s.location.trim()) parts.push(s.location.trim());
      const pa = s.address && s.address.postalAddress;
      if (pa) {
        for (const k of ['addressLocality', 'addressCountry']) {
          if (typeof pa[k] === 'string' && pa[k].trim()) parts.push(pa[k].trim());
        }
      }
    }
  }
  return [...new Set(parts)].join(' · ');
}

async function fetchBoardJson(slug, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
    try {
      return await fetchJsonFn(apiUrlFor(slug), { timeoutMs: TIMEOUT_MS, redirect: 'error' });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** @returns {Promise<Array<{title,url,location,salary,description,postedAt}>>} */
export async function fetchBoard({ name, slug }, opts = {}) {
  const json = await fetchBoardJson(slug, opts);
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.map((j) => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: name,
    location: formatLocation(j),
    salary: parseCompensation(j),
    description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
    postedAt: toEpochMs(j.publishedAt),
  }));
}

export async function fetchDescription({ slug }, _jobId, { fetchJson: fetchJsonFn = fetchJson, url = '' } = {}) {
  const json = await fetchBoardJson(slug, { fetchJson: fetchJsonFn });
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const match = url ? jobs.find((j) => (j.jobUrl || '').split('?')[0] === url.split('?')[0]) : null;
  return match ? match.descriptionPlain || '' : '';
}
