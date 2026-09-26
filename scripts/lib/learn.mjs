// Learning from the user (D2–D4). Pure functions over evals/<id>.json files
// and jobs.csv — no network, no AI.

// ── Feedback rows (D1 storage shape lives in jobs.mjs) ─────────────────

/**
 * Rows that have both a computed score (with components) and user feedback.
 * @returns {Array<{id, userScore, why, components: {skills, seniority, domain, location, comp}, outcome}>}
 */
export function feedbackRows(evals) {
  const rows = [];
  for (const ev of evals) {
    const fb = ev?.feedback;
    const comps = ev?.score?.components;
    const hasAnyScore = comps && Object.values(comps).some((c) => c && Number.isFinite(c.pct));
    if (!fb?.user_score || !hasAnyScore) continue;
    const pct = (key) => {
      const c = comps[key];
      return c && Number.isFinite(c.pct) ? c.pct / 100 : 0.5; // null → neutral
    };
    rows.push({
      id: ev.id,
      userScore: Number(fb.user_score),
      why: String(fb.why || ''),
      components: {
        skills: pct('skills'),
        seniority: pct('seniority'),
        domain: pct('domain'),
        location: pct('location'),
        comp: pct('comp'),
      },
      outcome: ev.outcome || '',
    });
  }
  return rows;
}

// ── D2: constrained least squares ───────────────────────────────────────

const KEYS = ['skills', 'seniority', 'domain', 'location', 'comp'];

function predict(row, w) {
  let s = 0;
  for (const k of KEYS) s += w[k] * row.components[k];
  return s;
}

function mae(rows, w) {
  if (rows.length === 0) return null;
  return rows.reduce((acc, r) => acc + Math.abs(predict(r, w) - r.userScore), 0) / rows.length;
}

/**
 * Fit the 5 weights (non-negative, sum 100) minimizing the gap between the
 * predicted fit and the user's scores. Unconstrained normal equations via
 * Gaussian elimination, then projected (clip to ≥0, renormalize) until stable
 * — deterministic, and 5 dimensions make the projection converge immediately.
 * With no rows, returns the current weights unchanged.
 * @param {Array} rows feedbackRows() output
 * @param {object} currentWeights the profile's weights (fallback/floor)
 */
export function fitWeights(rows, currentWeights = {}) {
  const current = {};
  let sum = 0;
  for (const k of KEYS) {
    const v = Number(currentWeights[k]);
    current[k] = Number.isFinite(v) && v > 0 ? v : 0;
    sum += current[k];
  }
  if (sum <= 0) for (const k of KEYS) current[k] = 20;
  if (!Array.isArray(rows) || rows.length < 3) {
    return { weights: { ...current }, maeBefore: mae(rows, current), maeAfter: mae(rows, current), rows: rows.length, converged: true, trivial: true };
  }

  // Normal equations: (AᵀA) w = Aᵀb, where A row = component vector, b = user score.
  const n = KEYS.length;
  const ata = Array.from({ length: n }, () => new Array(n).fill(0));
  const atb = new Array(n).fill(0);
  for (const row of rows) {
    const x = KEYS.map((k) => row.components[k]);
    for (let i = 0; i < n; i++) {
      atb[i] += x[i] * row.userScore;
      for (let j = 0; j < n; j++) ata[i][j] += x[i] * x[j];
    }
  }
  // Tikhonov nudge for collinear columns (e.g. two signals always equal).
  for (let i = 0; i < n; i++) ata[i][i] += 1e-6;

  // Gaussian elimination with partial pivoting.
  const m = ata.map((row, i) => [...row, atb[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  let w = {};
  for (let i = 0; i < n; i++) w[KEYS[i]] = Math.abs(m[i][i]) > 1e-12 ? m[i][n] / m[i][i] : 0;

  // Project: clip negatives, renormalize to sum 100, repeat until stable.
  for (let iter = 0; iter < 50; iter++) {
    for (const k of KEYS) w[k] = Math.max(0, w[k]);
    const s = KEYS.reduce((acc, k) => acc + w[k], 0);
    if (s <= 1e-9) { w = { ...current }; break; }
    for (const k of KEYS) w[k] = (w[k] / s) * 100;
    const before = KEYS.map((k) => w[k]);
    for (const k of KEYS) w[k] = Math.max(0, w[k]);
    if (KEYS.every((k, i) => Math.abs(w[k] - before[i]) < 1e-9)) break;
  }
  const rounded = {};
  let rsum = 0;
  for (const k of KEYS) { rounded[k] = Math.round(w[k]); rsum += rounded[k]; }
  rounded[KEYS[0]] += 100 - rsum; // exact sum 100, absorbing rounding drift

  return {
    weights: rounded,
    maeBefore: mae(rows, current),
    maeAfter: mae(rows, rounded),
    rows: rows.length,
    converged: true,
    trivial: false,
  };
}

// ── D3: learned preferences ─────────────────────────────────────────────

const PREFERENCE_SIGNALS = [
  { pattern: /\bon[- ]?site\b/i, suggestion: 'locations.remote: required', field: 'locations' },
  { pattern: /\bhybrid\b/i, suggestion: 'locations.remote: preferred (hybrid acceptable)', field: 'locations' },
  { pattern: /\bsponsorship|visa\b/i, suggestion: 'deal_breakers.needs_sponsorship', field: 'deal_breakers' },
  { pattern: /\bclearance\b/i, suggestion: 'deal_breakers.clearance', field: 'deal_breakers' },
  { pattern: /\b(?:salary|comp|pay|too low|underpaid)\b/i, suggestion: 'comp.min_total (raise the floor)', field: 'comp' },
];

/** Recurring themes in feedback reasons → proposed profile lines. The user
 * confirms before anything is written. */
export function suggestPreferences(rows, { minCount = 3 } = {}) {
  const counts = [];
  for (const { pattern, suggestion, field } of PREFERENCE_SIGNALS) {
    const hits = rows.filter((r) => pattern.test(r.why)).length;
    if (hits >= minCount) counts.push({ suggestion, field, hits });
  }
  return counts;
}

// ── D4: scoring health ──────────────────────────────────────────────────

export const MIN_OUTCOMES_FOR_HEALTH = 15;

/** Interview rate by fit bucket (80+, 60–79, <60). */
export function statsByBucket(jobs) {
  const buckets = {
    '80+': { applied: 0, interview: 0 },
    '60-79': { applied: 0, interview: 0 },
    '<60': { applied: 0, interview: 0 },
  };
  for (const job of jobs) {
    const fit = job.fit === '' ? NaN : Number(job.fit); // '' is 0 to Number() — unscored rows must not count
    if (!Number.isFinite(fit) || !job.outcome) continue;
    const bucket = fit >= 80 ? '80+' : fit >= 60 ? '60-79' : '<60';
    buckets[bucket].applied++;
    if (job.outcome === 'interview') buckets[bucket].interview++;
  }
  const total = Object.values(buckets).reduce((a, b) => a + b.applied, 0);
  const result = { buckets, totalOutcomes: total, healthy: null };
  if (total >= MIN_OUTCOMES_FOR_HEALTH) {
    const rates = Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, b.applied > 0 ? b.interview / b.applied : null]));
    // Miscalibrated: the top bucket's interview rate is not the highest.
    result.rates = Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, v === null ? null : Math.round(v * 100) / 100]));
    result.healthy = (rates['80+'] ?? 0) >= (rates['60-79'] ?? 0) && (rates['60-79'] ?? 0) >= (rates['<60'] ?? 0);
  }
  return result;
}
