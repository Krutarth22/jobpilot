import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTitleFilter, buildLocationFilter } from '../scripts/lib/_filters.mjs';

test('title filter: positive keywords pass, negative veto', () => {
  const f = buildTitleFilter({ positive: ['engineer', 'data'], negative: ['sales'] });
  assert.equal(f('Senior Software Engineer'), true);
  assert.equal(f('Data Scientist'), true);
  assert.equal(f('Account Executive, Sales'), false);
  assert.equal(f('Marketing Manager'), false); // no positive match
});

test('title filter: 2-3 letter keywords match on word boundaries', () => {
  const f = buildTitleFilter({ positive: ['ai'] });
  assert.equal(f('AI Engineer'), true);
  assert.equal(f('Maintainance Lead'), false); // "ai" inside a word must not match
});

test('title filter: AND-groups require every term', () => {
  const f = buildTitleFilter({ positive: ['director + engineering'] });
  assert.equal(f('Director of Engineering'), true);
  assert.equal(f('Engineering Director, Platform'), true);
  assert.equal(f('Director of Product'), false);
  // "C++" must survive: the + separator requires whitespace.
  const cpp = buildTitleFilter({ positive: ['c++'] });
  assert.equal(cpp('C++ Developer'), true);
});

test('title filter: empty positive lets everything not-negative pass', () => {
  const f = buildTitleFilter({ negative: ['intern'] });
  assert.equal(f('Anything At All'), true);
  assert.equal(f('Engineering Intern'), false);
});

test('location filter: allow list with word boundaries', () => {
  const f = buildLocationFilter({ allow: ['india'] });
  assert.equal(f('Bengaluru, India'), true);
  assert.equal(f('Indianapolis, IN'), false); // word boundary: not "india"
});

test('location filter: always_allow beats block', () => {
  const f = buildLocationFilter({ allow: ['belgium'], block: ['france'], always_allow: ['remote'] });
  assert.equal(f('Remote — Belgium or France'), true); // remote option wins
  assert.equal(f('Paris, France'), false);
  assert.equal(f('Brussels, Belgium'), true);
});

test('location filter: missing/empty location passes', () => {
  const f = buildLocationFilter({ allow: ['berlin'] });
  assert.equal(f(''), true);
  assert.equal(f(undefined), true);
});

test('location filter: no filter passes everything', () => {
  const f = buildLocationFilter(undefined);
  assert.equal(f('Anywhere on Earth'), true);
});
