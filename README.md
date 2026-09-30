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

**jobpilot does the repetitive parts so you can focus on the decisions.** You give it your resume once. After that you use five short commands:

```
/jobpilot:scan       → "What's new on the job boards?"
/jobpilot:match      → "Which of these actually fit me?"
/jobpilot:review 12  → "How would a recruiter see me for job #12?"
/jobpilot:contact 12 → "Who should I reach out to, and what do I say?"
/jobpilot:apply 12   → "Fill in the application for me, and I'll hit Submit."
```

> [!IMPORTANT]
> **It never applies on your behalf.** It fills in the form and then stops. You review it and click Submit yourself.

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

| Step | What it does | What you get |
|---|---|---|
| ⚙️ **setup** | Reads your resume, works out the roles, seniority and locations that suit you, and asks you to confirm. Then it searches for companies hiring for those roles | Your profile, plus a list of companies to watch that fits your field, not just big tech |
| 🔍 **scan** | Checks the career pages of every company on your list: 100+ to start with, plus companies it finds hiring for your target roles | New jobs in your tracker, with the date posted and pay when listed. Reposted jobs are flagged, closed ones are marked closed, and you're told when your filters are too narrow |
| 📊 **match** | Reads each job post next to your profile and scores the fit from 0 to 100 | A score you can check line by line: which requirements you meet, with a quote from your profile for each one |
| 🧐 **review** | Reads your profile the way that job's recruiter would | An **ATS score** out of 100 (job match plus readability) with every lost point explained, your strengths, honest gaps, rewritten bullet points, a check of which resume claims a recruiter could question, and an optional tailored resume PDF (with its new ATS score) |
| 🤝 **contact** | Looks up the likely recruiter or hiring manager | Who they are, how sure it is, and a LinkedIn note under 300 characters |
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

jobpilot reads your resume, suggests target roles, and asks you to confirm them. Then it searches the job boards for companies hiring for those roles and adds them to your list. That's the whole setup.

You don't need to name any companies. To find more later, ask: *"find more companies hiring for my roles"*.

### 3. Find jobs

```
/jobpilot:scan
/jobpilot:match
```

You get a ranked list like this *(example)*:

```
#4  · 86 · Figma    · Manager, Software Engineering – Data Platform · posted 3 days ago  · data infra + team lead match, NYC ok
#1  · 78 · Ramp     · Tech Lead and Manager, Production Engineering · posted 2 weeks ago · strong backend, fintech domain new
#12 · 40 · Palantir · Forward Deployed Engineer                     · posted today       · capped: on-site only
```

Pick one and keep going with `/jobpilot:review 4`.

---

## What it's good at, and what it won't do

✅ **It will:**
- Scan company job boards **for free**. Scanning uses no AI tokens, only public job-board data.
- Give you **honest** fit scores. If a job is a poor match, it says so.
- **Show its work.** Every score comes with the reasons behind it, so you can disagree with a specific line instead of a mystery number.
- Rewrite your resume bullets for a specific job and show every change as *before → after*.
- Warn you when a posting has already closed, before you spend time on it.
- Get better over time. Tell it when a score feels wrong, and after about 10 corrections it suggests how to reweigh what matters to you. Nothing changes until you say yes.

🚫 **It won't:**
- **Make things up.** Everything it writes comes from your resume or from something you told it. If a job asks for a skill you don't have, it's listed as a gap, not added to your resume. A built-in fact check blocks any tailored resume that mentions a number, company or skill your profile doesn't back.
- **Submit anything.** No applications, messages or emails get sent without you.
- **Follow instructions hidden in job posts.** Text in a posting or form that tries to give the AI orders is flagged to you and ignored.

---

## How the score works

<details>
<summary><b>What goes into the 0–100 fit score?</b></summary>

The AI reads the job post and lists its requirements. For each one it says whether you **meet** it, **partly** meet it, or **don't**, and it must quote your profile as proof. A plain script, not the AI, then adds everything up, so the same checklist always gives the same score.

| Part | Weight | What it looks at |
|---|---|---|
| Skills | 35 | How many of the job's requirements you meet. Must-haves count double |
| Seniority | 25 | Your level and years of experience compared with what the job asks |
| Domain | 15 | Whether you've worked in this kind of product or industry |
| Location | 15 | Remote, hybrid or on-site, compared with what you want |
| Pay | 10 | The listed salary compared with your minimum base pay and your minimum total pay |

Next to each score you'll see a short breakdown such as `S22/35 Sn20/25 D10/15 L15/15 C?/10`: the points earned out of each weight. A `?` means that information wasn't available, and it counts as neutral rather than zero.

