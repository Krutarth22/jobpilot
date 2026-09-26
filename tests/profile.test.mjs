import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, normalizeProfile, loadProfile } from '../scripts/lib/profile.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRONTMATTER = `---
years_experience: 11
level: manager
target_titles: [Engineering Manager, Senior Backend Engineer]
skills: [python, pytorch, kubernetes, k8s]
languages: [english]
locations: { remote: preferred, cities: [New York], relocate: false }
comp: { currency: USD, min_total: 350000, multipliers: { "manager@public": 1.6, default: 1.4 } }
deal_breakers: { onsite_only: true, needs_sponsorship: false, clearance: false }
weights: { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 }
anchors:
  - { title: Engineering Manager, company: Acme, summary: "led 8 engineers", score: 70 }
---

## Experience

Led the platform team at Acme Corp from 2019 to 2024.
`;

test('profile: front matter splits from body', () => {
  const { frontmatter, body, hasFrontmatter } = parseProfile(FRONTMATTER);
  assert.equal(hasFrontmatter, true);
  assert.equal(frontmatter.level, 'manager');
  assert.match(body, /## Experience/);
  assert.doesNotMatch(body, /years_experience/);
});

test('profile: no front matter → all-unknown, never guessed', () => {
  const { frontmatter, body, hasFrontmatter } = parseProfile('# Just prose\nSome bullets.');
  assert.equal(hasFrontmatter, false);
  assert.equal(Object.keys(frontmatter).length, 0);
  assert.match(body, /Just prose/);
});

test('profile: malformed YAML falls back to no front matter', () => {
  const { hasFrontmatter } = parseProfile('---\nyears_experience: [unclosed\n---\nbody');
  assert.equal(hasFrontmatter, false);
});

test('profile: normalize applies defaults and canonical casing', () => {
  const p = normalizeProfile({ level: ' Manager ', skills: ['Python', 'K8s'], years_experience: '11' });
  assert.equal(p.level, 'manager');
  assert.deepEqual(p.skills, ['python', 'k8s']);
  assert.equal(p.years_experience, 11);
  assert.deepEqual(p.weights, { skills: 35, seniority: 25, domain: 15, location: 15, comp: 10 });
});

test('profile: user-set weights are preserved, not snapped to defaults', () => {
  const p = normalizeProfile({ weights: { skills: 50, seniority: 20, domain: 10, location: 10, comp: 10 } });
  assert.equal(p.weights.skills, 50);
});

test('profile: loadProfile on a missing file exists:false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobpilot-prof-'));
  try {
    const loaded = loadProfile(dir);
    assert.equal(loaded.exists, false);
    assert.equal(loaded.profile.weights.skills, 35); // defaults still usable
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('profile: loadProfile round-trips a real file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobpilot-prof-'));
  try {
    await writeFile(join(dir, 'profile.md'), FRONTMATTER);
    const loaded = loadProfile(dir);
    assert.equal(loaded.profile.level, 'manager');
    assert.equal(loaded.profile.comp.min_total, 350000);
    assert.equal(loaded.profile.anchors.length, 1);
    assert.match(loaded.body, /Acme Corp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
