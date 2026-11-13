// Run: node --test weeds.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { planAdd, replay, stamp, weedId } from './log.ts';
import type { AddEvent, AddInput, AddOutcome, EventDraft, GardenEvent, OpenWeed, TendedClose } from './log.ts';
import { commit, repo } from './test-repo.ts';
import { planted } from './test-site.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import { cli, now, script } from './test-weeds.ts';
import { addStatus, groupWeeds, validateAdd } from './weeds.ts';

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

function weed(fields: Partial<OpenWeed>): OpenWeed {
  return {
    id: `${fields.where ?? 'src/a.ts:1'}@${fields.firstAt ?? now.toISOString()}`,
    firstAt: now.toISOString(),
    class: 'any-type',
    where: 'src/a.ts:1',
    source: 'census:any-type',
    note: '',
    layer: null,
    regrownAfter: null,
    ...fields,
  };
}

const tendClose: TendedClose = {
  op: 'close',
  uuid: '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6',
  clock: 1,
  at: now.toISOString(),
  ids: ['x'],
  class: 'any-type',
  by: 'bed/any-type@1a2b3c4',
  kind: 'tended',
  check: 'eslint.config.mjs',
};

function grow(events: readonly GardenEvent[], ...drafts: EventDraft[]): GardenEvent[] {
  return [...events, ...stamp(drafts, replay(events, now).maxClock, now)];
}

function draftOf(outcome: AddOutcome): EventDraft<AddEvent> {
  if (outcome.said === 'added' || outcome.said === 'regrown') {
    return outcome.draft;
  }

  throw new Error(`${outcome.said} plans no add`);
}

const notOffBase = (): boolean => false;

function closing(id: string, kind: 'one-off' | 'kept', by: string, weedClass = 'hollow-assertion'): EventDraft {
  return { op: 'close', ids: [id], class: weedClass, kind, by, check: null };
}

function tending(id: string, by: string, check: string, weedClass = 'any-type'): EventDraft {
  return { op: 'close', ids: [id], class: weedClass, kind: 'tended', by, check };
}

function idOf(status: string): string {
  return status.trim().split(' ')[1] ?? '';
}

function checkout(t: TestContext): string {
  return planted(t).dir;
}

test('add prints added for a new weed and seen for the same class, place and source', () => {
  const first = planAdd([], input(), now);
  const again = planAdd(grow([], draftOf(first)), input(), now);

  assert.deepEqual(
    [addStatus(first, notOffBase), addStatus(again, notOffBase)],
    [`added ${first.id}`, `seen ${first.id}`],
  );
});

test('add prints a regrown weed with the bed and check of the tend pass it came back after', () => {
  const first = draftOf(planAdd([], input({ where: 'src/a.spec.ts:3', source: 'commit:aaa1111' }), now));
  const tended = tending(first.id, 'bed/hollow-assertion@bbb2222', 'eslint.config.mjs', 'hollow-assertion');

  const back = planAdd(grow([], first, tended), input({ where: 'src/b.spec.ts:8', source: 'commit:ccc3333' }), now);

  assert.equal(
    addStatus(back, notOffBase),
    `regrown ${back.id} after bed/hollow-assertion@bbb2222 (check: eslint.config.mjs)`,
  );
});

test('add prints kept for a weed closed with keep, which stays out of the queue', () => {
  const first = draftOf(planAdd([], input(), now));
  const events = grow([], first, closing(first.id, 'kept', 'intentional: generated code'));

  const back = planAdd(events, input(), now);

  assert.equal(addStatus(back, notOffBase), `kept ${back.id}`);
  assert.deepEqual(replay(events, now).open, []);
});

