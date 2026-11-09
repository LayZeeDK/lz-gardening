// Run: node --test weeds.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addWeed, groupWeeds, openWeeds, parseRow, readQueue, validateAdd, weedId } from './weeds.ts';
import type { AddInput, CloseKind, CloseRow, Row, Weed } from './weeds.ts';

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
    regrownAfter: null,
    ...fields,
  };
}

const tendClose: CloseRow = {
  op: 'close',
  id: 'x',
  at: now.toISOString(),
  by: 'bed/any-type@1a2b3c4',
  kind: 'tended',
  check: null,
};

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
  const result = spawnSync(process.execPath, [script, ...args, '--file', join(dir, '.garden', 'weeds.jsonl')], {
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

test('a weed closed as a one-off comes back added, not regrown: no check was written to hold it', () => {
  const first = addWeed([], input(), now);
  assert.ok(first.row);
  const rows: Row[] = [
    first.row,
    { op: 'close', id: first.row.id, at: now.toISOString(), by: 'generated code', kind: 'one-off', check: null },
  ];

  const back = addWeed(rows, input(), now);
  assert.ok(back.row);
  assert.equal(back.status, `added ${back.row.id}`);

  const weeds = openWeeds([...rows, back.row]);
  assert.equal(weeds.length, 1);
  assert.equal(weeds[0]?.regrownAfter, null);
});

test('a weed of a class a tend pass closed is regrown wherever it comes back, naming the bed and its check', () => {
  const first = addWeed([], input({ where: 'src/a.spec.ts:3', source: 'commit:aaa1111' }), now);
  assert.ok(first.row);
  const tended: Row = {
    op: 'close',
    id: first.row.id,
    at: now.toISOString(),
    by: 'bed/hollow-assertion@bbb2222',
    kind: 'tended',
    check: 'eslint.config.mjs',
  };

  const back = addWeed([first.row, tended], input({ where: 'src/b.spec.ts:8', source: 'commit:ccc3333' }), now);

  assert.ok(back.row);
  assert.equal(back.status, `regrown ${back.row.id} after bed/hollow-assertion@bbb2222 (check: eslint.config.mjs)`);
});

test('a weed of a class tended twice is judged against the latest tend pass', () => {
  const tend = (id: string, sha: string, check: string | null): Row => ({
    op: 'close',
    id,
    at: now.toISOString(),
    by: `bed/any-type@${sha}`,
    kind: 'tended',
    check,
  });
  const rows: Row[] = [
    weed({ id: 'first' }),
    tend('first', 'aaa1111', 'tsconfig.json'),
    weed({ id: 'second', where: 'src/b.ts:2' }),
    tend('second', 'bbb2222', null),
  ];

  const back = addWeed(rows, input({ class: 'any-type', where: 'src/c.ts:3', source: 'commit:ccc3333' }), now);

  assert.equal(back.status, `regrown ${back.row?.id ?? ''} after bed/any-type@bbb2222`);
});

test('a one-off close after a tend pass leaves the class tended: the check it added still stands', () => {
  const close = (id: string, kind: CloseKind, by: string, check: string | null): Row => ({
    op: 'close',
    id,
    at: now.toISOString(),
    by,
    kind,
    check,
  });
  const rows: Row[] = [
    weed({ id: 'first' }),
    close('first', 'tended', 'bed/any-type@aaa1111', 'tsconfig.json'),
    weed({ id: 'back', where: 'src/b.ts:2' }),
    close('back', 'one-off', 'generated code', null),
  ];

  const again = addWeed(rows, input({ class: 'any-type', where: 'src/c.ts:3', source: 'commit:ccc3333' }), now);

  assert.equal(again.status, `regrown ${again.row?.id ?? ''} after bed/any-type@aaa1111 (check: tsconfig.json)`);
});

test('the replayed queue marks a weed regrown when a tend pass closed its class before it was added', () => {
  const tendedWeed = weed({ id: 'tended', class: 'any-type', where: 'src/a.ts:1' });
  const rows: Row[] = [
    tendedWeed,
    { op: 'close', id: 'tended', at: now.toISOString(), by: 'bed/any-type@1a2b3c4', kind: 'tended', check: null },
    weed({ id: 'back', class: 'any-type', where: 'src/b.ts:7' }),
    weed({ id: 'other', class: 'todo-marker', where: 'src/b.ts:9' }),
  ];

  assert.deepEqual(
    openWeeds(rows).map((item) => [item.id, item.regrownAfter !== null]),
    [
      ['back', true],
      ['other', false],
    ],
  );
});

test('a weed closed with keep is never queued again', () => {
  const first = addWeed([], input(), now);
  assert.ok(first.row);
  const rows: Row[] = [
    first.row,
    {
      op: 'close',
      id: first.row.id,
      at: now.toISOString(),
      by: 'intentional: generated code',
      kind: 'kept',
      check: null,
    },
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

test('validation refuses a place, source or note holding a control character, which list would print raw', () => {
  assert.deepEqual(
    [
      validateAdd(input({ where: 'src/a.ts:1\nadded deadbeef00' })),
      validateAdd(input({ source: 'commit:abc1234\r' })),
      validateAdd(input({ note: 'cast\tto any' })),
    ],
    [
      '--where must be one line of text without control characters',
      '--source must be one line of text without control characters',
      '--note must be one line of text without control characters',
    ],
  );
});

test('validation also refuses line and paragraph separators and bidirectional controls', () => {
  assert.deepEqual(
    [0x2028, 0x2029, 0x202e].map((codePoint) =>
      validateAdd(input({ note: `cast${String.fromCodePoint(codePoint)}to any` })),
    ),
    Array.from({ length: 3 }, () => '--note must be one line of text without control characters'),
  );
});

test('validation takes the joiners that words and emoji need in paths and notes', () => {
  const nonJoiner = String.fromCodePoint(0x200c);
  const joiner = String.fromCodePoint(0x200d);

  assert.deepEqual(
    [
      validateAdd(input({ where: `src/mi${nonJoiner}khaham.ts:1` })),
      validateAdd(input({ note: `copied from the ${joiner} sequence` })),
    ],
    [null, null],
  );
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
    cli(dir, [
      'close-class',
      '--class',
      'hollow-assertion',
      '--tended',
      'bed/hollow-assertion@abc1234',
      '--check',
      'scripts/hollow-assertion.test.mjs',
    ]).stdout,
    cli(dir, add).stdout,
    cli(dir, ['close-class', '--class', 'hollow-assertion', '--keep', 'on purpose']).stdout,
    cli(dir, add).stdout,
  ];

  assert.deepEqual(
    statuses.map((status) => status.split(' ')[0]),
    ['added', 'seen', 'closed', 'regrown', 'kept', 'kept'],
  );
});

test('through the CLI a tend close records its bed and check, and a weed of the class elsewhere names both', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);

  const closed = cli(dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    'bed/any-type@bbb2222',
    '--check',
    'eslint.config.mjs',
  ]);
  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:4', '--source', 'commit:ccc3333']);

  const file = join(dir, '.garden', 'weeds.jsonl');
  const [first, close] = readQueue(file);

  assert.equal(closed.stdout, 'closed 1\n');
  assert.match(back.stdout, /^regrown [0-9a-f]{10} after bed\/any-type@bbb2222 \(check: eslint\.config\.mjs\)\n$/);
  assert.equal(
    readFileSync(file, 'utf8').split('\n')[1],
    JSON.stringify({
      op: 'close',
      id: first?.id,
      at: close?.at,
      by: 'bed/any-type@bbb2222',
      kind: 'tended',
      check: 'eslint.config.mjs',
    }),
  );
});

test('through the CLI a one-off close and a keep each record their reason and kind', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);
  const oneOff = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/b.ts:2', '--source', 'commit:aaa1111']);
  const kept = cli(dir, ['close-class', '--class', 'todo-marker', '--keep', 'tracked in the issue tracker']);

  assert.deepEqual([oneOff.stdout, kept.stdout], ['closed 1\n', 'kept 1\n']);
  assert.deepEqual(
    readQueue(file).flatMap((row) => (row.op === 'close' ? [[row.by, row.kind, row.check]] : [])),
    [
      ['generated code', 'one-off', null],
      ['tracked in the issue tracker', 'kept', null],
    ],
  );
});

