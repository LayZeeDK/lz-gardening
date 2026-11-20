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
      `weeds decline: --read ${stale} is not the token weeds lines --class any-type prints for this census; run it again and read every line it prints\n`,
      0,
    ],
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
      'weeds decline: run weeds lines --class any-type, read every line it prints, and pass the token on its last line as --read\n',
      0,
      0,
    ],
  );
});
