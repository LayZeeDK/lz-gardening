// The seed list as data: its lines, the census they come from, and which weeds a line asks about.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offSeedList, onSeedLine, seedLines, seedLinesIn, seedLinesLeft, seedPath } from './census.ts';
import { planAdd, stamp } from './log.ts';
import type { AddInput } from './log.ts';
import { now } from './test-repo.ts';
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

test('a seed line is left until an add of its class covers each of its paths; a close covers nothing', () => {
  const seeds = seedLines(
    census({
      hits: { 'any-type': ['src/a.ts:1: x', 'src/b.ts:2: y'] },
      duplicates: { parse: ['src/c.ts', 'src/d.ts'], fold: ['src/e.ts', 'src/f.ts'] },
    }),
  );
  const add = (weedClass: string, where: string): AddInput => ({
    class: weedClass,
    where,
    source: 'census:seed',
    note: '',
    layer: null,
  });
  const events = stamp(
    [
      ...planAdd([], add('any-type', 'src/a.ts:9'), now).drafts,
      ...planAdd([], add('hollow-assertion', 'src/b.ts'), now).drafts,
      ...planAdd([], add('duplicate-function', 'src/d.ts'), now).drafts,
      ...planAdd([], add('duplicate-function', 'src/e.ts'), now).drafts,
      ...planAdd([], add('duplicate-function', 'src/f.ts:3'), now).drafts,
      { op: 'close', ids: ['0123456789'], class: 'any-type', kind: 'kept', by: 'src/b.ts', check: null },
    ],
    0,
    now,
  );

  assert.deepEqual(
    seedLinesLeft(seeds, events).map((seed) => seed.line),
    ['= [any-type] src/b.ts 1', '= duplicate parse: src/c.ts, src/d.ts'],
  );
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

test('a weed takes census:seed only on a line of the seed list, else the refusal names its class and file', () => {
  const seeds = [{ line: '- [any-type] src/a.ts 2', class: 'any-type', paths: ['src/a.ts'] }];

  assert.deepEqual(
    [
      offSeedList(seeds, 'any-type', 'src/a.ts:3'),
      offSeedList(seeds, 'ts-ignore', 'src/a.ts'),
      offSeedList(seeds, 'any-type', 'src/b.ts:1'),
    ],
    [
      null,
      'no line of the seed list is ts-ignore in src/a.ts; census:seed is for those lines alone',
      'no line of the seed list is any-type in src/b.ts; census:seed is for those lines alone',
    ],
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
