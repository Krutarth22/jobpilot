import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness } from '../scripts/liveness.mjs';

const ACTIVE = {
  status: 200,
  bodyText: 'Senior Backend Engineer. We are looking for a passionate engineer. You will build distributed systems serving millions of users. Requirements: Go, Kubernetes, Postgres. Benefits: equity, remote budget, learning stipend. '.repeat(6) + ' Apply now',
};

test('active posting: apply control + enough content', () => {
  assert.deepEqual(classifyLiveness(ACTIVE), { verdict: 'active', signal: classifyLiveness(ACTIVE).signal });
  assert.equal(classifyLiveness(ACTIVE).verdict, 'active');
});

test('expired: 404/410 status', () => {
  assert.equal(classifyLiveness({ status: 404, bodyText: '' }).verdict, 'expired');
  assert.equal(classifyLiveness({ status: 410, bodyText: 'anything' }).verdict, 'expired');
});

test('expired: closure banners win over generic Apply text', () => {
  const body = ACTIVE.bodyText + ' This job is no longer available.';
  assert.equal(classifyLiveness({ status: 200, bodyText: body }).verdict, 'expired');
});

test('expired: "has been filled" with job noun, but not "application form has been filled"', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: 'The position has been filled. Thank you.' }).verdict, 'expired');
  // A live posting whose copy mentions filling an application form must NOT read as expired.
  const live = ACTIVE.bodyText + ' Once the application form has been filled out you will hear from us.';
  assert.equal(classifyLiveness({ status: 200, bodyText: live }).verdict, 'active');
});

test('expired: typographic apostrophes are normalized (French banner)', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: 'Cette offre n\u2019est plus disponible.' }).verdict, 'expired');
});

test('uncertain: anti-bot challenge, not expired', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: 'Just a moment... Enable JavaScript and cookies to continue \n ray id: abc' }).verdict, 'uncertain');
});

test('uncertain: thin page with no apply control', () => {
  assert.equal(classifyLiveness({ status: 200, bodyText: 'oops' }).verdict, 'uncertain');
});

test('uncertain: other 4xx/5xx', () => {
  assert.equal(classifyLiveness({ status: 500, bodyText: 'error' }).verdict, 'uncertain');
});
