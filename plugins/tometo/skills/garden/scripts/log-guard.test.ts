// Run: node --test log-guard.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecord } from './log-guard.ts';

test('a record is a non-null object that is not an array', () => {
  assert.deepEqual([{}, { a: 1 }, null, [], 'x', 1].map(isRecord), [true, true, false, false, false, false]);
});
