// Workspace + jobs.csv library for jobpilot.
//
// User data NEVER lives in the plugin folder (plugin installs get overwritten
// on update). It lives in the workspace: JOBPILOT_HOME env var, the "root"
// recorded in ~/.jobpilot.json, or ~/jobpilot by default.
//
//   <root>/
//     profile.md       the only source of facts for generated content
//     resume.<ext>     the user's original resume file
//     companies.yml    ATS boards to scan
//     jobs.csv         the only tracker (id,company,title,url,location,found,score,status,notes)
//     out/             tailored resumes and review notes

import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const JOBS_HEADER = ['id', 'company', 'title', 'url', 'location', 'found', 'score', 'status', 'notes'];

// The only three statuses. Score and notes live in their own columns.
export const STATUSES = ['new', 'applied', 'closed'];

// ── Config (~/.jobpilot.json) ─────────────────────────────────────────

export function configPath() {
  return resolve(homedir(), '.jobpilot.json');
}

export function loadConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

/** Workspace root: JOBPILOT_HOME > config.root > ~/jobpilot. */
export function workspaceRoot({ create = false } = {}) {
  const root = process.env.JOBPILOT_HOME
    || loadConfig().root
    || join(homedir(), 'jobpilot');
  const abs = resolve(root);
  if (create) {
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(abs, 'out'), { recursive: true });
    if (!existsSync(jobsPath(abs))) writeJobs(abs, []);
  }
  return abs;
}

// ── Paths ──────────────────────────────────────────────────────────────

export const jobsPath = (root) => join(root, 'jobs.csv');
export const profilePath = (root) => join(root, 'profile.md');
export const companiesPath = (root) => join(root, 'companies.yml');
export const outPath = (root) => join(root, 'out');

// ── CSV (RFC4180-ish: quoting, escaped quotes, embedded newlines) ─────

export function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields) {
  return fields.map(csvField).join(',');
}

/** Parse one CSV line. Returns {fields, rest} — rest is '' unless the line
 * ends inside a quoted field spanning lines (handled by readCsvLines). */
export function parseCsvLine(line) {
  const fields = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { value += '"'; i += 2; }
          else { i++; break; }
        } else { value += line[i++]; }
      }
      fields.push(value);
      if (line[i] === ',') i++;
      else if (i < line.length) throw new Error(`csv: unexpected content after quoted field: ${line}`);
      else break;
    } else {
      const next = line.indexOf(',', i);
      if (next === -1) { fields.push(line.slice(i)); i = line.length + 1; }
      else { fields.push(line.slice(i, next)); i = next + 1; }
    }
  }
  return fields;
}

/** Read a CSV file, tolerating quoted fields that span physical lines. */
export function readCsv(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const records = [];
  let current = '';
  let inQuotes = false;
  for (const line of text.split(/\r?\n/)) {
    if (inQuotes) {
      current += '\n' + line;
    } else {
      current = line;
    }
    // Count unescaped quotes to know if a quoted field is still open.
    const unescaped = (current.match(/(^|[^"])""|"/g) || []).length;
    inQuotes = unescaped % 2 === 1;
    if (!inQuotes) {
      if (current.trim() !== '') records.push(parseCsvLine(current));
      current = '';
    }
  }
  if (current.trim() !== '') records.push(parseCsvLine(current));
  return records;
}

// ── jobs.csv API ───────────────────────────────────────────────────────

export function jobFromFields(fields) {
  const job = {};
  JOBS_HEADER.forEach((key, i) => { job[key] = fields[i] ?? ''; });
  return job;
}

export function readJobs(root) {
  const records = readCsv(jobsPath(root));
  if (records.length === 0) return [];
  const [header, ...rows] = records;
  const keys = header.map((h) => h.trim().toLowerCase());
  if (keys.join(',') !== JOBS_HEADER.join(',')) {
    throw new Error(`jobs.csv header mismatch — expected ${JOBS_HEADER.join(',')}, found ${keys.join(',')}`);
  }
  return rows.map(jobFromFields);
}

export function writeJobs(root, jobs) {
  const lines = [csvRow(JOBS_HEADER), ...jobs.map((j) => csvRow(JOBS_HEADER.map((k) => j[k] ?? '')))];
  writeFileSync(jobsPath(root), lines.join('\n') + '\n');
}

export function appendJobs(root, jobs) {
  if (jobs.length === 0) return;
  const exists = existsSync(jobsPath(root));
  if (!exists) writeJobs(root, []);
  const lines = jobs.map((j) => csvRow(JOBS_HEADER.map((k) => j[k] ?? '')));
  appendFileSync(jobsPath(root), lines.join('\n') + '\n');
}

/** Merge updates into jobs.csv by id; unknown ids throw. */
export function updateJobs(root, id, patch) {
  const jobs = readJobs(root);
  const job = jobs.find((j) => j.id === String(id));
  if (!job) throw new Error(`jobs.csv: no job with id ${id}`);
  for (const [k, v] of Object.entries(patch)) {
    if (!JOBS_HEADER.includes(k)) throw new Error(`jobs.csv: unknown column "${k}"`);
    job[k] = v;
  }
  writeJobs(root, jobs);
  return job;
}

export function findJob(root, idOrUrl) {
  const jobs = readJobs(root);
  const needle = String(idOrUrl).trim();
  return jobs.find((j) => j.id === needle) || jobs.find((j) => j.url === normalizeUrl(needle));
}

export function nextJobId(jobs) {
  return jobs.reduce((max, j) => Math.max(max, Number(j.id) || 0), 0) + 1;
}

// ── URL normalization (the dedup key) ─────────────────────────────────

const TRACKING_PARAMS = /^(utm_|gh_jid=|gclid=|fbclid=|ref=|src=)/i;

/**
 * Normalize a posting URL so the same job found twice is one row:
 * lowercase host, drop fragment + trailing slash, strip tracking params.
 * The job id itself (gh_jid for greenhouse) is KEPT — only pure tracking
 * params are stripped.
 */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return String(url || '').trim().replace(/\/+$/, '');
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  const keep = [...parsed.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  parsed.search = '';
  for (const [k, v] of keep) parsed.searchParams.append(k, v);
  return parsed.toString();
}
