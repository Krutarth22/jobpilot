// Closed-posting sweep (B4). Runs the ATS-API-first liveness check over
// `new` and `applied` rows and marks expired ones `closed`. Never touches
// rows whose liveness is uncertain — silence is not evidence.

import { readJobs, writeJobs, updateJobs, STATUSES } from './workspace.mjs';
import { checkViaApi, checkUrl } from '../liveness.mjs';

export const SWEEP_DEFAULT_LIMIT = 40;

/** Check one posting; returns {verdict, signal} | null when undecidable. */
export async function checkPosting(url) {
  const api = await checkViaApi(url);
  if (api) return api;
  return checkUrl(url);
}

/**
 * Sweep new/applied rows (oldest `found` first, bounded). Returns counts and
 * writes status updates + notes for expired rows.
 */
export async function sweepClosed(root, { limit = SWEEP_DEFAULT_LIMIT, statuses = ['new', 'applied'], now = new Date().toISOString().slice(0, 10) } = {}) {
  const jobs = readJobs(root);
  const candidates = jobs
    .filter((j) => statuses.includes(j.status))
    .sort((a, b) => String(a.found).localeCompare(String(b.found)))
    .slice(0, limit);

  let closed = 0;
  const details = [];
  for (const job of candidates) {
    const verdict = await checkPosting(job.url);
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
  return { checked: candidates.length, closed, details };
}
