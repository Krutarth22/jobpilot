import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsvRows, nearMissTitles } from '../scripts/scan.mjs';

test('toCsvRows: carries posting date and salary (B1), flags reposts (B3)', () => {
  const nowMs = Date.parse('2026-09-26T00:00:00Z');
  const existingRows = [
    { id: '1', company: 'Acme', title: 'Backend Engineer', url: 'https://a.co/1', found: '2026-09-01' },
  ];
  const rows = toCsvRows([
    { company: 'Acme', title: 'Senior Backend Engineer', url: 'https://a.co/new', location: 'Berlin', postedAt: Date.parse('2026-09-20T12:00:00Z'), salary: { min: 120000, max: 150000, currency: 'USD' } },
    { company: 'Globex', title: 'SRE', url: 'https://g.co/2', location: '' },
  ], 7, '2026-09-26', { existingRows, nowMs });

  assert.equal(rows[0].posted, '2026-09-20');
  assert.equal(rows[0].salary, 'USD 120k-150k');
  assert.match(rows[0].notes, /repost ×2 \(like #1\)/); // fuzzy-matches the existing row
  assert.equal(rows[0].status, 'new');
  assert.equal(rows[0].fit, '');
  // Second row: no date, no salary, no repost — empty columns, never guessed.
  assert.equal(rows[1].posted, '');
  assert.equal(rows[1].salary, '');
  assert.equal(rows[1].notes, '');
});

test('nearMissTitles: ≥2 shared keywords with targets, ranked by overlap', () => {
  const nearMiss = [
    { title: 'Manager, Software Engineering', location: 'Berlin' },
    { title: 'Engineering Manager - Platform', location: 'Remote' },
    { title: 'Sales Development Representative', location: 'Berlin' }, // no overlap
    { title: 'VP of_sales', location: 'Berlin' }, // 1 shared token → excluded
  ];
  const result = nearMissTitles(nearMiss, ['Engineering Manager']);
  assert.equal(result.length, 2);
  assert.ok(result[0].shared.length >= 2);
  assert.match(result[0].title, /Engineering Manager|Manager, Software Engineering/);
  // suggestion line is the shared keywords
  assert.ok(result[0].shared.join(' + ').length > 0);
});

test('nearMissTitles: no targets → no report (never guesses)', () => {
  assert.deepEqual(nearMissTitles([{ title: 'Manager, Software Engineering' }], []), []);
});
