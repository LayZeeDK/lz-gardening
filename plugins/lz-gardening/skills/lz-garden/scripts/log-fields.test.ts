import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeUnprintable } from './log-fields.ts';

test('an unprintable character is written as its code point in hex', () => {
  assert.equal(escapeUnprintable('a\u001bb'), 'a\\u{1b}b');
});
