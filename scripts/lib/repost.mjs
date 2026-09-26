// Repost detection + title fuzzy matching.
// Adapted from career-ops detect-reposts.mjs / role-matcher.mjs (MIT), trimmed
// to what scan-time repost flagging needs: same company + fuzzy-same title +
// different URL within 90 days = the same opening re-listed.

// Tokens that almost every role shares must not count as matching signal.
const ROLE_STOPWORDS = new Set([
  // seniority / level — routinely added or dropped when a req is re-posted
  'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'head',
  'chief', 'associate', 'intern', 'entry', 'level',
  // contract / mode
  'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'freelance',
  'fulltime', 'parttime', 'permanent', 'temporary', 'internship',
  // generic job words
  'role', 'position', 'opportunity', 'team', 'based',
  // repost annotations
  'repost', 'reposted', 'relisted',
  // prepositions leaking through
  'with', 'from', 'into', 'over', 'the', 'and', 'for',
]);

const MTS_PREFIX = /\bmember\s+of\s+technical\s+staff\b/gi;

export function roleTokens(title) {
  const cleaned = String(title || '')
    .replace(MTS_PREFIX, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ');
  return [...new Set(cleaned.split(' ').filter(Boolean))].filter(
    (t) => t.length >= 2 && !ROLE_STOPWORDS.has(t)
  );
}

/**
 * Fuzzy title match: 2+ overlapping significant tokens, or 1 when both titles
 * are tiny. Seniority words are ignored — "Senior X" vs "X" is the classic
 * repost pattern, not a different opening.
 */
export function titleFuzzyMatch(a, b) {
  const ta = roleTokens(a);
  const tb = roleTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const overlap = ta.filter((t) => tb.includes(t)).length;
  const minTokens = Math.min(ta.length, tb.length);
  return overlap >= (minTokens === 1 ? 1 : 2);
}

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|company|co|gmbh|ag|bv|pty|plc|holdings|group|labs?|technologies|technology|software|solutions)\b\.?/gi;

/** Case/punctuation/suffix-insensitive company key: "Acme Inc." === "acme". */
export function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(COMPANY_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Count prior rows that look like a repost of `job`: same company key,
 * fuzzy-matching title, different URL, `found` within windowDays.
 * @returns {{count: number, ids: string[]}}
 */
export function findReposts(job, existingRows, { windowDays = 90, nowMs = Date.now() } = {}) {
  const key = companyKey(job.company);
  const ids = [];
  for (const row of existingRows) {
    if (String(row.id) === String(job.id)) continue;
    if (companyKey(row.company) !== key) continue;
    if (row.url === job.url) continue; // same posting = dedup's job, not a repost
    const found = row.found || '';
    const t = Date.parse(`${found.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(t) || nowMs - t > windowDays * 86_400_000) continue;
    if (titleFuzzyMatch(row.title, job.title)) ids.push(String(row.id));
  }
  return { count: ids.length, ids };
}
