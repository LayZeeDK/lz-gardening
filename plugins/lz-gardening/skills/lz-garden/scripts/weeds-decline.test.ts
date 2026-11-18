// Run: node --test weeds-decline.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { weedId } from './log.ts';
import { commit, git } from './test-repo.ts';
import { censusText, planted, writeCensusText } from './test-site.ts';
import { logFiles } from './test-log.ts';
import { bedFromMain, cli, seedListed } from './test-weeds.ts';

test('decline takes --where once: a second one is refused and nothing is recorded', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: { 'any-type': ['src/a.ts:1: const a: any = 1;', 'src/b.ts:1: const b: any = 1;'] },
    }),
  );

  const declined = cli(dir, [
    'decline',
    '--class',
    'any-type',
    '--where',
    'src/a.ts',
    '--where',
    'src/b.ts',
    '--reason',
    'typed fixtures',
  ]);

  assert.deepEqual(
    [declined.status, declined.stderr, logFiles(garden).size],
    [2, 'weeds decline: --where goes once with decline\n', 0],
  );
});

test('decline keeps a seed line out of the queue, so the seed pass adding it later prints kept', (t) => {
  const dir = seedListed(t);
  const id = weedId('any-type', 'src/a.ts', 'census:seed');

  const declined = cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts', '--reason', 'a typed fixture']);
  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts', '--source', 'census:seed']);

  assert.deepEqual(
    [declined.status, declined.stdout, added.stdout, cli(dir, ['list']).stdout],
    [0, `kept ${id}\n`, `kept ${id}\n`, ''],
  );
});

test('decline without --where keeps every seed line of its class that is neither queued nor declined', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: {
        'any-type': ['src/a.ts:1: const a: any = 1;', 'src/b.ts:1: const b: any = 1;', 'src/c.ts:1: let c: any;'],
        'ts-ignore': ['src/d.ts:1: // @ts-ignore'],
      },
    }),
  );
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:seed']);

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'typed fixtures']);
  const later = [
    ['any-type', 'src/a.ts'],
    ['any-type', 'src/c.ts'],
    ['ts-ignore', 'src/d.ts'],
  ].map(
    ([weedClass = '', where = '']) =>
      cli(dir, ['add', '--class', weedClass, '--where', where, '--source', 'census:seed']).stdout.split(' ')[0],
  );

  assert.deepEqual(
    [declined.status, declined.stdout, later],
    [0, 'declined 2 seed lines of any-type\n', ['kept', 'kept', 'added']],
  );
});

test('decline without --where refuses duplicate-function: each documented copy is declined on its own words', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { duplicates: { foo: ['src/x.ts', 'src/y.ts'] } }));

  const declined = cli(dir, ['decline', '--class', 'duplicate-function', '--reason', 'generated pairs']);

  assert.deepEqual(
    [declined.status, declined.stderr, logFiles(garden).size],
    [
      2,
      'weeds decline: decline duplicate-function one file at a time, --where <path>, on the words that keep that copy\n',
      0,
    ],
  );
});

test('a duplicate-function decline whose reason the file does not hold at the census commit is refused', (t) => {
  const { dir, garden } = planted(t);
  commit(dir, {
    'src/x.ts': 'export function foo() {}\n',
    'src/y.ts': '// Generated from src/x.ts; edit that file.\nexport function foo() {}\n',
  });
  writeCensusText(
    garden,
    censusText(git(dir, ['rev-parse', 'HEAD']), { duplicates: { foo: ['src/x.ts', 'src/y.ts'] } }),
  );

  const declined = cli(dir, [
    'decline',
    '--class',
    'duplicate-function',
    '--where',
    'src/y.ts',
    '--reason',
    'a local closure, nothing another file can import',
  ]);

  assert.deepEqual(
    [declined.status, declined.stderr, logFiles(garden).size],
    [
      2,
      "weeds decline: --reason must quote the words that keep this copy, as src/y.ts holds them at the census's commit\n",
      0,
    ],
  );
});

