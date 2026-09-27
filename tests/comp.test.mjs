import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { computeMultipliers, mergeComp, tagStages, calibrate } from '../scripts/comp.mjs';
import { setFrontmatterField, parseProfile } from '../scripts/lib/profile.mjs';
import { compScore, totalCompMultiplier } from '../scripts/score.mjs';

const LOOKUPS = {
  source: 'levels.fyi',
  companies: [
    { company: 'Stripe', stage: 'public', base: 300000, total: 540000 },
    { company: 'Figma', stage: 'Public', base: 280000, total: 476000 },
    { company: 'Mount Sinai', stage: 'hospital', base: 240000, total: 252000, source: 'Glassdoor' },
    { company: 'Citadel', stage: 'hedge fund', base: 250000, total: 500000, source: 'bonus survey' },
    { company: 'Ramp', stage: 'late-stage' }, // type only
    { company: 'Bad', base: 300000, total: 200000 }, // total < base
    { company: 'Wild', base: 100000, total: 900000 }, // > 5×
  ],
};

test('computeMultipliers: per company, per type (any field), default from ≥3; implausible rejected', () => {
  const r = computeMultipliers(LOOKUPS);
  assert.equal(r.multipliers['company:Stripe'], 1.8);
  assert.equal(r.multipliers['company:Mount Sinai'], 1.05);
  assert.equal(r.multipliers['stage:public'], 1.75); // median of 1.8 and 1.7, label normalized
  assert.equal(r.multipliers['stage:hospital'], 1.05);
  assert.equal(r.multipliers['stage:hedge-fund'], 2);
  assert.equal(r.multipliers.default, 1.75); // median of 1.05, 1.7, 1.8, 2
  assert.deepEqual(r.rejected.map((x) => x.company), ['Bad', 'Wild']);
  assert.ok(r.stages.some((s) => s.company === 'Ramp' && s.stage === 'late-stage'));
  assert.deepEqual(r.sources.sort(), ['Glassdoor', 'bonus survey', 'levels.fyi']);
});

test('computeMultipliers: fewer than 3 lookups → no default (old one kept by mergeComp)', () => {
  const r = computeMultipliers({ companies: [{ company: 'A', base: 100, total: 150 }] });
  assert.equal(r.default, null);
  const comp = mergeComp({ currency: 'USD', min_total: 400000, multipliers: { default: 1.43, 'manager@public': 1.6, 'company:Old': 2 } }, r, '2026-09-27');
  assert.deepEqual(comp.multipliers, { default: 1.43, 'manager@public': 1.6, 'company:A': 1.5 }); // stale company: key dropped
  assert.equal(comp.min_total, 400000);
  assert.equal(comp.calibrated.date, '2026-09-27');
});

test('totalCompMultiplier: company, then level@stage, then stage:, then level, then default', () => {
  const profile = { comp: { multipliers: { 'company:Stripe': 1.8, 'manager@public': 1.6, 'stage:public': 1.7, manager: 1.3, default: 1.1 } } };
  assert.equal(totalCompMultiplier(profile, 'manager', 'public', 'stripe'), 1.8);
  assert.equal(totalCompMultiplier(profile, 'manager', 'public', 'Figma'), 1.6);
  assert.equal(totalCompMultiplier(profile, 'staff', 'public', 'Figma'), 1.7);
  assert.equal(totalCompMultiplier(profile, 'manager', null, null), 1.3);
  assert.equal(totalCompMultiplier(profile, 'staff', 'hospital', null), 1.1);
});

test('compScore: a base floor caps the score even when estimated total clears', () => {
  const profile = { comp: { currency: 'USD', min_base: 280000, min_total: 400000, multipliers: { default: 2 } } };
  const low = compScore({ salary: { min: 220000, max: 240000, currency: 'USD' } }, profile);
  assert.equal(low.belowBase, true);
  assert.ok(low.pct < 100 && low.pct > 20); // 240/280 = 0.857 → between the floors
  const ok = compScore({ salary: { min: 260000, max: 320000, currency: 'USD' } }, profile);
  assert.equal(ok.pct, 100);
  assert.equal(ok.belowBase, false);
  // Base floor alone still scores.
  assert.equal(compScore({ salary: { min: 100000, max: 150000, currency: 'USD' } }, { comp: { min_base: 280000 } }).belowBase, true);
});

test('setFrontmatterField: rewrites one field, keeps everything else', () => {
  const text = [
    '---',
    'name: Jordan Rivera',
    'level: manager            # comment kept',
    'comp:',
    '  currency: USD',
    '  min_total: 300000',
    'links: { other: [] }',
    '---',
    '',
    '# Prose stays',
  ].join('\n');
  const out = setFrontmatterField(text, 'comp', { currency: 'USD', min_total: 400000, multipliers: { 'company:Stripe': 1.8 } });
  assert.match(out, /level: manager {12}# comment kept/);
  assert.match(out, /^comp: \{ .* \}$/m);
  assert.match(out, /# Prose stays$/);
  assert.deepEqual(parseProfile(out).frontmatter.comp.multipliers, { 'company:Stripe': 1.8 });
  assert.deepEqual(parseProfile(out).frontmatter.links, { other: [] });
  // Missing field is appended.
  assert.equal(parseProfile(setFrontmatterField(out, 'paper', 'a4')).frontmatter.paper, 'a4');
});

test('tagStages: sets stage on matching entries only', () => {
  const text = 'companies:\n  - { name: Stripe, provider: greenhouse, slug: stripe }\n  - { name: Ramp, provider: ashby, slug: ramp } # note\n';
  const { text: out, missing } = tagStages(text, [{ company: 'stripe', stage: 'public' }, { company: 'Nope', stage: 'bank' }]);
  assert.deepEqual(yaml.load(out).companies[0], { name: 'Stripe', provider: 'greenhouse', slug: 'stripe', stage: 'public' });
  assert.match(out, /slug: ramp \} # note/);
  assert.deepEqual(missing, ['Nope']);
});

test('calibrate: writes profile comp and company types, with backups; --dry-run writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jobpilot-comp-'));
  writeFileSync(join(root, 'profile.md'), '---\nname: J\nlevel: senior-manager\ncomp: { currency: USD, min_base: 280000, min_total: 400000, multipliers: { default: 1.43 } }\n---\n\nBody\n');
  writeFileSync(join(root, 'companies.yml'), 'title_filter: {}\ncompanies:\n  - { name: Stripe, provider: greenhouse, slug: stripe }\n  - { name: Figma, provider: greenhouse, slug: figma }\n');

  const dry = await calibrate(root, LOOKUPS, { dryRun: true, today: '2026-09-27' });
  assert.equal(dry.default, 1.75);
  assert.equal(existsSync(join(root, 'profile.md.bak')), false);

  const s = await calibrate(root, LOOKUPS, { today: '2026-09-27' });
  const comp = parseProfile(readFileSync(join(root, 'profile.md'), 'utf8')).frontmatter.comp;
  assert.equal(comp.min_base, 280000);
  assert.equal(comp.multipliers.default, 1.75);
  assert.equal(comp.multipliers['company:Figma'], 1.7);
  assert.match(readFileSync(join(root, 'profile.md'), 'utf8'), /\n\nBody\n$/);
  assert.ok(existsSync(join(root, 'profile.md.bak')));
  const companies = yaml.load(readFileSync(join(root, 'companies.yml'), 'utf8')).companies;
  assert.deepEqual(companies.map((c) => c.stage), ['public', 'public']);
  assert.ok(s.notInCompanies.includes('Mount Sinai'));
});
