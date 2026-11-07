// Run: node --test weeds.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addWeed, groupWeeds, openWeeds, parseRow, readQueue, validateAdd, weedId } from './weeds.ts';
import type { AddInput, Row, Weed } from './weeds.ts';

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

function weed(fields: Partial<Weed>): Weed {
  return {
    op: 'add',
    id: `${fields.where ?? 'src/a.ts:1'}@${fields.at ?? now.toISOString()}`,
    at: now.toISOString(),
    class: 'any-type',
    where: 'src/a.ts:1',
    source: 'census:any-type',
    note: '',
    layer: null,
    regrown: 0,
    ...fields,
  };
}

function idOf(status: string): string {
  return status.trim().split(' ')[1] ?? '';
}

function queue(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'weeds-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
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

test('through the CLI a weed is added, seen, regrown after a close, and kept out after a keep', (t) => {
  const dir = queue(t);
  const add = ['add', '--class', 'hollow-assertion', '--where', 'src/a.spec.ts:3', '--source', 'census:x'];

  const statuses = [
    cli(dir, add).stdout,
    cli(dir, add).stdout,
    cli(dir, ['close-class', '--class', 'hollow-assertion', '--by', 'abc1234']).stdout,
    cli(dir, add).stdout,
    cli(dir, ['close-class', '--class', 'hollow-assertion', '--by', 'on purpose', '--keep']).stdout,
    cli(dir, add).stdout,
  ];

  assert.deepEqual(
    statuses.map((status) => status.split(' ')[0]),
    ['added', 'seen', 'closed', 'regrown', 'kept', 'kept'],
  );
});

test('the CLI exits 2 on a malformed queue instead of treating it as empty', (t) => {
  const dir = queue(t);
  writeFileSync(join(dir, 'weeds.jsonl'), 'not json\n');

  const result = cli(dir, ['list']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /weeds:/);
});

test('a mistyped flag is a usage error, not ignored', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['list', '--clas', 'hollow-assertion']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--clas/);
});

test('groups refuses a --min that is not a positive whole number, rather than hiding every class', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['groups', '--min', 'two']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--min/);
});

test('validation takes layers 1 and 6, refuses 0 and 1.5, and matches the whole class and source', () => {
  assert.equal(validateAdd(input({ layer: 1 })), null);
  assert.equal(validateAdd(input({ layer: 6 })), null);
  assert.match(validateAdd(input({ layer: 0 })) ?? '', /layer/);
  assert.match(validateAdd(input({ layer: 1.5 })) ?? '', /layer/);
  assert.match(validateAdd(input({ class: 'any-type!' })) ?? '', /kebab/);
  assert.match(validateAdd(input({ source: 'see commit:abc' })) ?? '', /kind/);
});

test('each malformed queue line says what is wrong with it', () => {
  for (const line of ['null', '[]', '42']) {
    assert.throws(() => parseRow(line, 1), /^Error: queue line 1: not an object$/);
  }

  assert.throws(() => parseRow('{"op":"add","at":"t"}', 1), /: missing id or at$/);
  assert.throws(() => parseRow('{"op":"close","id":"x","at":"t"}', 1), /: close without by$/);
  assert.throws(
    () => parseRow('{"op":"add","id":"x","at":"t","class":"c"}', 1),
    /: add without class, where or source$/,
  );
});

test('an add row without a note or layer reads as an empty note and no layer', () => {
  assert.deepEqual(parseRow('{"op":"add","id":"x","at":"t","class":"c","where":"w","source":"s:1"}', 1), {
    op: 'add',
    id: 'x',
    at: 't',
    class: 'c',
    where: 'w',
    source: 's:1',
    note: '',
    layer: null,
  });
});

test('a weed id is ten hex characters', () => {
  assert.match(weedId('any-type', 'src/a.ts:1', 'census:any-type'), /^[0-9a-f]{10}$/);
});

test('blank queue lines are skipped but still counted in line numbers', (t) => {
  const file = join(queue(t), 'weeds.jsonl');
  writeFileSync(file, '\n   \nnot json\n');

  assert.throws(() => readQueue(file), /line 3: not JSON/);
});

test('a weed added twice while open keeps its first sighting', () => {
  const first = weed({ id: 'x', at: '2026-11-07T10:00:00.000Z' });

  const open = openWeeds([first, { ...first, at: '2026-11-08T10:00:00.000Z' }]);

  assert.deepEqual(
    open.map((item) => item.at),
    ['2026-11-07T10:00:00.000Z'],
  );
});

test('a group counts a file once with or without a line, sums regrowth, and takes the lowest layer and first sighting', () => {
  const [group] = groupWeeds([
    weed({ where: 'src/a.ts:12', at: '2026-11-07T10:00:00.000Z', layer: 3, regrown: 1 }),
    weed({ where: 'src/a.ts:34', at: '2026-11-06T09:00:00.000Z', layer: 1, regrown: 2 }),
    weed({ where: 'src/a.ts', at: '2026-11-08T00:00:00.000Z' }),
    weed({ where: 'src/x:1.ts:4' }),
    weed({ where: 'src/x:1.ts:9' }),
  ]);

  assert.deepEqual(group, {
    class: 'any-type',
    open: 5,
    places: 2,
    regrown: 3,
    firstAt: '2026-11-06T09:00:00.000Z',
    layer: 1,
  });
});