test('a duplicate-function decline may quote a comment that wraps across lines, on one line', (t) => {
  const { dir, garden } = planted(t);
  commit(dir, {
    'src/x.ts': 'export function foo() {}\n',
    'src/y.ts': '/**\n * Generated from src/x.ts;\n * edit that file.\n */\nexport function foo() {}\n',
    'src/z.ts': '// Kept apart: the browser bundle\n//   cannot import src/x.ts.\nexport function foo() {}\n',
  });
  writeCensusText(
    garden,
    censusText(git(dir, ['rev-parse', 'HEAD']), { duplicates: { foo: ['src/x.ts', 'src/y.ts', 'src/z.ts'] } }),
  );

  const declined = [
    ['src/y.ts', 'Generated from src/x.ts; edit that file.'],
    ['src/z.ts', 'the browser bundle cannot import src/x.ts'],
  ].map(([where = '', reason = '']) =>
    cli(dir, ['decline', '--class', 'duplicate-function', '--where', where, '--reason', reason]),
  );

  assert.deepEqual(
    declined.map(({ status, stderr }) => [status, stderr]),
    [
      [0, ''],
      [0, ''],
    ],
  );
});

function declinedOnWords(t: TestContext, files: Readonly<Record<string, string>>, reasons: readonly string[]) {
  const { dir, garden } = planted(t);
  const paths = Object.keys(files);
  commit(dir, { 'src/x.ts': 'export function foo() {}\n', ...files });
  writeCensusText(garden, censusText(git(dir, ['rev-parse', 'HEAD']), { duplicates: { foo: ['src/x.ts', ...paths] } }));

  return paths.map((where, index) =>
    cli(dir, ['decline', '--class', 'duplicate-function', '--where', where, '--reason', reasons[index] ?? '']),
  );
}

test('a duplicate-function decline matches a quote across lines that open with ///, /**, ** or ##, and trims the reason', (t) => {
  const declined = declinedOnWords(
    t,
    {
      'src/a.ts': '/// Kept apart: the worker\n/// loads no shared module.\nexport function foo() {}\n',
      'src/b.ts': '// Generated from src/x.ts;\n/** edit that file. */\nexport function foo() {}\n',
      'src/c.ts': '/* Generated from src/x.ts;\n ** edit that file.\n */\nexport function foo() {}\n',
      'src/d.ts': '## Kept apart: the worker\n## loads no shared module.\nexport function foo() {}\n',
      'src/e.ts': 'export function foo() {} // Kept apart: the worker loads no shared module.',
    },
    [
      'the worker loads no shared module.',
      'Generated from src/x.ts; edit that file.',
      'Generated from src/x.ts; edit that file.',
      'the worker loads no shared module.',
      ' the worker loads no shared module. ',
    ],
  );

  assert.deepEqual(
    declined.map(({ status, stderr }) => [status, stderr]),
    Array.from({ length: 5 }, () => [0, '']),
  );
});

test("a duplicate-function decline reads the census's commit through the site, though the checkout lacks it", (t) => {
  const { dir, garden } = planted(t);
  const bed = bedFromMain(garden, 'any-type');
  const onlyInSite = commit(bed, {
    'src/x.ts': 'export function foo() {}\n',
    'src/y.ts': '// Kept apart: the worker loads no shared module.\nexport function foo() {}\n',
  });
  writeCensusText(garden, censusText(onlyInSite, { duplicates: { foo: ['src/x.ts', 'src/y.ts'] } }));

  const declined = cli(dir, [
    'decline',
    '--class',
    'duplicate-function',
    '--where',
    'src/y.ts',
    '--reason',
    'the worker loads no shared module.',
  ]);

  assert.deepEqual(
    [declined.status, declined.stderr, spawnSync('git', ['cat-file', '-e', onlyInSite], { cwd: dir }).status],
    [0, '', 1],
  );
});

test('a duplicate-function decline refuses an --in path holding a control character, which its refusal would print raw', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, censusText('a'.repeat(40), { duplicates: { foo: ['src/x.ts', 'src/y.ts'] } }));

  const declined = cli(dir, [
    'decline',
    '--class',
    'duplicate-function',
    '--where',
    'src/y.ts',
    '--reason',
    'kept apart',
    '--in',
    'docs/a\u001b[2J.md',
  ]);

  assert.deepEqual(
    [declined.status, declined.stderr],
    [2, 'weeds decline: --in must be one line of text without control characters\n'],
  );
});

test('a duplicate-function decline is refused on a reason of comment markers alone, which quotes no words', (t) => {
  const declined = declinedOnWords(
    t,
    { 'src/a.ts': '// Kept apart: the worker loads no shared module.\nexport function foo() {}\n' },
    ['//'],
  );

  assert.deepEqual(
    declined.map(({ status, stderr }) => [status, stderr]),
    [
      [
        2,
        "weeds decline: --reason must quote the words that keep this copy, as src/a.ts holds them at the census's commit\n",
      ],
    ],
  );
});

