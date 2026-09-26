// Regression tests for the scoring-v2 code review. Each test is named after
// the finding it pins down, using the input that exposed the bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { extractLevel, extractWorkMode, extractSalary, levelDistance } from '../scripts/lib/signals.mjs';
import {
  buildSignals, detectKnockouts, compScore, computeScore, evidenceBacked, totalCompMultiplier, scoreNotes,
} from '../scripts/score.mjs';
import { normalizeProfile } from '../scripts/lib/profile.mjs';
import { fetchDescription, jdCachePath } from '../scripts/jobs.mjs';
import {
  probeBoard, discoverBoard, boardMatchesName, appendEntries, removeEntries,
} from '../scripts/verify-boards.mjs';

const JOB = { id: 1, company: 'Acme', title: 'Engineering Manager', location: 'London' };

test('#2 no languages in the profile → no language knockout (unknown, not "speaks nothing")', () => {
  const profile = normalizeProfile({ level: 'manager' });
  const signals = buildSignals('Fluent in English is required.', JOB, profile, { profileBody: '' });
  assert.deepEqual(detectKnockouts(signals, JOB, profile), []);
  // With languages listed, a genuinely missing one still knocks out.
  const listed = normalizeProfile({ level: 'manager', languages: ['english'] });
  const german = buildSignals('Fluent in German is required.', JOB, listed, { profileBody: '' });
  assert.deepEqual(detectKnockouts(german, JOB, listed), ['required language missing: german']);
});

test('#3 partial office days are hybrid, never on-site only', () => {
  assert.deepEqual(extractWorkMode('', 'Hybrid: in-office 3 days a week').onsite_only, false);
  assert.equal(extractWorkMode('', 'You will be in the office 4 days per week.').mode, 'hybrid');
  assert.equal(extractWorkMode('', 'This role is in-office 5 days a week.').onsite_only, true);
});

test('#4 "Lead" and "Tech Lead" are senior ICs; "Tech Lead Manager" is a manager', () => {
  assert.equal(extractLevel('Lead Engineer').level, 'ic-senior');
  assert.equal(extractLevel('Tech Lead, Payments').level, 'ic-senior');
  assert.equal(extractLevel('Tech Lead and Manager (TLM), Production Engineering').level, 'manager');
  assert.equal(extractLevel('Senior Engineering Manager').level, 'senior-manager');
});

test('#5 switching IC ↔ management tracks is not a perfect seniority match', () => {
  assert.equal(levelDistance('staff', 'manager'), 1);
  assert.equal(levelDistance('manager', 'manager'), 0);
});

test('#6 level comes from the role, not from incidental prose', () => {
  assert.equal(extractLevel('Software Engineer II', 'You will work with senior leaders').level, 'ic-mid');
  assert.deepEqual(extractLevel('Software Engineer', 'Partner with senior stakeholders'), { level: 'ic-mid', source: 'title-default' });
  assert.equal(extractLevel('Senior Product Manager').level, 'ic-senior'); // a function, not people management
  assert.equal(extractLevel('Cook', ''), null);
});

test('#7 negated remote language does not read as remote', () => {
  assert.equal(extractWorkMode('New York', 'This role is not eligible for remote work.').mode, 'onsite');
  assert.equal(extractWorkMode('New York', 'Remote work is not available for this position.').mode, 'onsite');
  assert.equal(extractWorkMode('Remote (US)', '').mode, 'remote');
});

test('#8 a salary in another currency scores comp as unknown, not low', () => {
  const profile = normalizeProfile({ comp: { currency: 'USD', min_total: 300000 } });
  const signals = buildSignals('Salary: £100,000 - £120,000 base.', JOB, profile, { profileBody: '' });
  const comp = compScore(signals, profile);
  assert.equal(comp.pct, null);
  assert.equal(comp.currencyMismatch, 'GBP vs USD');
});

test('#9 "salary" counts as salary context', () => {
  assert.deepEqual(
    extractSalary('The salary range for this role is $40,000 - $45,000.'),
    { min: 40000, max: 45000, currency: 'USD', source: '$40,000 - $45,000' },
  );
});

test('#10 evidence must quote the profile whole, not share a 3-word run', () => {
  const body = 'Five years of experience with python scripting. Skills: Python, PyTorch, Kubernetes.';
  const skills = ['python', 'pytorch', 'kubernetes'];
  assert.equal(evidenceBacked('experience with python and kafka at scale', body, skills), false);
  assert.equal(evidenceBacked("profile: 'experience with python and kafka at scale'", body, skills), false);
  assert.equal(evidenceBacked("profile: 'Five years of experience with python'", body, skills), true);
  assert.equal(evidenceBacked('profile: "Python, PyTorch, Kubernetes"', body, skills), true);
  assert.equal(evidenceBacked('profile: "Python, Rust"', body, skills), false); // Rust isn't listed
  assert.equal(evidenceBacked("profile: 'Led Acme's platform team for 5 years'", "Led Acme's platform team for 5 years.", []), true);
});

