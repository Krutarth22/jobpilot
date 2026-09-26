# Claim self-check rubric

Adapted from the resume-claim-verification skill's assessment rubric and
report schema (https://github.com/Krutarth22/resume-claim-verification, MIT)
for the opposite seat: here the user is checking their **own** resume before
a recruiter does, not a reviewer checking someone else's. The neutral framing
rules are unchanged — this is never a fraud, authenticity, or hiring verdict.

## Claim assessments

| Internal value | Plain label | Use when | Do not use when |
|---|---|---|---|
| Supported | Matches the evidence | Something you can point to (your own repo history, a live artifact, a publication, another part of the resume) agrees with the material parts of the claim. | The evidence only shows a company, project, or credential exists — not that you did the specific thing claimed. |
| Plausible but unverified | Not enough evidence | The claim is coherent and nothing conflicts, but you don't have independent backing handy (a private repo, confidential work, an old role with no public trace). | Something directly contradicts it, or you never actually checked. |
| Needs clarification | Needs an explanation | The wording, scope, ownership, dates, or a metric is ambiguous, and a recruiter would likely ask a follow-up. | The only issue is that you have no online presence for it. |
| Material inconsistency | Important details don't match | Something you can point to directly conflicts with a material part of the claim (e.g. the resume says "led the migration" but you were one of three contributors and joined after it started). | The difference is harmless rounding, a renamed team, a title normalization, or an uncertain match. |
| Not assessable | Unable to check | You have no link, no artifact, and no way to check it yourself (e.g. confidential work with no public trace, and no link was provided in `profile.md`'s `links`). | You could check it but haven't. |

## Confidence

- High: you have a direct, checkable artifact (a commit history you can open, a live URL, a document) and no ambiguity.
- Medium: the backing is indirect or partial, or a plausible alternative reading exists.
- Low: sparse or no independent backing; you're going mostly on memory.

Confidence describes how sure the *assessment* is — never how honest you are.

## Overall conclusion

- `No material issues found` — nothing material is inconsistent; some claims may still be unverified.
- `Clarification recommended` — one or more claims would benefit from a tighter wording or a link, no direct conflict.
- `Human review recommended` — at least one `Material inconsistency`, or the evidence is unusually tangled.
- `Insufficient evidence` — most claims couldn't be checked at all (e.g. no links exist yet).

This routes what you do next (reword a bullet, add a link, prep an answer) — it is not a score.

## Percentage profile

Percentages are `claims in category / total claims`, rounded to whole numbers with the largest-remainder method so the five values sum to 100. Show raw counts next to the percentage. State plainly that "unverified does not mean false," and that only `Material inconsistency` reflects a direct conflict — never combine the five into a single "risk" or "authenticity" number.

## Prohibited fields and conclusions

Never add a field representing `fake`, `fraud`, `score`, `hire`, `ranking`, or a protected trait — `claims.mjs validate` rejects these by key-name substring match, recursively. Never state or imply that a claim is a lie, fraud, or that you should/shouldn't be hired — `validate` rejects the summary and each claim's inference against the same phrase patterns the upstream skill uses.

## Standard limitations

Always appended, even if not written into the input JSON:

- Finding nothing online does not mean the claim is false.
- Private or confidential work may be impossible to confirm from public sources.
- A matching name or profile may belong to someone else.
- This report does not prove that anyone lied or committed fraud. A person must make every hiring decision.

## Required neutral framing

- "The available evidence supports/conflicts with the claim," not "I was truthful/dishonest."
- "Could not be independently verified," not "didn't happen."
- Keep benign alternatives on the table (a renamed team, contracting, a migrated repo, a stale profile) when the circumstances support them.

## The self-check twist

- `candidate_label` is always forced to `"You"` — this file is never about a third party.
- Only your **own** links (from `profile.md`'s `links:` front matter — GitHub, personal site, LinkedIn, `other`) are in scope. A missing link never counts against a claim; it makes that claim `Not assessable`.
- Any wider web search needs your go-ahead first, and a search-result snippet is never itself evidence — only something you can actually open and check counts.
