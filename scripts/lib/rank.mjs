// Rank = fit × freshness × comp_factor.
//
// Fit alone ranks a 6-week-old posting next to one posted this morning.
// Freshness decays with a ~14-day half-life from `posted` (falling back to
// `found`); comp_factor nudges postings whose (total-comp estimated) salary
// clears the profile's floor. Unknown signals are neutral (1.0) — ranking
// never guesses.

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

/**
 * Salary vs the profile's floor: at/above → 1.0, 70–100% → 0.8–1.0,
 * below 70% → scaled toward 0. Unknown salary → 1.0 (neutral).
 * @param {{min:number,max:number,currency}|null} salary
 * @param {{currency?:string, min_total?:number}} comp
 */
export function compFactor(salary, comp = {}) {
  const minTotal = Number(comp?.min_total);
  if (!salary || !Number.isFinite(minTotal) || minTotal <= 0) return 1.0;
  if (comp?.currency && salary.currency && comp.currency !== salary.currency) return 1.0; // don't compare across currencies
  const mid = (salary.min + salary.max) / 2;
  const r = mid / minTotal;
  if (r >= 1) return 1.0;
  if (r >= 0.7) return 0.8 + ((r - 0.7) / 0.3) * 0.2;
  return (r / 0.7) * 0.8;
}

/** rank = fit × freshness × compFactor, 0–100 rounded. */
export function rankOf(fit, fresh, compF) {
  return Math.round((Number(fit) || 0) * fresh * compF);
}

import { parseSalaryColumn } from './signals.mjs';

/**
 * Compute ranks for all jobs (in place) and return them sorted best-first.
 * Uses the salary column (see signals.parseSalaryColumn) and the profile's
 * comp block. Does not write — callers decide.
 */
export function rankAll(jobs, profile, nowMs = Date.now()) {
  const comp = profile?.comp || {};
  const ranked = jobs.map((job) => {
    const posted = job.posted || job.found || '';
    const fresh = freshness(posted, nowMs);
    const salary = job.salary ? parseSalaryColumn(job.salary) : null;
    const cf = compFactor(salary, comp);
    return { job, rank: rankOf(job.fit, fresh, cf), freshness: fresh, compFactor: cf };
  });
  ranked.sort((a, b) => b.rank - a.rank || String(a.job.id).localeCompare(String(b.job.id), undefined, { numeric: true }));
  return ranked;
}