test('groups count open weeds and distinct files per class, most first', () => {
  const drafts = [
    input(),
    input({ where: 'src/a.spec.ts:9', source: 'census:hollow-assertion' }),
    input({ where: 'src/b.spec.ts:1' }),
    input({ class: 'double-cast', where: 'src/c.ts:4', source: 'census:double-cast', layer: 1 }),
  ].map((item) => draftOf(planAdd([], item, now)));

  const groups = groupWeeds(replay(grow([], ...drafts), now).open);
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

test('validation refuses an absolute --where, so no machine path reaches the shared queue', () => {
  assert.deepEqual(
    [
      '/home/ada/repo/src/a.ts:1',
      'C:\\Users\\ada\\repo\\src\\a.ts:1',
      'd:/repo/src/a.ts',
      '\\\\server\\share\\a.ts',
    ].map((where) => validateAdd(input({ where }))),
    Array.from({ length: 4 }, () => '--where must be a repository-relative path'),
  );
});

test('validation refuses a --where in a home folder or above the repository, and takes dots inside a name', () => {
  assert.deepEqual(
    [
      '~/repo/src/a.ts:1',
      '~ada/a.ts',
      '../other/a.ts:1',
      'src/../../a.ts',
      'src\\..\\..\\a.ts',
      'src/a..b.ts:1',
      '.github/x.yml',
    ].map((where) => validateAdd(input({ where }))),
    [...Array.from({ length: 5 }, () => '--where must be a repository-relative path'), null, null],
  );
});

test('validation refuses a lesson source whose path is not repository-relative, and leaves other kinds alone', () => {
  assert.deepEqual(
    ['lesson:/home/ada/notes.md', 'lesson:../notes.md', 'lesson:docs/notes.md', 'commit:/abc'].map((source) =>
      validateAdd(input({ source })),
    ),
    [
      '--source lesson:<path> must be a repository-relative path',
      '--source lesson:<path> must be a repository-relative path',
      null,
      null,
    ],
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

test('through the CLI a weed is added, seen, regrown after a close, and kept out after a keep', (t) => {
  const dir = checkout(t);
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
  const { dir, garden } = planted(t);
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

  const close = [...logFiles(garden).values()].find((event) => event['op'] === 'close');

  assert.equal(closed.stdout, 'closed 1; local\n');
  assert.match(back.stdout, /^regrown [0-9a-f]{10} after bed\/any-type@bbb2222 \(check: eslint\.config\.mjs\)\n$/);
  assert.deepEqual(
    ['ids', 'class', 'by', 'kind', 'check'].map((field) => close?.[field]),
    [
      [weedId('any-type', 'src/a.ts:1', 'commit:aaa1111')],
      'any-type',
      'bed/any-type@bbb2222',
      'tended',
      'eslint.config.mjs',
    ],
  );
});

test('through the CLI a one-off close and a keep each record their reason and kind', (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);
  const oneOff = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/b.ts:2', '--source', 'commit:aaa1111']);
  const kept = cli(dir, ['close-class', '--class', 'todo-marker', '--keep', 'tracked in the issue tracker']);

  assert.deepEqual([oneOff.stdout, kept.stdout], ['closed 1; local\n', 'kept 1; local\n']);
  assert.deepEqual(
    [...logFiles(garden).values()]
      .filter((event) => event['op'] === 'close')
      .toSorted((a, b) => Number(a['clock']) - Number(b['clock']))
      .map((event) => [event['by'], event['kind'], event['check']]),
    [
      ['generated code', 'one-off', null],
      ['tracked in the issue tracker', 'kept', null],
    ],
  );
});

test('list shows a regrown weed with the bed and check it came back after', (t) => {
  const dir = checkout(t);
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

test('a mistyped flag is a usage error, not ignored', (t) => {
  const dir = checkout(t);

  const result = cli(dir, ['list', '--clas', 'hollow-assertion']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--clas/);
});

test('groups refuses a --min that is not a positive whole number, rather than hiding every class', (t) => {
  const dir = checkout(t);

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

test('a group counts a file once with or without a line, counts regrown weeds, and takes the lowest layer and first sighting', () => {
  const [group] = groupWeeds([
    weed({ where: 'src/a.ts:12', firstAt: '2026-11-07T10:00:00.000Z', layer: 3, regrownAfter: tendClose }),
    weed({ where: 'src/a.ts:34', firstAt: '2026-11-06T09:00:00.000Z', layer: 1, regrownAfter: tendClose }),
    weed({ where: 'src/a.ts', firstAt: '2026-11-08T00:00:00.000Z' }),
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

test('the CLI takes no --file, so it writes nowhere but the site', (t) => {
  const dir = checkout(t);
  const target = join(dir, 'profile');

  const result = cli(dir, [
    'add',
    '--class',
    'any-type',
    '--where',
    'src/a.ts:1',
    '--source',
    'census:any-type',
    '--file',
    target,
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--file/);
  assert.equal(existsSync(target), false);
});

test('groups prints a header, then a row per class with its layer or a dash and the date first seen', (t) => {
  const dir = checkout(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type', '--layer', '3']);
  cli(dir, ['add', '--class', 'todo-marker', '--where', 'src/b.ts:1', '--source', 'census:todo-marker']);

  const result = cli(dir, ['groups']);
  const lines = result.stdout.trimEnd().split('\n');

  assert.equal(result.code, 0);
  assert.equal(lines[0], `${'class'.padEnd(36)} open places regrown layer first-seen tending`);
  assert.match(
    lines[1] ?? '',
    new RegExp(`^${'any-type'.padEnd(36)}    1      1       0     3 \\d{4}-\\d{2}-\\d{2} -$`),
  );
  assert.match(
    lines[2] ?? '',
    new RegExp(`^${'todo-marker'.padEnd(36)}    1      1       0     - \\d{4}-\\d{2}-\\d{2} -$`),
  );
});

test('groups --min leaves out classes with fewer open weeds', (t) => {
  const dir = checkout(t);
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
  const dir = checkout(t);
  const target = idOf(
    cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']).stdout,
  );
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, ['close', '--id', target, '--one-off', 'generated code']);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'closed 1; local\n');
  assert.deepEqual(
    cli(dir, ['list'])
      .stdout.trimEnd()
      .split('\n')
      .map((line) => line.split(' ')[2]),
    ['src/b.ts:1'],
  );
});

test('a close needs its target and exactly one non-blank kind of close, and writes nothing without them', (t) => {
  const { dir, garden } = planted(t);
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
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close needs a bed of the class it closes and a check, and a check goes with a tend close only', (t) => {
  const { dir, garden } = planted(t);
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
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close refuses a bed with anything in front of bed/<class>@<commit>', (t) => {
  const { dir, garden } = planted(t);
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
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close refuses a bed with anything after bed/<class>@<commit>', (t) => {
  const { dir, garden } = planted(t);
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
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close refuses a check of only spaces, which names no place', (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);

  const result = cli(dir, ['close-class', '--class', 'any-type', '--tended', 'bed/any-type@1a2b3c4', '--check', '   ']);

  assert.deepEqual(
    [result.code, result.stderr],
    [2, 'weeds close-class: --tended needs --check <where the check lives>\n'],
  );
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close refuses a check that is not repository-relative and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  const tended = ['close-class', '--class', 'any-type', '--tended', 'bed/any-type@1a2b3c4', '--check'];

  const results = ['C:\\Users\\ada\\repo\\eslint.config.mjs', '~/eslint.config.mjs', '../eslint.config.mjs'].map(
    (check) => cli(dir, [...tended, check]),
  );

  assert.deepEqual(
    results.map((result) => [result.code, result.stderr]),
    Array.from({ length: 3 }, () => [2, 'weeds close-class: --check must be a repository-relative path\n']),
  );
  assert.equal(logFiles(garden).size, 1);
});

test('a tend close takes a whole class: close by id refuses --tended and leaves the class untended', (t) => {
  const dir = checkout(t);
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
  const { dir, garden } = planted(t);
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
  assert.equal(logFiles(garden).size, 1);
});

test('a close that finds nothing open exits 1 and names its target', (t) => {
  const dir = checkout(t);

  const result = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'weeds close-class: nothing open for any-type\n');
});

test('a close by id that finds nothing open exits 1 and names the id', (t) => {
  const dir = checkout(t);

  const result = cli(dir, ['close', '--id', '0123456789', '--one-off', 'generated code']);

  assert.deepEqual([result.code, result.stderr], [1, 'weeds close: nothing open for 0123456789\n']);
});

test('closing a class of several weeds appends one close event naming each weed', (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:any-type']);

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);

  assert.equal(closed.stdout, 'closed 2; local\n');
  assert.deepEqual(
    [...logFiles(garden).values()].flatMap((event) => (event['op'] === 'close' ? [event['ids']] : [])),
    [[weedId('any-type', 'src/a.ts:1', 'census:any-type'), weedId('any-type', 'src/b.ts:1', 'census:any-type')]],
  );
});

test('add says which flag is wrong', (t) => {
  const dir = checkout(t);

  const result = cli(dir, ['add', '--class', 'any-type', '--source', 'census:any-type']);

  assert.equal(result.code, 2);
  assert.equal(result.stderr, 'weeds add: --where must not be empty\n');
});

test('list prints each open weed as id, class, place, source and note, and --class keeps one class', (t) => {
  const dir = checkout(t);
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
  const { dir, garden } = planted(t);

  const result = cli(dir, ['add', 'any-type', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts/);
  assert.equal(logFiles(garden).size, 0);
});

test('a weed added in one process is seen in another, run from anywhere in the checkout', (t) => {
  const { dir } = planted(t);
  const add = [script, 'add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type'];

  const first = spawnSync(process.execPath, add, { cwd: dir, encoding: 'utf8' });
  const again = spawnSync(process.execPath, add, { cwd: join(dir, 'src'), encoding: 'utf8' });

  assert.deepEqual(
    [first.stdout, again.stdout],
    [
      `added ${weedId('any-type', 'src/a.ts:1', 'census:any-type')}\n`,
      `seen ${weedId('any-type', 'src/a.ts:1', 'census:any-type')}\n`,
    ],
  );
});

test('an event file the log cannot read is skipped and named, and the rest of the queue still lists', (t) => {
  const { dir, garden } = planted(t);
  const id = idOf(cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']).stdout);
  writeToLogByHand(garden, 'events/ab/abc.json', 'not json');

  const listed = cli(dir, ['list']);

  assert.deepEqual(
    [listed.code, listed.stdout, listed.stderr],
    [0, `${id} any-type src/a.ts:1 [census:x] \n`, 'weeds: skipped events/ab/abc.json: not JSON\n'],
  );
});

test('a skipped event file whose path breaks or reorders a line is named with those characters escaped', (t) => {
  const { dir, garden } = planted(t);
  writeToLogByHand(garden, 'events/ab/a b‮.json', 'not json');

  const listed = cli(dir, ['list']);

  assert.equal(listed.stderr, 'weeds: skipped events/ab/a\\u{2028}b\\u{202e}.json: not JSON\n');
});

test('a command that fails after reading the log still names the event files it skipped', (t) => {
  const { dir, garden } = planted(t);
  writeToLogByHand(garden, 'events/ab/abc.json', 'not json');
  writeFileSync(join(garden, '.git', 'refs', 'garden', 'log.lock'), '');

  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.equal(added.code, 2);
  assert.match(
    added.stderr,
    /^weeds: skipped events\/ab\/abc\.json: not JSON\nweeds: git fast-import refs\/garden\/log: .*cannot lock ref/s,
  );
});

test('a log in a newer format is refused with exit 2, and nothing is added to it', (t) => {
  const { dir, garden } = planted(t);
  writeToLogByHand(garden, 'garden.json', '{"format":2}');

  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.deepEqual(
    [added.code, added.stderr, logFiles(garden).size],
    [2, 'weeds: refs/garden/log is in format 2, which this version cannot read; update lz-gardening\n', 0],
  );
});

test('a close of a class another writer holds a claim on exits 1, names the holder and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);
  const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
  const until = '2999-01-01T00:00:00.000Z';
  const claim = {
    op: 'claim',
    uuid,
    clock: 9,
    at: now.toISOString(),
    class: 'any-type',
    writer: 'w',
    holder: 'ci on runner',
    until,
  };
  writeToLogByHand(garden, `events/0f/${uuid}.json`, JSON.stringify(claim));

  const result = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code']);

  assert.deepEqual(
    [result.code, result.stderr, logFiles(garden).size],
    [1, `weeds close-class: any-type is claimed by ci on runner until ${until}\n`, 2],
  );
});

test('an unknown command prints the usage line', (t) => {
  const result = cli(checkout(t), ['prune']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /^usage: weeds\.ts add\|close\|close-class\|claim\|release\|groups\|list/);
});

test('a usage error in a repository with no site names the usage error, not the missing site', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const results = [cli(dir, ['prune']), cli(dir, ['groups', '--min', '0'])];

  assert.deepEqual(
    results.map(({ code, stderr }) => [code, stderr]),
    [
      [2, 'usage: weeds.ts add|close|close-class|claim|release|groups|list ... (see the header of weeds.ts)\n'],
      [2, 'weeds groups: --min must be a whole number of at least 1, got 0\n'],
    ],
  );
});

function homeAt(t: TestContext, folder: string): void {
  for (const name of ['HOME', 'USERPROFILE']) {
    const was = process.env[name];
    t.after(() => {
      if (was === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = was;
      }
    });
    process.env[name] = folder;
  }
}

test('add takes a note that only looks like a path of this machine: a longer folder name, or a home folder at the root', (t) => {
  const { dir } = planted(t);
  const add = (where: string, note: string) =>
    cli(dir, ['add', '--class', 'any-type', '--where', where, '--source', 'census:any-type', '--note', note]).code;

  homeAt(t, join(sep, 'ada'));
  const longer = add('src/a.ts:1', `copied from ${join(sep, 'adams', 'notes.txt')}`);
  homeAt(t, parse(dir).root);
  const root = add('src/b.ts:1', `built in ${parse(dir).root}tmp, see https://example.com/x`);

  assert.deepEqual([longer, root], [0, 0]);
});

test("close-class refuses a reason holding the checkout's or the site's path, in any case and with either slash", (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  const flipped = (path: string): string =>
    path.includes('\\') ? path.replaceAll('\\', '/') : path.replaceAll('/', '\\');

  const checkoutPath = flipped(realpathSync.native(dir)).toUpperCase();
  const sitePath = flipped(realpathSync.native(garden)).toLowerCase();
  // A home folder that holds neither, as the temporary folders may lie in the real one.
  homeAt(t, join(sep, 'elsewhere'));

  const results = [
    cli(dir, ['close-class', '--class', 'any-type', '--keep', `generated into ${checkoutPath}`]),
    cli(dir, ['close-class', '--class', 'any-type', '--one-off', `only in ${sitePath}/beds`]),
  ];

  assert.deepEqual(
    [...results.map((result) => [result.code, result.stderr]), logFiles(garden).size],
    [
      ...Array.from({ length: 2 }, () => [
        2,
        'weeds: the by holds a path on this machine; the queue is shared with the repository, so write paths repository-relative\n',
      ]),
      1,
    ],
  );
});

test("add refuses a note holding this machine's home folder and writes nothing", (t) => {
  const { dir, garden } = planted(t);

  const result = cli(dir, [
    'add',
    '--class',
    'any-type',
    '--where',
    'src/a.ts:1',
    '--source',
    'census:any-type',
    '--note',
    `copied from ${homedir()}${sep}notes.txt`,
  ]);

  assert.deepEqual(
    [result.code, result.stderr, logFiles(garden).size],
    [
      2,
      'weeds: the note holds a path on this machine; the queue is shared with the repository, so write paths repository-relative\n',
      0,
    ],
  );
});
