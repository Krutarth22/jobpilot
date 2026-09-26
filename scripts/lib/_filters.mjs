// Title and location filter compilation for scan.
// Adapted from career-ops scan.mjs (MIT) — only the small reusable part.

// Compile a lowercased keyword into a matcher. Short all-letter acronyms
// (2-3 chars: ai, ml, vp…) match on WORD BOUNDARIES so "AI" never matches
// "Maintain". Multi-word phrases keep fast substring matching.
export function compileKeyword(kw) {
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = new RegExp(`\\b${kw}\\b`);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

// An AND-group: " + " between terms means EVERY term must appear in the
// title, in any order. A bare split('+') would butcher "C++", so the
// separator requires surrounding whitespace on purpose.
const AND_SEPARATOR = /\s+\+\s+/;

export function compilePositiveKeyword(keyword) {
  if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
  const terms = keyword.split(AND_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileKeyword(keyword);
  const matchers = terms.map(compileKeyword);
  return (lower) => matchers.every((m) => m(lower));
}

function normalizeList(arr, compile) {
  return (Array.isArray(arr) ? arr : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .map(compile);
}

/** @returns {(title: string) => boolean} */
export function buildTitleFilter(titleFilter) {
  const positive = normalizeList(titleFilter?.positive, compilePositiveKeyword);
  const negative = normalizeList(titleFilter?.negative, compileKeyword); // a veto is never an AND-group
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((m) => m(lower));
    const hasNegative = negative.some((m) => m(lower));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ────────────────────────────────────────────────────
// Case-insensitive word-boundary matching, in this order:
//   - empty/missing location → pass (don't penalize missing provider data)
//   - always_allow matches → pass (beats block: "Remote, Belgium or France"
//     passes when home region is allowed even though "france" is blocked)
//   - block matches → reject
//   - allow empty → pass; allow non-empty → must match one keyword
//
// Word boundaries via lookarounds rather than \b so keywords with punctuation
// edges still anchor. This is what keeps "india" from rejecting
// "Indianapolis" (a real US location) — plain includes() got that wrong.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileLocationKeyword(kw) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(kw)}(?![\\p{L}\\p{N}])`, 'u');
  return (lower) => re.test(lower);
}

/** @returns {(location: string) => boolean} */
export function buildLocationFilter(locationFilter) {
  const alwaysAllow = normalizeList(locationFilter?.always_allow, compileLocationKeyword);
  const block = normalizeList(locationFilter?.block, compileLocationKeyword);
  const allow = normalizeList(locationFilter?.allow, compileLocationKeyword);

  return (location) => {
    const raw = typeof location === 'string' ? location : '';
    const lower = raw.trim().toLowerCase();
    if (!lower) return true;
    if (alwaysAllow.some((m) => m(lower))) return true;
    if (block.some((m) => m(lower))) return false;
    if (allow.length === 0) return true;
    return allow.some((m) => m(lower));
  };
}