test('list shows a regrown weed with the bed and check it came back after', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);
  cli(dir, ['close-class', '--class', 'any-type', '--tended', 'bed/any-type@bbb2222', '--check', 'eslint.config.mjs']);
  const id = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:4', '--source', 'commit:ccc3333', '--note', 'cast'])
      .stdout,
  );

  assert.equal(
    cli(dir, ['list', '--class', 'any-type']).stdout,
    `${id} any-type src/b.ts:4 [commit:ccc3333] [regrown after bed/any-type@bbb2222 (check: eslint.config.mjs)] cast\n`,
  );
});

test('the CLI exits 2 on a malformed queue instead of treating it as empty', (t) => {
  const dir = queue(t);
  mkdirSync(join(dir, '.garden'));
  writeFileSync(join(dir, '.garden', 'weeds.jsonl'), 'not json\n');

  const result = cli(dir, ['list']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /weeds: queue line 1/);
});

test('a mistyped flag is a usage error, not ignored', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['list', '--clas', 'hollow-assertion']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--clas/);
});

test('groups refuses a --min that is not a positive whole number, rather than hiding every class', (t) => {
  const dir = queue(t);

  for (const min of ['two', '0']) {
    const result = cli(dir, ['groups', '--min', min]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--min/);
  }
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

test('a close row written before close kinds reads its kind from keep and by', () => {
  const close = (fields: string): Row => parseRow(`{"op":"close","id":"x","at":"t",${fields}}`, 1);

  assert.deepEqual(
    [
      close('"by":"generated code","keep":true'),
      close('"by":"bed/any-type@1a2b3c4","keep":false'),
      close('"by":"one-off: generated code"'),
    ],
    [
      { op: 'close', id: 'x', at: 't', by: 'generated code', kind: 'kept', check: null },
      { op: 'close', id: 'x', at: 't', by: 'bed/any-type@1a2b3c4', kind: 'tended', check: null },
      { op: 'close', id: 'x', at: 't', by: 'one-off: generated code', kind: 'one-off', check: null },
    ],
  );
});

test('a close row with a kind the script does not know fails loudly instead of reading as another kind', () => {
  assert.throws(
    () => parseRow('{"op":"close","id":"x","at":"t","by":"bed/any-type@1a2b3c4","kind":"fixed"}', 2),
    /^Error: queue line 2: unknown close kind "fixed"$/,
  );
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

test('a group counts a file once with or without a line, counts regrown weeds, and takes the lowest layer and first sighting', () => {
  const [group] = groupWeeds([
    weed({ where: 'src/a.ts:12', at: '2026-11-07T10:00:00.000Z', layer: 3, regrownAfter: tendClose }),
    weed({ where: 'src/a.ts:34', at: '2026-11-06T09:00:00.000Z', layer: 1, regrownAfter: tendClose }),
    weed({ where: 'src/a.ts', at: '2026-11-08T00:00:00.000Z' }),
    weed({ where: 'src/x:1.ts:4' }),
    weed({ where: 'src/x:1.ts:9' }),
  ]);

  assert.deepEqual(group, {
    class: 'any-type',
    open: 5,
    places: 2,
    regrown: 2,
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
    weed({ class: 'c-regrown', where: 'c', regrownAfter: tendClose }),
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
  const close = (id: string, kind: CloseKind): Row => ({
    op: 'close',
    id,
    at: now.toISOString(),
    by: 'abc1234',
    kind,
    check: null,
  });
  const rows: Row[] = [
    weed({ id: 'open', where: 'src/open.ts:1' }),
    weed({ id: 'closed', where: 'src/closed.ts:1' }),
    close('closed', 'one-off'),
    weed({ id: 'kept', where: 'src/kept.ts:1' }),
    close('kept', 'kept'),
  ];

  assert.match(addWeed(rows, input({ where: 'src/new.ts:1' }), now).status, /^added /);
});

test('a new weed of an untended class is added even when an open weed of another class is regrown', () => {
  const first = addWeed([], input({ where: 'src/a.spec.ts:3', source: 'commit:aaa1111' }), now);
  assert.ok(first.row);
  const tended: Row = { ...tendClose, id: first.row.id, by: 'bed/hollow-assertion@bbb2222' };
  const back = addWeed([first.row, tended], input({ where: 'src/b.spec.ts:8', source: 'commit:ccc3333' }), now);
  assert.ok(back.row);
  assert.match(back.status, /^regrown /);

  const other = addWeed(
    [first.row, tended, back.row],
    input({ class: 'todo-marker', where: 'src/c.ts:1', source: 'census:todo-marker' }),
    now,
  );

  assert.ok(other.row);
  assert.equal(other.status, `added ${other.row.id}`);
});

test('the CLI refuses a --file outside a .garden folder and writes nothing', (t) => {
  const dir = queue(t);
  const target = join(dir, 'profile');

  const result = spawnSync(
    process.execPath,
    [script, 'add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type', '--file', target],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\.garden\/weeds\.jsonl/);
  assert.equal(existsSync(target), false);
});

test('the CLI refuses a --file that only starts with .garden/weeds.jsonl', (t) => {
  const dir = queue(t);
  const target = join(dir, '.garden', 'weeds.jsonl.sh');

  const result = spawnSync(
    process.execPath,
    [script, 'add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type', '--file', target],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.equal(existsSync(target), false);
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

  const result = cli(dir, ['groups']);
  const lines = result.stdout.trimEnd().split('\n');

  assert.equal(result.code, 0);
  assert.equal(lines[0], `${'class'.padEnd(36)} open places regrown layer first-seen`);
  assert.match(lines[1] ?? '', new RegExp(`^${'any-type'.padEnd(36)}    1      1       0     3 \\d{4}-\\d{2}-\\d{2}$`));
  assert.match(
    lines[2] ?? '',
    new RegExp(`^${'todo-marker'.padEnd(36)}    1      1       0     - \\d{4}-\\d{2}-\\d{2}$`),
  );
});

test('groups --min leaves out classes with fewer open weeds', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/c.ts:1', '--source', 'census:todo-marker']);

  const rows = cli(dir, ['groups', '--min', '2']).stdout.trimEnd().split('\n').slice(1);

  assert.deepEqual(
    rows.map((row) => row.split(' ')[0]),
    ['any-type'],
  );
});

test('close takes one weed by id and leaves the rest of its class open', (t) => {
  const dir = queue(t);
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, ['close', '--id', target, '--one-off', 'generated code']);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'closed 1\n');
  assert.deepEqual(
    cli(dir, ['list'])
      .stdout.trimEnd()
      .split('\n')
      .map((line) => line.split(' ')[2]),
    ['src/b.ts:1'],
  );
});

test('a close needs its target and exactly one non-blank kind of close, and writes nothing without them', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );

  const results = [
    cli(dir, ['close', '--one-off', 'generated code']),
    cli(dir, ['close-class', '--keep', 'on purpose']),
    cli(dir, ['close', '--id', target]),
    cli(dir, ['close', '--id', target, '--one-off', ' ']),
    cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code', '--keep', 'on purpose']),
  ];

  assert.deepEqual(
    results.map((result) => [result.code, result.stderr]),
    [
      [2, 'weeds close: needs --id and exactly one of --tended, --one-off or --keep\n'],
      [2, 'weeds close-class: needs --class and exactly one of --tended, --one-off or --keep\n'],
      [2, 'weeds close: needs --id and exactly one of --tended, --one-off or --keep\n'],
      [2, 'weeds close: needs --id and exactly one of --tended, --one-off or --keep\n'],
      [2, 'weeds close-class: needs --class and exactly one of --tended, --one-off or --keep\n'],
    ],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a tend close needs a bed of the class it closes and a check, and a check goes with a tend close only', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  const closeClass = ['close-class', '--class', 'any-type'];

  const results = [
    cli(dir, [...closeClass, '--tended', 'bed/any-type@1a2b3c4']),
    cli(dir, [...closeClass, '--one-off', 'generated code', '--check', 'eslint.config.mjs']),
    cli(dir, [...closeClass, '--tended', 'bed/todo-marker@1a2b3c4', '--check', 'eslint.config.mjs']),
    cli(dir, [...closeClass, '--tended', 'any-type@1a2b3c4', '--check', 'eslint.config.mjs']),
  ];

  assert.deepEqual(
    results.map((result) => [result.code, result.stderr]),
    [
      [2, 'weeds close-class: --tended needs --check <where the check lives>\n'],
      [2, 'weeds close-class: --check goes with --tended only\n'],
      [2, 'weeds close-class: --tended must be bed/any-type@<commit>, got bed/todo-marker@1a2b3c4\n'],
      [2, 'weeds close-class: --tended must be bed/any-type@<commit>, got any-type@1a2b3c4\n'],
    ],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a tend close refuses a bed with anything in front of bed/<class>@<commit>', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    'xbed/any-type@1a2b3c4',
    '--check',
    'eslint.config.mjs',
  ]);

  assert.deepEqual(
    [result.code, result.stderr],
    [2, 'weeds close-class: --tended must be bed/any-type@<commit>, got xbed/any-type@1a2b3c4\n'],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a tend close refuses a bed with anything after bed/<class>@<commit>', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    'bed/any-type@1a2b3c4-extra',
    '--check',
    'eslint.config.mjs',
  ]);

  assert.deepEqual(
    [result.code, result.stderr],
    [2, 'weeds close-class: --tended must be bed/any-type@<commit>, got bed/any-type@1a2b3c4-extra\n'],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a tend close refuses a check of only spaces, which names no place', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, ['close-class', '--class', 'any-type', '--tended', 'bed/any-type@1a2b3c4', '--check', '   ']);

  assert.deepEqual(
    [result.code, result.stderr],
    [2, 'weeds close-class: --tended needs --check <where the check lives>\n'],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a tend close takes a whole class: close by id refuses --tended and leaves the class untended', (t) => {
  const dir = queue(t);
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );

  const result = cli(dir, ['close', '--id', target, '--tended', 'bed/any-type@1a2b3c4', '--check', 'tsconfig.json']);
  const next = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  assert.deepEqual(
    [result.code, result.stderr],
    [2, 'weeds close: --tended closes a whole class; use close-class --class <class>\n'],
  );
  assert.match(next.stdout, /^added /);
});

test('a close refuses a reason or check holding a control character, which later output would print raw', (t) => {
  const dir = queue(t);
  const file = join(dir, '.garden', 'weeds.jsonl');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  const closeClass = ['close-class', '--class', 'any-type'];

  const results = [
    cli(dir, [...closeClass, '--tended', 'bed/any-type@1a2b3c4', '--check', 'eslint.config.mjs\nadded deadbeef00']),
    cli(dir, [...closeClass, '--one-off', 'generated\tcode']),
  ];

  assert.deepEqual(
    results.map((result) => [result.code, result.stderr]),
    [
      [2, 'weeds close-class: --check must be one line of text without control characters\n'],
      [2, 'weeds close-class: --one-off must be one line of text without control characters\n'],
    ],
  );
  assert.equal(readQueue(file).length, 1);
});

test('a close that finds nothing open exits 1 and names its target', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'weeds close-class: nothing open for any-type\n');
});

test('closing a class of several weeds appends one valid row per weed', (t) => {
  const dir = queue(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);

  assert.equal(closed.stdout, 'closed 2\n');
  assert.equal(readQueue(join(dir, '.garden', 'weeds.jsonl')).length, 4);
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

  const listed = cli(dir, ['list', '--class', 'any-type']);
  const all = cli(dir, ['list']).stdout.trimEnd().split('\n');

  assert.equal(listed.code, 0);
  assert.equal(listed.stdout, `${id} any-type src/a.ts:1 [census:any-type] \n`);
  assert.equal(all.length, 2);
  assert.match(all[1] ?? '', / todo-marker src\/b\.ts:2 \[commit:abc1234\] later$/);
});

test('a word after the command is a usage error and queues nothing', (t) => {
  const dir = queue(t);

  const result = cli(dir, ['add', 'any-type', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts/);
  assert.equal(readQueue(join(dir, '.garden', 'weeds.jsonl')).length, 0);
});

test('an unknown command prints the usage line', (t) => {
  const result = cli(queue(t), ['prune']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts add\|close\|close-class\|groups\|list/);
});
