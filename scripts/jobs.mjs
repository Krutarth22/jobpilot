#!/usr/bin/env node
// jobpilot jobs — the only tracker is jobs.csv. Read, fetch descriptions,
// score, and set status from here.
//
//   jobs.mjs list [--status new|applied|closed] [--unscored] [--ranked]
//   jobs.mjs show <id>
//   jobs.mjs get <id> --jd [--refresh]   print the full job description (cached in evals/<id>.jd.txt)
//   jobs.mjs score <id> <0-100> "<reason>"
//   jobs.mjs status <id> <new|applied|closed>
//   jobs.mjs note <id> "<text>"      appends to notes (never overwrites)
//   jobs.mjs sweep [--limit=N]       liveness-check new/applied rows, close expired
//   jobs.mjs feedback <id> <0-100> "why"   store your score (feeds learn.mjs)
//   jobs.mjs outcome <id> interview|rejected|offer|ghosted
//   jobs.mjs stats                   interview rate by fit bucket (scoring health)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  workspaceRoot, readJobs, writeJobs, updateJobs, findJob, STATUSES, OUTCOMES, readEval, writeEval, evalsPath,
} from './lib/workspace.mjs';
import { isMainModule } from './lib/main.mjs';
import { rankAll } from './lib/rank.mjs';
import { sweepClosed, SWEEP_DEFAULT_LIMIT } from './lib/sweep.mjs';
import { statsByBucket } from './lib/learn.mjs';
import * as greenhouse from './providers/greenhouse.mjs';
import * as lever from './providers/lever.mjs';
import * as ashby from './providers/ashby.mjs';

const PROVIDERS = { greenhouse, lever, ashby };

