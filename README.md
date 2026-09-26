<div align="center">

# 🧭 jobpilot

**Your AI job-search copilot. Give it your resume, and it finds jobs, tells you which ones fit, and helps you apply.**

Works inside **Claude Code**, **Codex** and **Cursor**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18.17+](https://img.shields.io/badge/node-%E2%89%A518.17-green.svg)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)
![Codex](https://img.shields.io/badge/Codex-plugin-black.svg)
![Cursor](https://img.shields.io/badge/Cursor-plugin-555.svg)

</div>

---

## What is this?

Job hunting has a lot of repetitive work: checking career pages, reading long job posts, guessing whether you're a fit, rewriting your resume and filling in the same form fields again and again.

**jobpilot handles the repetitive parts so you can focus on the decisions.** You give it your resume once. After that you use a few short commands:

```
/jobpilot:scan       → "What's new on the job boards?"
/jobpilot:match      → "Which of these actually fit me?"
/jobpilot:review 12  → "How would a recruiter see me for job #12?"
/jobpilot:contact 12 → "Who should I reach out to, and what do I say?"
/jobpilot:apply 12   → "Fill in the application for me, and I'll hit Submit."
```

**It never applies on your behalf.** It fills in the form and then stops. You review it and click Submit yourself.

---

## How it works

```mermaid
flowchart LR
    A["📄 Your resume<br/>(PDF or DOCX)"] --> B["⚙️ setup<br/>one time"]
    B --> C["🔍 scan<br/>find new jobs"]
    C --> D["📊 match<br/>score each job 0–100"]
    D --> E["🧐 review<br/>recruiter's view +<br/>tailored resume"]
    E --> F["🤝 contact<br/>who to message"]
    E --> G["📝 apply<br/>fills the form"]
    G --> H(["✋ You click Submit"])
```

| Step | What happens | What you get |
|---|---|---|
| ⚙️ **setup** | Reads your resume and works out which roles, seniority and locations fit you, then asks you to confirm | Your profile, plus a list of companies to watch |
| 🔍 **scan** | Checks the job boards of every company on your list | New jobs added to your tracker |
| 📊 **match** | An AI reads the job description and your profile and writes an **evidence-backed checklist** (every "met" verdict must quote your profile); a deterministic script turns that checklist into the score. Skills, seniority, domain, location and pay — with hard caps for deal-breakers | A fit score plus a per-signal breakdown (e.g. `S22/35 Sn20/25 D10/15 L15/15 C?/10`), stored in `evals/<id>.json` so you can audit exactly why a job scored what it did |
| 🧐 **review** | Reads your profile the way that job's recruiter would | Your strengths, honest gaps, missing keywords, rewritten bullet points, and an optional tailored resume PDF |
| 🤝 **contact** | Looks up the likely recruiter or hiring manager | Who they are, why they're the right person, and a LinkedIn note under 300 characters |
| 📝 **apply** | Opens the real application form in a browser and fills it in from your profile | A filled form, a screenshot, and a list of the fields it couldn't answer. **It stops before Submit.** |

---

## Quick start (about 2 minutes)

### 1. Install the plugin

<details open>
<summary><b>Claude Code</b></summary>

```
/plugin marketplace add Krutarth22/jobpilot
/plugin install jobpilot@jobpilot
```
</details>

<details>
<summary><b>Codex</b></summary>

```
codex plugin marketplace add Krutarth22/jobpilot
codex plugin add jobpilot@jobpilot
```
</details>

<details>
<summary><b>Cursor</b></summary>

```
cursor-agent plugin marketplace add https://github.com/Krutarth22/jobpilot
```
Then open `/plugins` in an interactive Cursor session and install **jobpilot**.
</details>

<details>
<summary><b>Anything else (manual install)</b></summary>

```
git clone https://github.com/Krutarth22/jobpilot
cd jobpilot && ./install.sh
```
This links the skills into your CLI's skills folder.
</details>

### 2. Give it your resume

```
/jobpilot:setup ~/Downloads/my-resume.pdf
```

jobpilot reads your resume, suggests target roles and companies, and asks you to confirm them. That's the whole setup.

### 3. Find jobs

```
/jobpilot:scan
/jobpilot:match
```

You get a ranked list like this *(example)*:

```
#4  · 86 · Figma    · Manager, Software Engineering – Data Platform · data infra + team lead match, NYC ok
#1  · 78 · Ramp     · Tech Lead and Manager, Production Engineering · strong backend, fintech domain new
#12 · 41 · Palantir · Forward Deployed Engineer                     · seniority mismatch, on-site only
```

Pick one and keep going with `/jobpilot:review 4`.

---

## What it's good at, and what it won't do

✅ **It will:**
- Scan company job boards **for free**. Scanning uses no AI tokens, only public job-board data.
- Give you **honest** fit scores. If a job is a poor match, it says so.
- Rewrite your resume bullets for a specific job and show every change as *before → after*.
- Warn you when a posting has already closed, before you spend time on it.

🚫 **It won't:**
- **Make things up.** Everything it writes comes from your resume or from something you told it. If a job asks for a skill you don't have, it's listed as a gap, not added to your resume.
- **Submit anything.** No applications, messages or emails get sent without you.
- **Follow instructions hidden in job posts.** Text in a posting or form that tries to give the AI orders is flagged to you and ignored.

---

## Where your data lives

Everything stays on your computer, in one folder (`~/jobpilot/`) that plugin updates never touch:

```
~/jobpilot/
├── profile.md      ← your profile; every fact jobpilot uses comes from here
├── resume.pdf      ← your original resume
├── companies.yml   ← the companies to watch (edit it anytime)
├── jobs.csv        ← your tracker, which opens in Excel or Google Sheets
└── out/            ← tailored resumes and review notes
```

Each job has one of three statuses: **new → applied → closed**.

Want the folder somewhere else? Set `JOBPILOT_HOME=/path/you/like`.

---

## FAQ

<details>
<summary><b>Which job sites does it search?</b></summary>

Company career pages hosted on **Greenhouse**, **Lever** and **Ashby**, which together cover thousands of tech companies. It starts with about 40 companies, including Stripe, Figma, Ramp and Palantir, and adds more that fit your background during setup. You can add any company that uses one of these three systems to `companies.yml`.

LinkedIn, Indeed and Workday aren't supported yet.
</details>

<details>
<summary><b>Does it cost anything?</b></summary>

The plugin is free and open source. `scan` uses **no AI tokens**. The other commands use your existing Claude, Codex or Cursor plan, like any other prompt.
</details>

<details>
<summary><b>Can it apply to 100 jobs for me automatically?</b></summary>

No, and that's on purpose. Mass-applying gets ignored by recruiters and can get your accounts flagged. jobpilot helps you send **fewer, better** applications. It does the typing, and you make the final call.
</details>

<details>
<summary><b>What do I need installed?</b></summary>

- **Node.js 18.17 or newer**. The first command installs everything else it needs.
- For tailored PDF resumes, run this once: `npx playwright install chromium`
- `apply` uses the Playwright browser tool that comes with the plugin.
</details>

<details>
<summary><b>The scan found nothing. What now?</b></summary>

Your title filter is probably too narrow. Open `companies.yml` and add more wordings under `title_filter.positive`. Use `+` to require words in any order: `manager + engineering` matches both *"Engineering Manager"* and *"Manager, Software Engineering"*. Or ask jobpilot: *"broaden my scan filters"*.
</details>

---

## Credits

Parts of the job-board scanning, PDF rendering and closed-posting detection are adapted from [career-ops](https://github.com/santifer/career-ops) by santifer (MIT).

**Coming later:** more job sources (LinkedIn, Workday), scheduled scans, and cover letters.

MIT licensed. See [LICENSE](LICENSE).