test('a duplicate-function decline is refused on a quote that drops the // inside a line or runs two words together', (t) => {
  const declined = declinedOnWords(
    t,
    {
      'src/a.ts': '// Kept apart: see https://example.com/why for why.\nexport function foo() {}\n',
      'src/b.ts': '// Kept apart: the worker loads no shared module.\nexport function foo() {}\n',
    },
    ['see https:example.com/why for why.', 'the workerloads no shared module.'],
  );

  assert.deepEqual(
    declined.map(({ status }) => status),
    [2, 2],
  );
});

test('a duplicate-function decline may quote a record instead, named with --in, as it stood at the census commit', (t) => {
  const { dir, garden } = planted(t);
  commit(dir, {
    'src/x.ts': 'export function foo() {}\n',
    'src/y.ts': 'export function foo() {}\n',
    'docs/adr/0001-copies.md': '# Copies\n\nThe worker keeps its own foo, so it\nloads no shared module.\n',
  });
  writeCensusText(
    garden,
    censusText(git(dir, ['rev-parse', 'HEAD']), { duplicates: { foo: ['src/x.ts', 'src/y.ts'] } }),
  );
  const decline = (...extra: string[]) =>
    cli(dir, [
      'decline',
      '--class',
      'duplicate-function',
      '--where',
      'src/y.ts',
      '--reason',
      'The worker keeps its own foo, so it loads no shared module.',
      ...extra,
    ]);

  const results = [decline('--in', 'docs/adr/missing.md'), decline('--in', 'docs/adr/0001-copies.md')];

  assert.deepEqual(
    results.map(({ status, stderr }) => [status, stderr]),
    [
      [
        2,
        "weeds decline: --reason must quote the words that keep this copy, as docs/adr/missing.md holds them at the census's commit\n",
      ],
      [0, ''],
    ],
  );
});

test('--in goes with a duplicate-function decline of one file only', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(
    garden,
    censusText('a'.repeat(40), {
      hits: { 'any-type': ['src/a.ts:1: const a: any = 1;'] },
      duplicates: { foo: ['src/x.ts', 'src/y.ts'] },
    }),
  );

  const results = [
    ['--class', 'any-type', '--where', 'src/a.ts'],
    ['--class', 'any-type'],
    ['--class', 'duplicate-function'],
  ].map((args) => cli(dir, ['decline', ...args, '--reason', 'r', '--in', 'docs/adr/0001.md']));

  assert.deepEqual(
    [results.map(({ status, stderr }) => [status, stderr]), logFiles(garden).size],
    [
      Array.from({ length: 3 }, () => [
        2,
        'weeds decline: --in goes with --class duplicate-function --where <path> only\n',
      ]),
      0,
    ],
  );
});

test('decline without --where names one seed line in the singular', (t) => {
  const dir = seedListed(t);

  const declined = cli(dir, ['decline', '--class', 'any-type', '--reason', 'a typed fixture']);

  assert.deepEqual([declined.status, declined.stdout], [0, 'declined 1 seed line of any-type\n']);
});

test('decline needs a reason and a seed line to keep, and records nothing without them', (t) => {
  const { dir, garden } = planted(t);

  const results = [
    cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts']),
    cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts', '--reason', ' ']),
    cli(dir, ['decline', '--class', 'any-type', '--where', '', '--reason', 'a typed fixture']),
    cli(dir, ['decline', '--class', 'any-type', '--reason', 'a typed fixture']),
    cli(dir, ['decline', '--where', 'src/a.ts', '--reason', 'a typed fixture']),
    cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts', '--reason', 'x', '--note', 'y']),
    cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts', '--reason', 'x', '--census', 'main']),
    cli(dir, ['decline', '--class', 'any-type', '--where', 'src/a.ts', '--reason', 'a typed fixture']),
  ].map(({ status, stderr }) => [status, stderr]);

  assert.deepEqual(
    [results, logFiles(garden).size],
    [
      [
        [2, 'weeds decline: --reason must not be empty\n'],
        [2, 'weeds decline: --reason must not be empty\n'],
        [2, 'weeds decline: --where must not be empty\n'],
        [2, 'weeds decline: no line of the seed list is any-type; census:seed is for those lines alone\n'],
        [2, 'weeds decline: --class must be kebab-case\n'],
        [2, 'weeds decline: --note is not an option of decline\n'],
        [2, 'weeds decline: --census must be the full commit id census.ts printed\n'],
        [2, 'weeds decline: no line of the seed list is any-type in src/a.ts; census:seed is for those lines alone\n'],
      ],
      0,
    ],
  );
});
