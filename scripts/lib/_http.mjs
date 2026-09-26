// HTTP transport for jobpilot — one slim helper over plain fetch, shared by
// every provider. Adapted from career-ops providers/_http.mjs (MIT).

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'jobpilot/0.1 (+https://github.com/Krutarth22/jobpilot)';

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, redirect = 'follow' } = {}, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, ...headers },
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    // Body consumption stays inside the timer window: a server that sends
    // headers and then stalls the body must not hang the caller.
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

export const fetchJson = (url, opts = {}) => fetchWithTimeout(url, opts, (res) => res.json());
export const fetchText = (url, opts = {}) => fetchWithTimeout(url, opts, (res) => res.text());
/** Like fetchText, but also returns the post-redirect URL. */
export const fetchPage = (url, opts = {}) =>
  fetchWithTimeout(url, opts, async (res) => ({ url: res.url, text: await res.text() }));

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0. */
export function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
