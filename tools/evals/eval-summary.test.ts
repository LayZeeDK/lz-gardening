import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passAt, passHat, summaryTable } from './eval-summary.ts';

test('summaryTable gives Pass@k and Pass^k per eval and configuration, overall, and flags an eval both pass in full', () => {
  const runs = [
    { evalName: 'eval-tend-opus', config: 'new_skill', fullyPassed: true },
    { evalName: 'eval-tend-opus', config: 'new_skill', fullyPassed: false },
    { evalName: 'eval-tend-opus', config: 'old_skill', fullyPassed: false },
    { evalName: 'eval-seed-opus', config: 'new_skill', fullyPassed: true },
    { evalName: 'eval-seed-opus', config: 'old_skill', fullyPassed: true },
  ];

  assert.equal(
    summaryTable(runs),
    [
      '| Eval | Config | Runs | Fully passed | Pass@1 | Pass@3 | Pass@5 | Pass@n | Pass^1 | Pass^3 | Pass^5 | Pass^n |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| eval-seed-opus (saturated) | new_skill | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |',
      '| eval-seed-opus (saturated) | old_skill | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |',
      '| eval-tend-opus | new_skill | 2 | 1 | 0.5 | 1 | 1 | 1 | 0.5 | 0 | 0 | 0 |',
      '| eval-tend-opus | old_skill | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |',
      '| overall | new_skill | 3 | 2 | 0.67 | 1 | 1 | 1 | 0.67 | 0 | 0 | 0 |',
      '| overall | old_skill | 2 | 1 | 0.5 | 1 | 1 | 1 | 0.5 | 0 | 0 | 0 |',
    ].join('\n'),
  );
});

test('Pass@k and Pass^k follow 1 - C(n-c,k)/C(n,k) and C(c,k)/C(n,k), and k above n reads as n', () => {
  assert.deepEqual(
    [passAt(5, 2, 1), passAt(5, 2, 3), passHat(5, 2, 1), passHat(5, 2, 3), passAt(2, 1, 5), passHat(2, 2, 5)],
    [0.4, 0.9, 0.4, 0, 1, 1],
  );
});