test('#12 total-comp multiplier: level@stage when stage is known, else level, else default', () => {
  const profile = { comp: { multipliers: { 'manager@public': 1.6, manager: 1.3, default: 1.1 } } };
  assert.equal(totalCompMultiplier(profile, 'manager', 'public'), 1.6);
  assert.equal(totalCompMultiplier(profile, 'manager', null), 1.3);
  assert.equal(totalCompMultiplier(profile, 'staff', 'startup'), 1.1);
});

test('#14 a board with zero open jobs is empty, not dead', async () => {
  const empty = await probeBoard('lever', 'mistral', { fetchBoard: async () => [] });
  assert.deepEqual({ live: empty.live, count: empty.count }, { live: true, count: 0 });
  const gone = await probeBoard('lever', 'plaid', { fetchBoard: async () => { const e = new Error('HTTP 404'); e.status = 404; throw e; } });
  assert.equal(gone.live, false);
});

test('#15 a guessed slug is only added when the board belongs to that company', async () => {
  // Greenhouse: the board's own name decides.
  assert.equal(await boardMatchesName('greenhouse', 'ramp', 'Ramp', [], { fetchBoardName: async () => 'Ramp' }), true);
  assert.equal(await boardMatchesName('greenhouse', 'ramp', 'Ramp', [], { fetchBoardName: async () => 'Ramp Health Partners' }), true);
  assert.equal(await boardMatchesName('greenhouse', 'ramp', 'Ramp', [], { fetchBoardName: async () => 'Rampart Security' }), false);
  // Lever/Ashby: a posting must name the company.
  assert.equal(await boardMatchesName('lever', 'acme', 'Acme', [{ description: 'At Acme we build…' }]), true);
  assert.equal(await boardMatchesName('lever', 'acme', 'Acme', [{ description: 'At Globex we build…' }]), false);

  const probe = async (provider, slug) => (slug === 'acme' ? { live: true, count: 3, rows: [] } : { live: false });
  const result = await discoverBoard('Acme', { providers: ['lever'], probe, matches: async () => false });
  assert.equal(result.found, null);
  assert.deepEqual(result.unconfirmed, [{ provider: 'lever', slug: 'acme', count: 3 }]);
});

test('#16 companies.yml edits keep comments and layout', () => {
  const text = [
    '# my boards — keep this comment',
    'title_filter:',
    '  positive: [manager + engineering]',
    '',
    'companies:',
    '  # ── Greenhouse',
    '  - { name: Figma, provider: greenhouse, slug: figma }',
    '  - { name: Plaid, provider: lever, slug: plaid }  # moved off Lever',
    '',
  ].join('\n');
  const pruned = removeEntries(text, new Set(['lever:plaid']));
  assert.ok(pruned.includes('# my boards — keep this comment'));
  assert.ok(pruned.includes('  # ── Greenhouse'));
  assert.ok(!pruned.includes('plaid'));
  const appended = appendEntries(pruned, [{ name: 'Hims & Hers', provider: 'lever', slug: 'hims' }]);
  assert.ok(appended.includes('# my boards — keep this comment'));
  const companies = yaml.load(appended).companies;
  assert.deepEqual(companies.map((c) => c.slug), ['figma', 'hims']);
  assert.equal(companies[1].name, 'Hims & Hers');
});

test('#17 re-scoring replaces the old recheck/knockout note instead of stacking it', () => {
  const once = scoreNotes('liked the team', ['recheck: checklist score differs from keyword pre-score (20)']);
  const twice = scoreNotes(once, ['recheck: checklist score differs from keyword pre-score (22)']);
  assert.equal(twice, 'liked the team | recheck: checklist score differs from keyword pre-score (22)');
  assert.equal(scoreNotes(twice, []), 'liked the team'); // a clean re-score clears it
});

test('#18 job descriptions are served from the evals cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-jd-'));
  mkdirSync(join(root, 'evals'));
  // No companies.yml: an uncached fetch would throw, so this proves the cache is used.
  writeFileSync(jdCachePath(root, '7'), 'cached description');
  assert.equal(await fetchDescription(root, { id: '7', company: 'Acme', url: 'https://x/7' }), 'cached description');
  await assert.rejects(fetchDescription(root, { id: '7', company: 'Acme', url: 'https://x/7' }, { refresh: true }));
});

test('#2/#8 end to end: unknowns stay neutral in the final fit', () => {
  const profile = normalizeProfile({ level: 'manager', comp: { currency: 'USD', min_total: 300000 } });
  const signals = buildSignals('Fluent in English is required. Salary: £100,000 - £120,000.', JOB, profile, { profileBody: '' });
  const score = computeScore({ requirements: [], domain: null }, signals, profile);
  assert.equal(score.capped, false);
  assert.equal(score.components.comp.pct, null);
});

test('#15 name matching is word-level ("Ramp" never matches "Rampart" or "trampoline")', async () => {
  assert.equal(await boardMatchesName('lever', 'ramp', 'Ramp', [{ description: 'We make trampoline parks.' }]), false);
  assert.equal(await boardMatchesName('lever', 'ramp', 'Ramp', [{ description: 'Ramp is building finance software.' }]), true);
  assert.equal(await boardMatchesName('greenhouse', 'ramp', 'Ramp Inc', [], { fetchBoardName: async () => 'Ramp' }), true);
});
