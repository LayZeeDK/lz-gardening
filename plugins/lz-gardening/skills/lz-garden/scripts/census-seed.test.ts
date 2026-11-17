// The seed list as data: its lines, the census they come from, and which weeds a line asks about.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onSeedLine, seedLines, seedLinesIn, seedPath } from './census.ts';
import type { Census } from './store-census.ts';
import { writePendingCensus } from './store-census.ts';
import { censusText, planted, writeCensusText } from './test-site.ts';

function census(fields: Partial<Census>): Census {
  return {
    rev: 'main',
    sha: 'a'.repeat(40),
    takenAt: '2026-11-13T00:00:00.000Z',
    counts: {},
    hits: {},
    duplicates: {},
    ...fields,
  };
}

test('a seed line of a pattern names its class and its one file, and a duplicate line every file of the name', () => {
  const lines = seedLines(
    census({
      hits: { 'any-type': ['src/a.ts:1: x', 'src/a.ts:4: y', 'src/b.ts:2: z'] },
      duplicates: { parse: ['src/a.ts', 'src/c.ts'] },
    }),
  );

  assert.deepEqual(lines, [
    { line: '= [any-type] src/a.ts 2', class: 'any-type', paths: ['src/a.ts'] },
    { line: '= [any-type] src/b.ts 1', class: 'any-type', paths: ['src/b.ts'] },
    { line: '= duplicate parse: src/a.ts, src/c.ts', class: 'duplicate-function', paths: ['src/a.ts', 'src/c.ts'] },
  ]);
});

test("a weed's path drops only a line number at its end", () => {
  assert.deepEqual(['src/a.ts:12', 'src/a.ts', 'src/b:2.ts:7', 'src/c.ts:x'].map(seedPath), [
    'src/a.ts',
    'src/a.ts',
    'src/b:2.ts',
    'src/c.ts:x',
  ]);
});

test('a seed line asks about a weed of its class in one of its files, with or without a line', () => {
  const line = {
    line: '= duplicate parse: src/a.ts, src/c.ts',
    class: 'duplicate-function',
    paths: ['src/a.ts', 'src/c.ts'],
  };

  assert.deepEqual(
    [
      onSeedLine(line, 'duplicate-function', 'src/c.ts:9'),
      onSeedLine(line, 'duplicate-function', 'src/a.ts'),
      onSeedLine(line, 'any-type', 'src/a.ts'),
      onSeedLine(line, 'duplicate-function', 'src/b.ts'),
    ],
    [true, true, false, false],
  );
});

test("the seed list comes from the census taken of a commit while it waits, else from the garden's census", (t) => {
  const { dir, garden } = planted(t);
  const sha = 'b'.repeat(40);
  writeCensusText(garden, censusText('a'.repeat(40), { hits: { 'any-type': ['src/recorded.ts:1: x'] } }));
  writePendingCensus(
    { path: garden, checkout: dir },
    sha,
    censusText(sha, { hits: { 'any-type': ['src/taken.ts:1: x'] } }),
  );

  assert.deepEqual(
    [seedLinesIn(garden, sha), seedLinesIn(garden, 'c'.repeat(40)), seedLinesIn(garden, undefined)].map((lines) =>
      lines.map(({ line }) => line),
    ),
    [['= [any-type] src/taken.ts 1'], ['= [any-type] src/recorded.ts 1'], ['= [any-type] src/recorded.ts 1']],
  );
});

test('a garden with no census has no seed list', (t) => {
  const { garden } = planted(t);

  assert.deepEqual(seedLinesIn(garden, 'a'.repeat(40)), []);
});
