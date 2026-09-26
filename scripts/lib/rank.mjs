// Rank = fit × freshness.
//
// Fit alone ranks a 6-week-old posting next to one posted this morning.
// Freshness decays with a ~14-day half-life from `posted` (falling back to
// `found`). Pay is NOT a separate factor here: fit already carries the comp
// component (score.mjs), and multiplying by it again would count pay twice.
// Unknown dates are neutral (1.0) — ranking never guesses.

export const HALF_LIFE_DAYS = 14;

function daysBetween(fromIso, nowMs) {
  const t = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

/** Exponential decay with a half-life; missing/invalid date → 1.0 (neutral). */
export function freshness(postedIso, nowMs = Date.now(), halfLifeDays = HALF_LIFE_DAYS) {
  const days = daysBetween(postedIso, nowMs);
  if (days === null) return 1.0;
  return Math.pow(0.5, days / halfLifeDays);
}

/** rank = fit × freshness, 0–100 rounded. */
export function rankOf(fit, fresh) {
  return Math.round((Number(fit) || 0) * fresh);
}

/**
 * Compute ranks for all jobs and return them sorted best-first. Unscored
 * jobs (rank 0) come out freshest-first, so `match` scores the newest
 * postings before the stale ones. Does not write — callers decide.
 */
export function rankAll(jobs, nowMs = Date.now()) {
  const ranked = jobs.map((job) => {
    const fresh = freshness(job.posted || job.found || '', nowMs);
    return { job, rank: rankOf(job.fit, fresh), freshness: fresh };
  });
  ranked.sort((a, b) => b.rank - a.rank
    || b.freshness - a.freshness
    || String(a.job.id).localeCompare(String(b.job.id), undefined, { numeric: true }));
  return ranked;
}