const usage = (msg) => {
  if (msg) console.error(`⚠️  ${msg}`);
  console.error('Usage: jobs.mjs <list|show|get|score|status|note|sweep|feedback|outcome|stats|eval> ...');
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

export const jdCachePath = (root, id) => `${evalsPath(root)}/${id}.jd.txt`;

/**
 * The job description, cached per job in evals/<id>.jd.txt. match fetches
 * it, then score.mjs needs it again — and Ashby/Lever can only return a
 * description by downloading the company's whole board. An empty result is
 * never cached, so a later fetch can still succeed.
 */
export async function fetchDescription(root, job, { refresh = false } = {}) {
  const cache = jdCachePath(root, job.id);
  if (!refresh && existsSync(cache)) return readFileSync(cache, 'utf8');
  const text = await fetchDescriptionUncached(root, job);
  if (text.trim()) {
    mkdirSync(evalsPath(root), { recursive: true });
    writeFileSync(cache, text);
  }
  return text;
}

async function fetchDescriptionUncached(root, job) {
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
    else if (arg === '--ranked') filters.ranked = true;
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
    const { unscored, status, ranked } = parseListArgs(rest);
    if (status && !STATUSES.includes(status)) usage(`status must be one of: ${STATUSES.join(', ')}`);
    if (ranked) {
      // rank = fit × freshness (lib/rank.mjs); persists ranks.
      const order = rankAll(jobs);
      const rankById = new Map(order.map(({ job, rank }) => [job.id, String(rank)]));
      for (const j of jobs) j.rank = j.fit === '' ? '' : (rankById.get(j.id) ?? ''); // unscored → no rank yet
      writeJobs(root, jobs);
      const position = new Map(order.map(({ job }, i) => [job.id, i]));
      jobs.sort((a, b) => position.get(a.id) - position.get(b.id)); // unscored: freshest first
    }
    const rows = jobs.filter((j) => (!status || j.status === status) && (!unscored || j.fit === ''));
    console.log(`${rows.length} job(s)`);
    for (const j of rows) {
      const head = ranked ? `#${j.id}\trank ${j.rank || '-'}\tfit ${j.fit || '-'}\t${j.status}` : `#${j.id}\t${j.fit || '-'}\t${j.status}`;
      console.log(`${head}\t[${j.company}] ${j.title}\t${j.location || ''}\t${j.posted || ''}\t${j.salary || ''}\t${j.url}`);
    }
    return;
  }

  if (cmd === 'sweep') {
    const limitArg = rest.find((a) => a.startsWith('--limit='));
    const limit = limitArg ? Number(limitArg.slice(8)) : SWEEP_DEFAULT_LIMIT;
    const result = await sweepClosed(root, { limit });
    console.log(JSON.stringify(result, null, 2));
    if (result.closed > 0) {
      for (const d of result.details) console.log(`  🔒 #${d.id} [${d.company}] ${d.title} — ${d.signal}`);
    }
    return;
  }

  if (cmd === 'stats') {
    // D4: if high scores don't lead to more interviews, scoring is miscalibrated.
    const health = statsByBucket(jobs);
    console.log(JSON.stringify(health, null, 2));
    if (health.totalOutcomes < 15) {
      console.error(`ℹ️  ${health.totalOutcomes}/15 outcomes recorded — the health verdict needs more history.`);
    } else {
      console.error(health.healthy
        ? '✅ scoring health looks calibrated: higher fit buckets convert to interviews at higher rates.'
        : '⚠️  miscalibration: high-fit jobs are NOT converting to interviews at higher rates. Run learn.mjs and revisit the rubric.');
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
    process.stdout.write(await fetchDescription(root, job, { refresh: rest.includes('--refresh') }));
  } else if (cmd === 'score') {
    const score = Number(rest[1]);
    const reason = rest.slice(2).join(' ').trim();
    if (!Number.isInteger(score) || score < 0 || score > 100) usage('score must be an integer 0-100');
    if (!reason) usage('score needs a short reason, e.g. score 3 87 "skills 9/10, senior match, EU remote"');
    updateJobs(root, job.id, { fit: String(score), notes: appendNote(job.notes, `manual fit: ${reason}`) });
    console.error('ℹ️  manual override — the auditable path is: AI checklist → scripts/score.mjs');
  } else if (cmd === 'status') {
    const status = rest[1];
    if (!STATUSES.includes(status)) usage(`status must be one of: ${STATUSES.join(', ')}`);
    updateJobs(root, job.id, { status });
  } else if (cmd === 'note') {
    const note = rest.slice(1).join(' ').trim();
    if (!note) usage('note needs text');
    updateJobs(root, job.id, { notes: appendNote(job.notes, note) });
  } else if (cmd === 'feedback') {
    // D1: your score next to the computed one, in evals/<id>.json.
    const score = Number(rest[1]);
    const why = rest.slice(2).join(' ').trim();
    if (!Number.isInteger(score) || score < 0 || score > 100) usage('feedback score must be an integer 0-100');
    if (!why) usage('feedback needs a short "why" (this is what learn.mjs learns from)');
    const ev = readEval(root, job.id) || { id: job.id, company: job.company, title: job.title, url: job.url };
    ev.feedback = { user_score: score, why, at: new Date().toISOString() };
    writeEval(root, job.id, ev);
    updateJobs(root, job.id, { notes: appendNote(job.notes, `your score: ${score}`) });
  } else if (cmd === 'outcome') {
    const outcome = rest[1];
    if (!OUTCOMES.includes(outcome)) usage(`outcome must be one of: ${OUTCOMES.join(', ')}`);
    updateJobs(root, job.id, { outcome });
    if (outcome === 'interview' && job.status === 'new') updateJobs(root, job.id, { status: 'applied' });
  } else if (cmd === 'eval') {
    // E1: store non-score data (e.g. contact notes) in evals/<id>.json.
    //   jobs.mjs eval <id> contact '{"name": "...", "confidence": "..."}'
    const key = rest[1];
    const raw = rest.slice(2).join(' ').trim();
    if (!key || !raw) usage('eval needs a key and JSON, e.g. eval 12 contact \'{"name":"Jane"}\'');
    let value;
    try { value = JSON.parse(raw); } catch { usage('eval value must be valid JSON'); }
    const ev = readEval(root, job.id) || { id: job.id, company: job.company, title: job.title, url: job.url };
    ev[key] = value;
    writeEval(root, job.id, ev);
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
