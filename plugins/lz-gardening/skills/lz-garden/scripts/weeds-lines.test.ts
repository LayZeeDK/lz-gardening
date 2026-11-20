// Run: node --test weeds-lines.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSite } from './store-log.ts';
import { logFiles } from './test-log.ts';
import { censusText, planted, writeCensusText } from './test-site.ts';
import { cli, readToken, seedListed } from './test-weeds.ts';

test('lines prints each seed line of the class with the hits the census holds for it', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: {
        'any-type': ['src/a.ts:1: const a: any = 1;', 'src/a.ts:4: let b: any;', 'src/b.ts:2: const c: any = 2;'],
      },
    }),
  );

  const listed = cli(dir, ['lines', '--class', 'any-type']);

  assert.deepEqual(
    [listed.status, listed.stdout.split('\n').slice(0, 5)],
    [
      0,
      [
        '= [any-type] src/a.ts 2',
        'src/a.ts:1: const a: any = 1;',
        'src/a.ts:4: let b: any;',
        '= [any-type] src/b.ts 1',
        'src/b.ts:2: const c: any = 2;',
      ],
    ],
  );
});

test('lines ends with the token a decline of the class takes as proof that its lines were read', (t) => {
  const dir = seedListed(t);

  const listed = cli(dir, ['lines', '--class', 'any-type']);

  assert.match(listed.stdout, /\nread any-type [0-9a-f]{12}\n$/);
});

test('decline refuses a token lines printed for another census, and records nothing', (t) => {
  const dir = seedListed(t);
  const stale = readToken(dir, 'any-type');
  writeCensusText(
    openSite(dir).path,
    censusText('b'.repeat(40), { hits: { 'any-type': ['src/a.ts:1: const a: any = 1;'] } }),
  );

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'typed fixtures', '--read', stale]);

  assert.deepEqual(
    [declined.status, declined.stderr, logFiles(openSite(dir).path).size],
    [
      2,
      `weeds decline: --read ${stale} is not the token weeds lines --class any-type --census ${'b'.repeat(40)} prints; run it again and read every line it prints\n`,
      0,
    ],
  );
});

test("decline refuses another class's token from the same census", (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: { 'any-type': ['src/a.ts:1: const a: any = 1;'], 'ts-ignore': ['src/a.ts:2: // @ts-ignore'] },
    }),
  );

  const other = readToken(dir, 'ts-ignore');

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'typed fixtures', '--read', other]);

  assert.deepEqual(
    [declined.status, declined.stderr],
    [
      2,
      `weeds decline: --read ${other} is not the token weeds lines --class any-type --census ${'a'.repeat(40)} prints; run it again and read every line it prints\n`,
    ],
  );
});

test('decline refuses a token printed before the census of the same commit held other hits', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { hits: { 'any-type': ['src/a.ts:1: const a: any = 1;'] } }));
  const stale = readToken(dir, 'any-type');
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: { 'any-type': ['src/a.ts:1: const a: any = 1;', 'src/a.ts:2: let b: any;'] },
    }),
  );

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'typed fixtures', '--read', stale]);

  assert.deepEqual(
    [declined.status, declined.stderr],
    [
      2,
      `weeds decline: --read ${stale} is not the token weeds lines --class any-type --census ${'a'.repeat(40)} prints; run it again and read every line it prints\n`,
    ],
  );
});

test('lines prints a control character in a hit escaped, as the seed list does', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { hits: { 'any-type': ['src/a.ts:1: x\u001b[2J: any'] } }));

  const listed = cli(dir, ['lines', '--class', 'any-type']);

  assert.equal(listed.stdout.split('\n')[1], 'src/a.ts:1: x\\u{1b}[2J: any');
});

test('lines refuses a missing or malformed --class and prints no token', (t) => {
  const dir = seedListed(t);

  const results = [cli(dir, ['lines']), cli(dir, ['lines', '--class', 'Any Type'])];

  assert.deepEqual(
    results.map(({ status, stdout, stderr }) => [status, stdout, stderr]),
    [
      [2, '', 'weeds lines: --class must be kebab-case\n'],
      [2, '', 'weeds lines: --class must be kebab-case\n'],
    ],
  );
});

test('lines refuses a --census that is no full commit id, as decline does, and prints no token', (t) => {
  const dir = seedListed(t);

  const listed = cli(dir, ['lines', '--class', 'any-type', '--census', 'main']);

  assert.deepEqual(
    [listed.status, listed.stdout, listed.stderr],
    [2, '', 'weeds lines: --census must be the full commit id census.ts printed\n'],
  );
});

test('lines refuses a class no seed line names and prints no token', (t) => {
  const dir = seedListed(t);

  const listed = cli(dir, ['lines', '--class', 'ts-ignore']);

  assert.deepEqual(
    [listed.status, listed.stdout, listed.stderr],
    [2, '', 'weeds lines: no line of the seed list is ts-ignore; census:seed is for those lines alone\n'],
  );
});

test('lines refuses a garden with no census and prints no token', (t) => {
  const { dir } = planted(t);

  const listed = cli(dir, ['lines', '--class', 'any-type']);

  assert.deepEqual(
    [listed.status, listed.stdout, listed.stderr],
    [2, '', 'weeds lines: no line of the seed list is any-type; census:seed is for those lines alone\n'],
  );
});

test('decline refuses a --read with a control character, as it does every flag it prints', (t) => {
  const dir = seedListed(t);

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'r', '--read', 'x\u001b[2J']);

  assert.deepEqual(
    [declined.status, declined.stderr],
    [2, 'weeds decline: --read must be one line of text without control characters\n'],
  );
});

test('lines refuses duplicate-function, whose files are declined one at a time on quoted words', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { duplicates: { parse: ['src/b.ts', 'src/c.ts'] } }));

  const listed = cli(dir, ['lines', '--class', 'duplicate-function']);

  assert.deepEqual(
    [listed.status, listed.stdout, listed.stderr],
    [2, '', 'weeds lines: duplicate-function takes no token; decline its files one at a time on quoted words\n'],
  );
});

test('a duplicate-function decline refuses --read, which only a pattern class takes', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { duplicates: { parse: ['src/b.ts', 'src/c.ts'] } }));

  const declined = cli(dir, [
    'decline',
    '--class',
    'duplicate-function',
    '--where',
    'src/b.ts',
    '--reason',
    'r',
    '--read',
    '0123456789ab',
  ]);

  assert.deepEqual(
    [declined.status, declined.stderr, logFiles(garden).size],
    [2, 'weeds decline: --read goes with a class other than duplicate-function only\n', 0],
  );
});

test('decline of a pattern class without --read is refused and records nothing', (t) => {
  const dir = seedListed(t);

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'typed fixtures']);

  assert.deepEqual(
    [
      declined.status,
      declined.stderr,
      cli(dir, ['lines', '--class', 'any-type']).status,
      logFiles(openSite(dir).path).size,
    ],
    [
      2,
      `weeds decline: run weeds lines --class any-type --census ${'a'.repeat(40)}, read every line it prints, and pass the token on its last line as --read\n`,
      0,
      0,
    ],
  );
});
