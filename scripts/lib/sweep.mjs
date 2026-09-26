// Closed-posting sweep (B4). Runs the ATS-API-first liveness check over
// `new` and `applied` rows and marks expired ones `closed`. Never touches
// rows whose liveness is uncertain — silence is not evidence.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJobs, updateJobs } from './workspace.mjs';
import { fetchJson } from './_http.mjs';
import { checkViaApi, checkUrl } from '../liveness.mjs';

export const SWEEP_DEFAULT_LIMIT = 40;

// When each row was last checked, so every sweep starts with the rows checked
// longest ago. Without it, the same 40 oldest rows are re-checked forever
// and everything after them is never swept.
const statePath = (root) => join(root, '.sweep-state.json');

function loadState(root) {
  try {
    return existsSync(statePath(root)) ? JSON.parse(readFileSync(statePath(root), 'utf8')) : {};
  } catch {
    return {};
  }
}

/** One fetch per URL per sweep: Ashby's liveness check downloads the whole
 * board, so 30 open Ramp roles must not mean 30 board downloads. */
export function memoizedFetchJson(fetchJsonFn = fetchJson) {
  const cache = new Map();
  return (url, opts) => {
    if (!cache.has(url)) cache.set(url, fetchJsonFn(url, opts));
    return cache.get(url);
  };
}

/** Check one posting; returns {verdict, signal}. */
export async function checkPosting(url, { fetchJson: fetchJsonFn = fetchJson } = {}) {
  const api = await checkViaApi(url, { fetchJson: fetchJsonFn });
  if (api) return api;
  return checkUrl(url);
}

/** Rows to check this sweep: never-checked first, then least recently
 * checked, then oldest `found`. */
export function pickCandidates(jobs, state, { limit, statuses }) {
  return jobs
    .filter((j) => statuses.includes(j.status))
    .sort((a, b) => String(state[a.id] || '').localeCompare(String(state[b.id] || ''))
      || String(a.found).localeCompare(String(b.found)))
    .slice(0, limit);
}

/**
 * Sweep new/applied rows (bounded, rotating). Returns counts and writes
 * status updates + notes for expired rows.
 */
export async function sweepClosed(root, {
  limit = SWEEP_DEFAULT_LIMIT, statuses = ['new', 'applied'], now = new Date().toISOString().slice(0, 10), check = checkPosting,
} = {}) {
  const state = loadState(root);
  const candidates = pickCandidates(readJobs(root), state, { limit, statuses });
  const fetchOnce = memoizedFetchJson();

  let closed = 0;
  const details = [];
  for (const job of candidates) {
    const verdict = await check(job.url, { fetchJson: fetchOnce });
    state[job.id] = now;
    if (verdict?.verdict === 'expired') {
      const note = `sweep ${now}: posting closed (${verdict.signal})`;
      updateJobs(root, job.id, {
        status: 'closed',
        notes: job.notes ? `${job.notes} | ${note}` : note,
      });
      closed++;
      details.push({ id: job.id, company: job.company, title: job.title, signal: verdict.signal });
    }
  }
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
  return { checked: candidates.length, closed, details };
}