**How pay is judged.** Job posts usually list base pay only, but offers include bonus and stock. So during setup jobpilot looks up real pay for your level at a sample of your companies and learns how much bigger total pay is than base at each kind of employer:
- **Tech:** levels.fyi
- **Finance:** levels.fyi or bonus surveys
- **Healthcare, government and nonprofits:** Glassdoor, Payscale or published pay scales, where total is usually close to base

You see the numbers before they're saved. A job whose base can't reach your minimum base scores low however big the bonus, and its breakdown shows `<base`. Estimates are marked `est.`.

**Deal-breakers** (on-site only when you want remote, sponsorship needed but not offered, a security clearance, a language you don't speak, or a big seniority mismatch) cap the score at 40, however good the rest looks.

**Two safety checks** catch the AI getting it wrong:
- A "meets it" answer without a real quote from your profile is downgraded to "partly".
- Every requirement must actually appear in the job post, and the score is compared with a simple keyword count. If either check fails, the job is re-checked.

</details>

<details>
<summary><b>What is the ATS score?</b></summary>

Most companies run resumes through an **applicant tracking system (ATS)**. It turns your file into text, and recruiters then search that text. No ATS publishes a match number, so jobpilot scores your resume itself: an **ATS-readiness and job-match score** (0–100) for one specific job. It's an audit, not a simulation of any one ATS.

| Part | Points | What it checks |
|---|---|---|
| Job requirements | 40 | Every requirement from the job's checklist (made by **match**), must-haves counting more than nice-to-haves. Credit depends on whether your profile backs it and how well the resume *shows* it |
| Skills and keywords | 25 | Must-have terms (15), nice-to-have terms (5), the job's vocabulary (5) |
| Title and experience | 15 | Job title wording in your role titles, seniority, relevant years against what the job asks, and whether your latest role is relevant |
| ATS parseability | 15 | Real text, standard headings, your employers recovered from the text, email and phone as plain text, newest role first, no garbled characters |
| Hygiene | 5 | PDF or DOCX, date ranges, contact info, length (two pages or fewer), no oddities |

**Proof beats a list.** A skill counts most when it appears in a role bullet with a result (a number), less in a summary, and least in a skills list. Tools you used long ago count less than ones you use now. Fundamentals like Python or SQL don't fade. Repeating a keyword never helps.

**Ceilings.** If the job lists a must-have that your profile can't back, the score is capped however good the file is: 79 for one, 69 for two, 59 for three or more. Change the caps with `ats: { caps: [79, 69, 59] }` in your `profile.md`.

**It needs `match`.** The requirements come from the checklist `match` saves for each job. Without one, that part is left out and the score says to run `match` first.

You see the score twice: once for your current resume and again for the tailored version, for example **58 → 79**, with each part before and after. Every lost point comes with a plain finding, ranked **critical**, **high**, **medium** and **format**.

Missing keywords are split into two lists:
- **Safe to add:** your experience backs them, so they can go in.
- **Gaps:** they're never added.

The tailored resume can only raise the score by showing what your profile already backs. It can't make you meet a requirement you don't.

</details>

<details>
<summary><b>How is the list ordered?</b></summary>

**Best matches first; among similar matches, newest first.**

Each job loses 1 point for every 5 days since it was posted, up to 10 points at most. A strong match that's been open for a while still ranks near the top; age only decides between jobs that fit about equally well. Jobs that have closed are marked closed by the scan rather than pushed down the list.

You can change this in `profile.md`:

```yaml
ranking: { days_per_point: 5, max_age_penalty: 10 }   # max_age_penalty: 0 turns it off
```
</details>

---

## Where your data lives

Everything stays on your computer, in one folder (`~/jobpilot/`) that plugin updates never touch:

```
~/jobpilot/
├── profile.md      ← your profile; every fact jobpilot uses comes from here
├── resume.pdf      ← your original resume
├── companies.yml   ← the companies to watch (edit it anytime)
├── jobs.csv        ← your tracker, which opens in Excel or Google Sheets
├── evals/          ← the reasons behind each job's score
├── claims.json     ← the resume claim check from review
└── out/
    └── 12-figma/   ← one folder per job: your tailored resume
                       (Jordan-Rivera-Resume.pdf), page previews, review notes
```

Each job has one of three statuses: **new → applied → closed**. When you hear back, record how it went (interview, rejected, offer or no reply); jobpilot uses that to check whether its high scores really lead to interviews.

Want the folder somewhere else? Set `JOBPILOT_HOME=/path/you/like`.

**Start over anytime** with `/jobpilot:reset`, for example for a new resume or a career change. Your current folder is moved to `~/jobpilot-backup-<date>` and setup runs again from scratch. Nothing is deleted, so you can always go back.

**Wipe everything** by asking for a permanent wipe (`node scripts/reset.mjs --wipe --yes`). It deletes the whole folder with no backup, application history included, and setup starts again from a new resume. It always asks you first and can't be undone.

---

## FAQ

<details>
<summary><b>Which job sites does it search?</b></summary>

Company career pages hosted on **Greenhouse**, **Lever** and **Ashby**, which together cover thousands of tech companies. It starts with 101 companies, including Stripe, Figma, Ramp and Palantir, all checked to be live, and adds more that fit your background during setup. You can add any company that uses one of these three systems to `companies.yml`.

LinkedIn, Indeed and Workday aren't supported yet. That matters most outside tech: many hospitals, banks and large companies post jobs on Workday, iCIMS or Taleo. Setup still finds the employers in your field that use Greenhouse, Lever or Ashby, but the list will be shorter than for tech roles.
</details>

<details>
<summary><b>Will a recruiter be able to check what's on my resume?</b></summary>

Some of it, yes, so `review` checks first. It breaks your resume into single claims (each job, date, degree, project and number) and checks that they agree with each other. With your permission, it also looks at your own links, such as GitHub or your website.

Each claim gets one of five plain labels:

| Label | Meaning |
|---|---|
| ✅ Matches the evidence | Something public backs it up |
| ⚪ Not enough evidence | Nothing contradicts it, but nothing public confirms it either |
| 🟡 Needs an explanation | A recruiter might ask about it, so have an answer ready |
| 🔴 Important details don't match | Something public says otherwise, such as different dates |
| ⚫ Unable to check | Private or confidential work, or no link to check |

"Not enough evidence" **does not mean false**. Most real work isn't public. For each flagged claim you get the question a recruiter might ask and a suggested fix: add a link, reword it, or prepare an answer. The results are private to you and never sent anywhere.
</details>

<details>
<summary><b>What's in a tailored resume?</b></summary>

A copy of your resume rewritten for one job, using **only facts already in your profile**:

- **What changes:** the summary is aimed at the role, the most relevant bullets move to the top and are reworded in the job's language, and the skills the job asks for (that you have) come first.
- **What never changes:** employers, titles, dates, degrees and numbers. Nothing new is added.
- **The look stays yours.** At setup, jobpilot measures your own resume PDF (font, sizes, colors, centered or left-aligned header, section order, bullet style, contact icons) and saves it as `resume_style` in `profile.md`. Every tailored resume is drawn in that style, so it looks like the one you already send. Merriweather is bundled; for other fonts the closest system serif or sans is used. Add `<name>-300/400/700.woff2` files to `fonts/` to bundle more. A resume in a different style gives a different look.

Before you see it, jobpilot checks it for you:

1. **Fact check.** Any number, date, company or skill that isn't in your profile stops the PDF from being made.
2. **Page check.** The PDF's real page count is checked. It must fit on 1 page if you have under 10 years of experience, or 2 pages otherwise (or your `max_pages`), and nothing may run off the edge. Over the limit, the least relevant bullets are cut and it's built again. The font is never shrunk to make it fit.
3. **Paper size.** Letter in the US and Canada, A4 elsewhere.
4. **ATS check.** The PDF is read back the way an applicant tracking system reads it, and scored. You see the score before and after, part by part, for example **58 → 79**.
5. **A look at every page**, so nothing is cut off and no heading is left alone at the bottom of a page.

The file is named after you (`Jordan-Rivera-Resume.pdf`), not the company, because recruiters see the file name and often forward it. Set `paper: a4` or `max_pages: 2` in `profile.md` to change the defaults.
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

Or your company list doesn't include anyone hiring for your roles right now. Ask jobpilot to *"find more companies for my resume"*. It searches the job boards for your target titles and adds only companies with a matching opening.

Every scan also lists **near misses**: job titles at your target locations that your filter skipped but that share words with the roles you want. It tells you exactly which wording to add, so you don't have to guess.
</details>

---

## Credits

- Parts of the job-board scanning, PDF rendering and closed-posting detection are adapted from [career-ops](https://github.com/santifer/career-ops) by santifer (MIT).
- The resume claim check in `review` comes from [resume-claim-verification](https://github.com/Krutarth22/resume-claim-verification), a companion project by the same author for the recruiter side.

**Coming later:** more job sources (LinkedIn, Workday), scheduled scans, and cover letters.

MIT licensed. See [LICENSE](LICENSE).
