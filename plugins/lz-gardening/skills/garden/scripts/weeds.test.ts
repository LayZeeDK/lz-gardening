// Run: node --test weeds.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addWeed, groupWeeds, openWeeds, parseRow, validateAdd, weedId } from './weeds.ts';
import type { AddInput, Row } from './weeds.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'weeds.ts');
const now = new Date('2026-11-07T12:00:00.000Z');

function input(overrides: Partial<AddInput> = {}): AddInput {
  return {
    class: 'hollow-assertion',
    where: 'src/a.spec.ts:3',
    source: 'census:hollow-assertion',
    note: 'assert.ok(true)',
    layer: 2,
    ...overrides,
  };
}

function cli(dir: string, args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args, '--file', join(dir, 'weeds.jsonl')], {
    encoding: 'utf8',
  });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the same class, place and source is one weed', () => {
  const first = addWeed([], input(), now);
  assert.ok(first.row);
  assert.match(first.status, /^added /);

  const again = addWeed([first.row], input(), now);
  assert.equal(again.row, null);
  assert.match(again.status, /^seen /);
});

test('a weed added after its close counts as regrown', () => {
  const first = addWeed([], input(), now);
  assert.ok(first.row);
  const rows: Row[] = [first.row, { op: 'close', id: first.row.id, at: now.toISOString(), by: 'abc1234', keep: false }];

  const back = addWeed(rows, input(), now);
  assert.ok(back.row);
  assert.match(back.status, /^regrown /);

  const weeds = openWeeds([...rows, back.row]);
  assert.equal(weeds.length, 1);
  assert.equal(weeds[0]?.regrown, 1);
});

test('a weed closed with keep is never queued again', () => {
  const first = addWeed([], input(), now);
  assert.ok(first.row);
  const rows: Row[] = [
    first.row,
    { op: 'close', id: first.row.id, at: now.toISOString(), by: 'intentional: generated code', keep: true },
  ];

  const back = addWeed(rows, input(), now);
  assert.equal(back.row, null);
  assert.match(back.status, /^kept /);
  assert.deepEqual(openWeeds(rows), []);
});

test('groups count open weeds and distinct files per class, most first', () => {
  const rows = [
    input(),
    input({ where: 'src/a.spec.ts:9', source: 'census:hollow-assertion' }),
    input({ where: 'src/b.spec.ts:1' }),
    input({ class: 'double-cast', where: 'src/c.ts:4', source: 'census:double-cast', layer: 1 }),
  ].flatMap((item): Row[] => {
    const { row } = addWeed([], item, now);

    return row === null ? [] : [row];
  });

  const groups = groupWeeds(openWeeds(rows));
  assert.deepEqual(
    groups.map((group) => [group.class, group.open, group.places, group.layer]),
    [
      ['hollow-assertion', 3, 2, 2],
      ['double-cast', 1, 1, 1],
    ],
  );
});

test('validation refuses a bad class, an empty place, a source without a kind, and a layer out of range', () => {
  assert.equal(validateAdd(input()), null);
  assert.match(validateAdd(input({ class: 'Bad Class' })) ?? '', /kebab/);
  assert.match(validateAdd(input({ where: ' ' })) ?? '', /where/);
  assert.match(validateAdd(input({ source: 'abc1234' })) ?? '', /kind/);
  assert.match(validateAdd(input({ layer: 7 })) ?? '', /layer/);
});

test('a malformed queue line fails loudly with its line number', () => {
  assert.throws(() => parseRow('{"op":"add","id":"x","at":"t"}', 4), /line 4/);
  assert.throws(() => parseRow('{"op":"prune","id":"x","at":"t"}', 2), /unknown op/);
  assert.throws(() => parseRow('not json', 7), /line 7: not JSON/);
});

test('ids depend on class, place and source', () => {
  assert.notEqual(weedId('a', 'f:1', 'commit:1'), weedId('a', 'f:1', 'commit:2'));
  assert.equal(weedId('a', 'f:1', 'commit:1'), weedId('a', 'f:1', 'commit:1'));
});

test('the CLI appends, dedupes, closes a class and refuses an empty close', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weeds-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const add = [
    'add',
    '--class',
    'hollow-assertion',
    '--where',
    'src/a.spec.ts:3',
    '--source',
    'census:hollow-assertion',
    '--note',
    'x',
  ];

  assert.match(cli(dir, add).stdout, /^added /);
  assert.match(cli(dir, add).stdout, /^seen /);
  assert.equal(readFileSync(join(dir, 'weeds.jsonl'), 'utf8').trim().split('\n').length, 1);

  assert.match(cli(dir, ['groups', '--min', '1']).stdout, /hollow-assertion\s+1/);
  assert.equal(cli(dir, ['close-class', '--class', 'hollow-assertion', '--by', 'abc1234']).code, 0);
  assert.equal(cli(dir, ['list']).stdout, '');
  assert.equal(cli(dir, ['close-class', '--class', 'hollow-assertion', '--by', 'abc1234']).code, 1);
  assert.match(cli(dir, add).stdout, /^regrown /);
  assert.match(
    cli(dir, ['close-class', '--class', 'hollow-assertion', '--by', 'on purpose', '--keep']).stdout,
    /^kept 1/,
  );
  assert.match(cli(dir, add).stdout, /^kept /);
  assert.equal(cli(dir, ['add', '--class', 'x']).code, 2);
});

test('the CLI exits 2 on a malformed queue instead of treating it as empty', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'weeds-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'weeds.jsonl'), 'not json\n');

  const result = cli(dir, ['list']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /weeds:/);
});