test('a class whose weeds name no layer has no layer', () => {
  assert.equal(groupWeeds([weed({})])[0]?.layer, null);
});

test('groups sort by open weeds, then by regrowth, then by name', () => {
  const groups = groupWeeds([
    weed({ class: 'b-one', where: 'b' }),
    weed({ class: 'a-one', where: 'a' }),
    weed({ class: 'c-regrown', where: 'c', regrown: 2 }),
    weed({ class: 'd-three', where: 'd1' }),
    weed({ class: 'd-three', where: 'd2' }),
    weed({ class: 'd-three', where: 'd3' }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.class),
    ['d-three', 'c-regrown', 'a-one', 'b-one'],
  );
});

test('a different weed is added beside open, closed and kept weeds', () => {
  const close = (id: string, keep: boolean): Row => ({ op: 'close', id, at: now.toISOString(), by: 'abc1234', keep });
  const rows: Row[] = [
    weed({ id: 'open', where: 'src/open.ts:1' }),
    weed({ id: 'closed', where: 'src/closed.ts:1' }),
    close('closed', false),
    weed({ id: 'kept', where: 'src/kept.ts:1' }),
    close('kept', true),
  ];

  assert.match(addWeed(rows, input({ where: 'src/new.ts:1' }), now).status, /^added /);
});

test('the CLI keeps the queue in .garden/weeds.jsonl when no --file is given', (t) => {
  const dir = queue(t);

  const result = spawnSync(
    process.execPath,
    [script, 'add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type'],
    { cwd: dir, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(dir, '.garden', 'weeds.jsonl'), 'utf8')
      .trim()
      .split('\n').length,
    1,
  );
});

test('groups prints a header, then a row per class with its layer or a dash and the date first seen', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type', '--layer', '3']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/b.ts:1', '--source', 'census:todo-marker']);

  const lines = cli(dir, ['groups']).stdout.trimEnd().split('\n');

  assert.equal(lines[0], `${'class'.padEnd(36)} open places regrown layer first-seen`);
  assert.match(lines[1] ?? '', /^any-type +1 +1 +0 +3 \d{4}-\d{2}-\d{2}$/);
  assert.match(lines[2] ?? '', /^todo-marker +1 +1 +0 +- \d{4}-\d{2}-\d{2}$/);
});

test('groups --min leaves out classes with fewer open weeds, and refuses a minimum below 1', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/c.ts:1', '--source', 'census:todo-marker']);

  const rows = cli(dir, ['groups', '--min', '2']).stdout.trimEnd().split('\n').slice(1);

  assert.deepEqual(
    rows.map((row) => row.split(' ')[0]),
    ['any-type'],
  );
  assert.equal(cli(dir, ['groups', '--min', '0']).code, 2);
});

test('close takes one weed by id and leaves the rest of its class open', (t) => {
  const dir = queue(t);
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, ['close', '--id', target, '--by', 'abc1234']);

  assert.equal(result.stdout, 'closed 1\n');
  assert.deepEqual(
    cli(dir, ['list'])
      .stdout.trimEnd()
      .split('\n')
      .map((line) => line.split(' ')[2]),
    ['src/b.ts:1'],
  );
});

test('a close without its target or with a blank --by is a usage error that names what it needs', (t) => {
  const dir = queue(t);
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );

  const noId = cli(dir, ['close', '--by', 'abc1234']);
  const noClass = cli(dir, ['close-class', '--by', 'abc1234']);
  const blankBy = cli(dir, ['close', '--id', target, '--by', ' ']);

  assert.deepEqual([noId.code, noClass.code, blankBy.code], [2, 2, 2]);
  assert.equal(noId.stderr, 'weeds close: needs --id and --by\n');
  assert.equal(noClass.stderr, 'weeds close-class: needs --class and --by\n');
});

test('a close that finds nothing open exits 1 and names its target', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['close-class', '--class', 'any-type', '--by', 'abc1234']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'weeds close-class: nothing open for any-type\n');
});

test('closing a class of several weeds appends one valid row per weed', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--by', 'abc1234']);

  assert.equal(closed.stdout, 'closed 2\n');
  assert.equal(readQueue(join(dir, 'weeds.jsonl')).length, 4);
});

test('add says which flag is wrong', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['add', '--class', 'any-type', '--source', 'census:any-type']);

  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'weeds add: --where must not be empty\n');
});

test('list prints each open weed as id, class, place, source and note, and --class keeps one class', (t) => {
  const dir = queue(t);
  const id = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/b.ts:2', '--source', 'commit:abc1234', '--note', 'later']);

  const one = cli(dir, ['list', '--class', 'any-type']).stdout;
  const all = cli(dir, ['list']).stdout.trimEnd().split('\n');

  assert.equal(one, `${id} any-type src/a.ts:1 [census:any-type] \n`);
  assert.equal(all.length, 2);
  assert.match(all[1] ?? '', / todo-marker src\/b\.ts:2 \[commit:abc1234\] later$/);
});

test('a word after the command is a usage error and queues nothing', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['add', 'any-type', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts/);
  assert.equal(readQueue(join(dir, 'weeds.jsonl')).length, 0);
});

test('an unknown command prints the usage line', (t) => {
  const result = cli(queue(t), ['prune']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts add\|close\|close-class\|groups\|list/);
});
