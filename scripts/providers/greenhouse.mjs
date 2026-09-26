// Greenhouse provider — public boards-api JSON endpoint.
// Adapted from career-ops providers/greenhouse.mjs (MIT), slimmed to plain fetch.
//
// Kept from the original: the work-model-only location fix. Some Greenhouse
// boards put "Hybrid" / "Distributed" in location.name and keep the actual
// city in the separate offices[] array, which the /jobs list endpoint does
// not return. For those boards a location filter never sees a city. The city
// is recoverable from /v1/boards/{slug}/offices (one extra request, only paid
// by boards that actually exhibit the pattern).

import { fetchJson, toEpochMs } from '../lib/_http.mjs';

const ALLOWED_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

export function apiUrlFor(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
  return assertUrl(url);
}

function assertUrl(url) {
  const parsed = new URL(url); // throws on garbage
  if (parsed.protocol !== 'https:') throw new Error('greenhouse: URL must use HTTPS');
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}"`);
  return url;
}

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => WORK_MODEL.test(p));
}

export function officesUrlFor(apiUrl) {
  const m = apiUrl.match(/^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/);
  return m ? `${m[1]}/offices` : null;
}

/** jobId → Set(office names), walking offices → departments → jobs. */
export function buildOfficeMap(json) {
  const map = new Map();
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const name = typeof office.name === 'string' ? office.name.trim() : '';
      if (name) {
        for (const dept of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(dept?.jobs) ? dept.jobs : []) {
            if (!job || job.id == null) continue;
            if (!map.has(job.id)) map.set(job.id, new Set());
            map.get(job.id).add(name);
          }
        }
      }
      walk(office.children);
    }
  };
  walk(json?.offices);
  return map;
}

/** @returns {Promise<Array<{title,url,location,postedAt}>>} */
export async function fetchBoard({ name, slug }, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  const apiUrl = apiUrlFor(slug);
  const json = await fetchJsonFn(apiUrl, { redirect: 'error' });
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  const usable = jobs.filter((j) => j.absolute_url);

  let officeMap = null;
  if (usable.some((j) => isWorkModelOnly(j.location?.name))) {
    const officesUrl = officesUrlFor(apiUrl);
    if (officesUrl) {
      try {
        officeMap = buildOfficeMap(await fetchJsonFn(assertUrl(officesUrl), { redirect: 'error' }));
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  greenhouse: ${name} /offices enrichment failed — ${cause} (keeping work-model-only locations)`);
        officeMap = null;
      }
    }
  }

  return usable.map((j) => {
    let location = j.location?.name || '';
    if (officeMap && isWorkModelOnly(location)) {
      const offices = officeMap.get(j.id);
      if (offices && offices.size > 0) location = [location, ...offices].join(' · ');
    }
    return {
      title: j.title || '',
      url: j.absolute_url,
      company: name,
      location,
      postedAt: toEpochMs(j.first_published),
    };
  });
}

/** Job id from a public posting URL, for description fetches. */
export function jobIdFromUrl(url) {
  return url.match(/(?:\/|=)(\d+)(?:[/?#]|$)/)?.[1] || null;
}

/** Full description (HTML) for one job. */
export async function fetchDescription({ slug }, jobId, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  const json = await fetchJsonFn(assertUrl(apiUrlFor(slug).replace(/\/jobs$/, `/jobs/${jobId}`)), { redirect: 'error' });
  return typeof json?.content === 'string' ? json.content : '';
}
