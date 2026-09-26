// Rank = fit − a small, capped age penalty.
//
// Best matches first; among similar matches, newest first. A posting loses
// 1 point per 5 days since `posted` (falling back to `found`), capped at 10,
// so age breaks ties but never sinks a strong match that's still open —
// closed postings are removed by the sweep, not by decay. (A multiplicative
// decay did: fit 84 at 46 days ranked 8, below any fresh fit-10 job.)
// Pay is NOT a separate factor: fit already carries the comp component.
// Unknown dates cost nothing — ranking never guesses.
//
// Tunable per user in profile.md: `ranking: { days_per_point: 5, max_age_penalty: 10 }`.

export const DAYS_PER_POINT = 5;
export const MAX_AGE_PENALTY = 10;

export function ageDays(postedIso, nowMs = Date.now()) {
  const t = Date.parse(`${String(postedIso ?? '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

function rankingOptions(opts = {}) {
  const perPoint = Number(opts.days_per_point);
  const cap = opts.max_age_penalty == null ? NaN : Number(opts.max_age_penalty);
  return {
    daysPerPoint: perPoint > 0 ? perPoint : DAYS_PER_POINT,
    maxPenalty: cap >= 0 ? cap : MAX_AGE_PENALTY, // 0 turns the age penalty off
  };
}

/** Points lost to age; missing/invalid date → 0 (neutral). */
export function agePenalty(postedIso, nowMs = Date.now(), opts = {}) {
  const days = ageDays(postedIso, nowMs);
  if (days === null) return 0;
  const { daysPerPoint, maxPenalty } = rankingOptions(opts);
  return Math.min(maxPenalty, days / daysPerPoint);
}

/** rank = fit − penalty, 0–100 rounded; unscored → 0. */
export function rankOf(fit, penalty) {
  if (fit === '' || fit == null || Number.isNaN(Number(fit))) return 0;
  const n = Number(fit);
  return Math.max(0, Math.round(n - penalty));
}

/**
 * Compute ranks for all jobs and return them sorted best-first. Unscored
 * jobs (rank 0) come out newest-first, so `match` scores the newest
 * postings before the stale ones. Does not write — callers decide.
 */
export function rankAll(jobs, nowMs = Date.now(), opts = {}) {
  const ranked = jobs.map((job) => {
    const date = job.posted || job.found || '';
    const age = ageDays(date, nowMs);
    return { job, rank: rankOf(job.fit, agePenalty(date, nowMs, opts)), age: age ?? 0 };
  });
  ranked.sort((a, b) => b.rank - a.rank
    || a.age - b.age
    || String(a.job.id).localeCompare(String(b.job.id), undefined, { numeric: true }));
  return ranked;
}
