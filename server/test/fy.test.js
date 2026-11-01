import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financialYearPosition } from '../src/fy.js';

test('matches the PRD worked example: 31 Dec 2024 is day 275 of 365', () => {
  assert.deepEqual(financialYearPosition(new Date('2024-12-31T12:00:00+05:30')), {
    financialYear: '2024-25',
    dayOfYear: 275,
    daysInYear: 365,
    elapsedPct: 75.34,
  });
});

test('a year containing 29 February has 366 days', () => {
  const end = financialYearPosition(new Date('2024-03-31T12:00:00+05:30'));
  assert.equal(end.financialYear, '2023-24');
  assert.equal(end.dayOfYear, 366);
  assert.equal(end.elapsedPct, 100);
});

test('the year rolls over at midnight in India, not UTC', () => {
  assert.equal(financialYearPosition(new Date('2026-03-31T18:29:59Z')).financialYear, '2025-26');
  const first = financialYearPosition(new Date('2026-03-31T18:30:00Z'));
  assert.equal(first.financialYear, '2026-27');
  assert.equal(first.dayOfYear, 1);
});
