#!/usr/bin/env node
// jobpilot jobs — the only tracker is jobs.csv. Read, fetch descriptions,
// score, and set status from here.
//
//   jobs.mjs list [--status new|applied|closed] [--unscored]
//   jobs.mjs show <id>
//   jobs.mjs get <id> --jd        fetch + print the full job description
//   jobs.mjs score <id> <0-100> "<reason>"
//   jobs.mjs status <id> <new|applied|closed>
//   jobs.mjs note <id> "<text>"      appends to notes (never overwrites)

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  workspaceRoot, readJobs, updateJobs, findJob, STATUSES,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import * as greenhouse from './providers/greenhouse.mjs';
import * as lever from './providers/lever.mjs';
import * as ashby from './providers/ashby.mjs';

const PROVIDERS = { greenhouse, lever, ashby };

const usage = (msg) => {
  if (msg) console.error(`⚠️  ${msg}`);
  console.error('Usage: jobs.mjs <list|show|get|score|status|note> ...');
  process.exit(1);
};

function findEntry(companies, companyName) {
  return companies.find((c) => c.name.toLowerCase() === String(companyName).toLowerCase());
}

/** Strip HTML to readable text (greenhouse content is HTML, often escaped). */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Greenhouse returns double-encoded content ("&lt;div&gt;"), so decode
    // tag-bracketing entities BEFORE stripping tags — the other order would
    // decode them back into literal tags that survive the strip.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function fetchDescription(root, job) {
  const companies = yaml.load(await readFile(`${root}/companies.yml`, 'utf8')).companies || [];
  const entry = findEntry(companies, job.company);
  if (!entry || !PROVIDERS[entry.provider]) {
    throw new Error(`companies.yml has no ${entry?.provider || 'known-provider'} entry for "${job.company}" — add one to fetch descriptions`);
  }
  const provider = PROVIDERS[entry.provider];
  const jobId = entry.provider === 'greenhouse' ? greenhouse.jobIdFromUrl(job.url) : null;
  if (entry.provider === 'greenhouse' && !jobId) {
    throw new Error(`can't find a Greenhouse job id in ${job.url} — fetch the posting page instead`);
  }
  const text = await provider.fetchDescription(entry, jobId, { url: job.url });
  return entry.provider === 'greenhouse' ? htmlToText(text) : text;
}

function printJob(job) {
  const width = Math.max(...Object.keys(job).map((k) => k.length));
  for (const [k, v] of Object.entries(job)) console.log(`${k.padEnd(width)} : ${v}`);
}

function parseListArgs(args) {
  const filters = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--unscored') filters.unscored = true;
    else if (arg.startsWith('--status=')) filters.status = arg.slice(9);
    else if (arg === '--status') filters.status = args[++i];
    else usage(`unknown list argument "${arg}"`);
  }
  return filters;
}

/** Notes accumulate: a later note must never wipe the score reason. */
export function appendNote(existing, text) {
  return existing ? `${existing} | ${text}` : text;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const root = workspaceRoot({ create: true });
  const jobs = readJobs(root);

  if (cmd === 'list') {
    const { unscored, status } = parseListArgs(rest);
    if (status && !STATUSES.includes(status)) usage(`status must be one of: ${STATUSES.join(', ')}`);
    const rows = jobs.filter((j) => (!status || j.status === status) && (!unscored || j.score === ''));
    console.log(`${rows.length} job(s)`);
    for (const j of rows) {
      console.log(`#${j.id}\t${j.score || '-'}\t${j.status}\t[${j.company}] ${j.title}\t${j.location || ''}\t${j.url}`);
    }
    return;
  }

  const id = rest[0];
  if (!id) usage(`missing job id for "${cmd}"`);
  const job = findJob(root, id);
  if (!job) usage(`no job matching "${id}" in jobs.csv`);

  if (cmd === 'show') {
    printJob(job);
  } else if (cmd === 'get') {
    if (!rest.includes('--jd')) usage('get needs --jd (job description)');
    process.stdout.write(await fetchDescription(root, job));
  } else if (cmd === 'score') {
    const score = Number(rest[1]);
    const reason = rest.slice(2).join(' ').trim();
    if (!Number.isInteger(score) || score < 0 || score > 100) usage('score must be an integer 0-100');
    if (!reason) usage('score needs a short reason, e.g. score 3 87 "skills 9/10, senior match, EU remote"');
    updateJobs(root, job.id, { score: String(score), notes: appendNote(job.notes, `score: ${reason}`) });
  } else if (cmd === 'status') {
    const status = rest[1];
    if (!STATUSES.includes(status)) usage(`status must be one of: ${STATUSES.join(', ')}`);
    updateJobs(root, job.id, { status });
  } else if (cmd === 'note') {
    const note = rest.slice(1).join(' ').trim();
    if (!note) usage('note needs text');
    updateJobs(root, job.id, { notes: appendNote(job.notes, note) });
  } else {
    usage(`unknown command "${cmd}"`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
