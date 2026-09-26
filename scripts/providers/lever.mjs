// Lever provider — public postings endpoint.
// Adapted from career-ops providers/lever.mjs (MIT), slimmed to plain fetch.
// Lever's v0 postings list ships the full description for free, so
// description fetches are a board list + match on hostedUrl.

import { fetchJson, toEpochMs } from '../lib/_http.mjs';

const ALLOWED_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

export function apiUrlFor(slug) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}`;
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`lever: untrusted hostname "${parsed.hostname}"`);
  return url;
}

/** @returns {Promise<Array<{title,url,location,description,postedAt}>>} */
export async function fetchBoard({ name, slug }, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  const json = await fetchJsonFn(apiUrlFor(slug), { redirect: 'error' });
  if (!Array.isArray(json)) return [];
  return json.map((j) => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: name,
    location: j.categories?.location || '',
    description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
    postedAt: typeof j.createdAt === 'number' ? j.createdAt : toEpochMs(j.createdAt),
  }));
}

export async function fetchDescription({ slug }, _jobId, { fetchJson: fetchJsonFn = fetchJson, url = '' } = {}) {
  const postings = await fetchJsonFn(apiUrlFor(slug), { redirect: 'error' });
  const match = Array.isArray(postings) && url
    ? postings.find((j) => (j.hostedUrl || '').split('?')[0] === url.split('?')[0])
    : null;
  return match ? match.descriptionPlain || '' : '';
}
