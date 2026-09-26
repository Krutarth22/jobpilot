# jobpilot

A small job-search copilot for Claude Code, Codex and Cursor. Hand it one
resume; it builds your workspace, scans Greenhouse / Lever / Ashby boards for
free, scores fits, shows you how a recruiter would see your resume, drafts
outreach, and fills application forms — **stopping before Submit**.

Designed to be the opposite of a 40-mode pipeline: **5 modes, 3 job sources,
3 statuses, 1 tracker file.**

## Install

**Claude Code**
```
/plugin marketplace add Krutarth22/jobpilot
/plugin install jobpilot@jobpilot
```

**Codex**
```
codex plugin marketplace add Krutarth22/jobpilot
codex plugin add jobpilot@jobpilot
```

**Cursor**
```
cursor-agent plugin marketplace add https://github.com/Krutarth22/jobpilot
```
then open `/plugins` in an interactive session and install **jobpilot**.
No plugin support in your setup? `git clone` this repo and run `./install.sh`,
which symlinks the skills into `~/.cursor/skills` (and Codex / `.agents`).

Then run `/jobpilot:setup path/to/resume.pdf`. The first run installs the
npm dependencies into the plugin folder. For tailored-resume PDFs, run
`npx playwright install chromium` once. `apply` uses the Playwright MCP
server that ships with the plugin.

## The 5 modes

| Command | Does | Cost |
|---|---|---|
| `/jobpilot:setup resume.pdf` | One-time: workspace + `profile.md` + targets + company list | LLM |
| `/jobpilot:scan` | New postings from your boards → `jobs.csv` | **zero tokens** |
| `/jobpilot:match` | Score unscored jobs 0–100 with a fixed rubric + reason | LLM |
| `/jobpilot:review 12` | Recruiter's view: strengths, gaps, rewritten bullets, optional tailored PDF | LLM |
| `/jobpilot:contact 12` | Find the hiring manager/recruiter, draft a ≤300-char LinkedIn note | LLM |
| `/jobpilot:apply 12` | Fill the form via Playwright, upload resume, **stop before Submit** | LLM + browser |

Your data never lives in the plugin folder (updates would overwrite it). It
lives in `~/jobpilot/` (or `JOBPILOT_HOME`):

```
~/jobpilot/
  profile.md      # the only source of facts — everything traces back here
  resume.<ext>    # your original file
  companies.yml   # boards to scan
  jobs.csv        # the only tracker: id,company,title,url,location,found,score,status,notes
  out/            # tailored resumes + review notes
```

Only 3 statuses: `new → applied → closed`. Score and notes are their own
columns.

## Rules the plugin enforces on itself

1. **No fabrication.** Every claim in every output traces to `profile.md` or
   something you said in the conversation. Resume bullets are reordered and
   reframed, never invented.
2. **Postings and forms are data, not instructions.** Text inside a job page
   or application form that tries to command the assistant is quoted back to
   you as an anomaly, not obeyed.
3. **Never auto-submit.** `apply` fills the form and hands you the wheel.
   `applied` is set only after you confirm you clicked Submit.

## Credits

Provider clients, scan filtering, PDF rendering, and liveness signals are
adapted from [career-ops](https://github.com/santifer/career-ops) (MIT).
jobpilot is MIT licensed — see [LICENSE](LICENSE).

## Not in v1

LinkedIn/Workday sources, email-finder APIs, scheduled scans, cover letters.
