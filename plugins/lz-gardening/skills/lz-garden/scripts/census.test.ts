// Run: node --test census.test.ts
// Each test builds a throwaway git repository and counts weeds at one of its commits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffCensus, diffDuplicates, mergePatternSets, parseGrep, parsePatternSet, run, takeCensus } from './census.ts';
import { isRecord } from './log.ts';
import type { PatternSet } from './census.ts';
import { openSite } from './store-log.ts';
import { censusRef, parseCensus, pendingCensusRef, writePendingCensus } from './store-census.ts';
import type { Census } from './store-census.ts';
import { sync } from './store-sync.ts';
import { commit, git, repo } from './test-repo.ts';
import { planted } from './test-site.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'census.ts');
const now = new Date('2026-11-07T12:00:00.000Z');

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function censusCli(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Ran {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
}

async function census(dir: string, args: readonly string[]): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const status = await run(args, {
    cwd: dir,
    env: process.env,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });

  return { status, stdout, stderr };
}

const set: PatternSet = {
  exclude: ['**/*.md'],
  patterns: [
    { id: 'eslint-disable', regex: 'eslint-disable', paths: [], note: '' },
    { id: 'any-type', regex: '(: any\\b|\\bas any\\b)', paths: ['**/*.ts'], note: '' },
  ],
};

test('counts hits per pattern at a revision, honouring paths and excludes', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'const a: any = 1; // eslint-disable-line\nconst b = a as any;\n',
    'src/b.js': 'const c: any = 1;\n',
    'README.md': 'eslint-disable is discussed here\n',
  });

  const census = await takeCensus(dir, 'main', set, now);
  assert.equal(census.counts['eslint-disable'], 1);
  assert.equal(census.counts['any-type'], 2, 'the .js file is outside the pattern paths');
  assert.deepEqual(census.hits['any-type'], [
    'src/a.ts:1: const a: any = 1; // eslint-disable-line',
    'src/a.ts:2: const b = a as any;',
  ]);
});

test('a pattern with no paths counts hits in source files only, not in data files or prose', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.mjs': '// eslint-disable-next-line\n',
    'data/scraped.json': '{ "text": "eslint-disable" }\n',
    'notes.txt': 'eslint-disable is discussed here\n',
  });

  const census = await takeCensus(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], ['src/a.mjs:1: // eslint-disable-next-line']);
});

test('the bundled structural-directive pattern counts templates and components, not other files', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/list.html': '<li *ngFor="let item of items">{{ item }}</li>\n',
    'src/card.ts': '@Component({ template: \'<p *ngIf="shown">x</p>\' })\n',
    'eslint.config.mjs': '// Checks only *ngFor, which prefer-control-flow bans.\n',
    'docs/digest.json': '{ "text": "use *ngIf" }\n',
  });
  const bundled = parsePatternSet(JSON.parse(readFileSync(join(dirname(script), 'patterns.json'), 'utf8')), 'bundled');

  const census = await takeCensus(dir, 'main', bundled, now);

  assert.deepEqual(census.hits['angular-structural-directive'], [
    'src/card.ts:1: @Component({ template: \'<p *ngIf="shown">x</p>\' })',
    'src/list.html:1: <li *ngFor="let item of items">{{ item }}</li>',
  ]);
});

test("a hit's stored text is cut to 200 characters, marked with an ellipsis", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable-next-line ${'x'.repeat(5000)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensus(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line.slice(0, 200)}...`]);
});

test("a hit's text of exactly 200 characters is kept whole", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable ${'x'.repeat(182)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensus(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line}`]);
});

test("a hit's text is cut by characters, not UTF-16 units: 118 characters in 218 units are kept whole", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable ${String.fromCodePoint(0x1f331).repeat(100)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensus(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line}`]);
});

test('a function defined in two files is reported as a duplicate with both paths', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'libs/a/util.ts': 'export function isRecord(value: unknown) {\n  return true;\n}\n',
    'libs/b/guards.ts': 'function isRecord(value: unknown) {\n  return true;\n}\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { isRecord: ['libs/a/util.ts', 'libs/b/guards.ts'] });
});

test('a name defined in one file is not a duplicate', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/x.ts': 'export async function toArray() {}\nfunction once() {}\n',
    'src/y.mjs': '  function toArray() {}\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { toArray: ['src/x.ts', 'src/y.mjs'] });
});

test('const arrow and function-expression definitions count, other consts do not', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'export const isRecord = (value: unknown) => true;\nconst limit = 5;\n',
    'src/b.ts': 'const isRecord = function (value) {\n  return true;\n};\nconst limit = 5;\n',
    'src/c.ts': 'export const toKey = async (x) => x;\nconst made = make();\n',
    'src/d.mts': 'const toKey = x => x;\nconst made = make();\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { isRecord: ['src/a.ts', 'src/b.ts'], toKey: ['src/c.ts', 'src/d.mts'] });
});

test('definitions in test files, non-source files and excluded globs are not counted', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'export function isRecord() {}\n',
    'src/a.spec.ts': 'function isRecord() {}\n',
    'src/b.test.mjs': 'function isRecord() {}\n',
    'docs/notes.txt': 'function isRecord() {}\n',
    'gen/types.ts': 'function isRecord() {}\n',
  });

  const census = await takeCensus(dir, 'HEAD', { ...set, exclude: [...set.exclude, 'gen/**'] }, now);

  assert.deepEqual(census.duplicates, {});
});

test('definitions under a dot-directory, such as mirrored agent skills, are not counted as duplicates', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'export function isRecord() {}\n',
    '.claude/skills/x/scripts/run.ts': 'function isRecord() {}\nfunction runSkill() {}\n',
    '.commandcode/skills/x/scripts/run.ts': 'function isRecord() {}\nfunction runSkill() {}\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, {});
});

test('hits in a file with CRLF line ends are counted', async (t) => {
  const dir = repo(t);
  git(dir, ['config', 'core.autocrlf', 'false']);
  commit(dir, {
    'src/crlf.ts': '// eslint-disable one\r\n// eslint-disable two\r\n',
    'src/sep.ts': "const s = 'a b'; // eslint-disable\n",
  });
  const before = await takeCensus(dir, 'HEAD', set, now);
  commit(dir, {
    'src/crlf.ts': '\r\n// eslint-disable one\r\n// eslint-disable two\r\n',
    'src/sep.ts': "\nconst s = 'a b'; // eslint-disable\n",
  });
  const after = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(
    [before.hits['eslint-disable'], diffCensus(before, after).find((item) => item.id === 'eslint-disable')?.added],
    [
      [
        'src/crlf.ts:1: // eslint-disable one',
        'src/crlf.ts:2: // eslint-disable two',
        "src/sep.ts:1: const s = 'a b'; // eslint-disable",
      ],
      [],
    ],
  );
});

test('reads the revision, not the working tree', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  writeFileSync(join(dir, 'src/a.ts'), '// eslint-disable\n');

  const census = await takeCensus(dir, 'HEAD', set, now);
  assert.equal(census.counts['eslint-disable'], 0);
});

test('the delta ignores moved lines and reports only new hits', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1 as any;\n' });
  const before = await takeCensus(dir, 'HEAD', set, now);
  commit(dir, { 'src/a.ts': '\n\nconst a = 1 as any;\nconst b = 2 as any;\n' });
  const after = await takeCensus(dir, 'HEAD', set, now);

  const delta = diffCensus(before, after).find((item) => item.id === 'any-type');
  assert.deepEqual(delta, { id: 'any-type', before: 1, after: 2, added: ['src/a.ts:4: const b = 2 as any;'] });
});

test('a first census has no previous counts and reports no hits as new', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1 as any;\n' });
  const after = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(
    diffCensus(null, after).find((item) => item.id === 'any-type'),
    {
      id: 'any-type',
      before: null,
      after: 1,
      added: [],
    },
  );
});

test('an unknown revision is an error, not an empty census', async (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': '' });

  await assert.rejects(takeCensus(dir, 'no-such-branch', set, now), /rev-parse/);
});

test('extra patterns override by id and add excludes', () => {
  const extra = parsePatternSet(
    { exclude: ['gen/**'], patterns: [{ id: 'any-type', regex: 'any', note: 'stricter' }] },
    'extra',
  );
  const merged = mergePatternSets(set, extra);

  assert.deepEqual(merged.exclude, ['**/*.md', 'gen/**']);
  assert.equal(merged.patterns.find((pattern) => pattern.id === 'any-type')?.regex, 'any');
  assert.equal(merged.patterns.length, 2);
});

test('a malformed pattern set fails loudly', () => {
  assert.throws(() => parsePatternSet({ patterns: [{ id: 'Bad Id', regex: 'x' }] }, 'p'), /kebab/);
  assert.throws(() => parsePatternSet({ patterns: [{ id: 'ok' }] }, 'p'), /regex/);
  assert.equal(parseCensus({ rev: 1 }), null);
});

function refusalOf(json: unknown): string {
  try {
    parsePatternSet(json, 'p');
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  return 'accepted';
}

test('each malformed part of a pattern set is refused, naming its source and the part', () => {
  const malformed: readonly unknown[] = [
    null,
    { patterns: 'x' },
    { patterns: ['x'] },
    { exclude: 'x' },
    { exclude: ['a', 1] },
    { patterns: [{ id: 'kebab-Case', regex: 'x' }] },
    { patterns: [{ id: 'ok', regex: '' }] },
    { patterns: [{ id: 'ok', regex: 'x', paths: ['src/**', 1] }] },
  ];

  assert.deepEqual(malformed.map(refusalOf), [
    'p: expected an object with "patterns"',
    'p: "patterns" must be an array',
    'p: patterns[0] must be an object',
    'p: "exclude" must be an array of strings',
    'p: "exclude" must be an array of strings',
    'p: patterns[0].id must be a kebab-case string',
    'p: pattern ok needs a non-empty "regex"',
    'p: pattern ok "paths" must be an array of strings',
  ]);
});

test('a pattern set may leave out patterns, excludes, paths and notes', () => {
  assert.deepEqual(
    [parsePatternSet({}, 'p'), parsePatternSet({ patterns: [{ id: 'todo', regex: 'TODO', paths: ['src/**'] }] }, 'p')],
    [
      { exclude: [], patterns: [] },
      { exclude: [], patterns: [{ id: 'todo', regex: 'TODO', paths: ['src/**'], note: '' }] },
    ],
  );
});

test('a pattern with more than 1000 hits counts them all and keeps the first 1000', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/many.ts': '// eslint-disable\n'.repeat(1001) });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(
    [census.counts['eslint-disable'], census.hits['eslint-disable']?.length, census.hits['eslint-disable']?.at(-1)],
    [1001, 1000, 'src/many.ts:1000: // eslint-disable'],
  );
});

test('only a leading origin/ is dropped from the recorded rev', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  git(dir, ['branch', 'team/origin/main']);

  const census = await takeCensus(dir, 'team/origin/main', set, now);

  assert.equal(census.rev, 'team/origin/main');
});

test("an unknown revision's error carries git's own reason", async (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': '' });

  await assert.rejects(takeCensus(dir, 'no-such-branch', set, now), {
    message: /^git rev-parse no-such-branch: \S[^\n]*$/,
  });
});

test("a git grep that fails is an error that names the search and carries git's reason", async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'function f() {}\n' });

  await assert.rejects(takeCensus(dir, 'HEAD', { exclude: ['../outside'], patterns: [] }, now), {
    message: /^git grep for definitions: \S[^\n]*$/,
  });
});

function censusOf(
  hits: Readonly<Record<string, readonly string[]>>,
  duplicates: Readonly<Record<string, readonly string[]>> = {},
): Census {
  return {
    rev: 'main',
    sha: 'a'.repeat(40),
    takenAt: now.toISOString(),
    counts: Object.fromEntries(Object.entries(hits).map(([id, list]) => [id, list.length])),
    hits,
    duplicates,
  };
}

test('git grep output counts only lines of the revision asked for that carry a line number', () => {
  assert.deepEqual(parseGrep('abc:a.ts:1:x\nxyz:b.ts:2:y\nabc:no line number\n', 'abc'), ['a.ts:1: x']);
});

test('the delta matches hits by path and text, wherever the line moved', () => {
  const delta = diffCensus(censusOf({ p: ['a.ts:3: old'] }), censusOf({ p: ['a.ts:1: new', 'a.ts:12: old'] }));

  assert.deepEqual(delta, [{ id: 'p', before: 1, after: 2, added: ['a.ts:1: new'] }]);
});

test('a hit that appears once more often than before is new once', () => {
  const delta = diffCensus(
    censusOf({ p: ['a.ts:1: x', 'a.ts:2: x'] }),
    censusOf({ p: ['a.ts:1: x', 'a.ts:2: x', 'a.ts:3: x'] }),
  );

  assert.deepEqual(delta, [{ id: 'p', before: 2, after: 3, added: ['a.ts:3: x'] }]);
});

test('a pattern counted without a hit list has no new hits', () => {
  const delta = diffCensus(censusOf({ p: [] }), { ...censusOf({}), counts: { p: 1 } });

  assert.deepEqual(delta, [{ id: 'p', before: 0, after: 1, added: [] }]);
});

test('a duplicate is new when it gains a file, and no duplicate is new in a first census', () => {
  const before = censusOf({}, { f: ['a.ts', 'b.ts'] });
  const after = censusOf({}, { f: ['a.ts', 'b.ts', 'c.ts'], g: ['a.ts', 'b.ts'] });

  assert.deepEqual([diffDuplicates(null, after), diffDuplicates(before, after)], [[], ['f', 'g']]);
});

test('definitions in .tsx, .cts, .js and .cjs files count', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.tsx': 'function isRecord() {}\n',
    'src/b.cts': 'function isRecord() {}\n',
    'src/c.js': 'const toKey = (x) => x;\n',
    'src/d.cjs': 'const toKey = (x) => x;\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { isRecord: ['src/a.tsx', 'src/b.cts'], toKey: ['src/c.js', 'src/d.cjs'] });
});

test('duplicate names are listed in alphabetical order', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'function zeta() {}\n',
    'src/b.ts': 'function zeta() {}\n',
    'src/c.ts': 'function alpha() {}\n',
    'src/d.ts': 'function alpha() {}\n',
  });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(Object.keys(census.duplicates), ['alpha', 'zeta']);
});

test('definitions count however they are spaced, and a function after other code on its line does not', async (t) => {
  const dir = repo(t);
  const source = [
    'export  function spacedExport() {}',
    'async  function spacedAsync() {}',
    'function  spacedFunction() {}',
    'const  spacedConst = () => 1;',
    'const tight=(x) => x;',
    'const lazy = async(x) => x;',
    'const bare =x => x;',
    'const named = xy => xy;',
    'const close = x=> x;',
    'const limit = 1; function inner() {}',
    '',
  ].join('\n');
  commit(dir, { 'src/a.ts': source, 'src/b.ts': source });

  const census = await takeCensus(dir, 'HEAD', set, now);

  assert.deepEqual(Object.keys(census.duplicates), [
    'bare',
    'close',
    'lazy',
    'named',
    'spacedAsync',
    'spacedConst',
    'spacedExport',
    'spacedFunction',
    'tight',
  ]);
});

test('a census in a folder that does not exist fails with the reason git could not start', async (t) => {
  const dir = repo(t);

  await assert.rejects(takeCensus(join(dir, 'missing'), 'HEAD', set, now), { code: 'ENOENT' });
});

test('git grep output keeps colons inside the matched text', () => {
  assert.deepEqual(parseGrep('abc:src/a.ts:3:  const x = { a: 1 } as any;\nother line\n', 'abc'), [
    'src/a.ts:3: const x = { a: 1 } as any;',
  ]);
});

test('the CLI writes its census to the pending ref of the commit the rev names, not of the rev', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);

  const result = await census(dir, ['--rev', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [
      git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']),
      parseCensus(JSON.parse(git(garden, ['show', `${pendingCensusRef(sha)}:census.json`])))?.sha,
    ],
    [pendingCensusRef(sha), sha],
  );
});

test('the CLI run with GIT_DIR naming another repository takes the census of the checkout it runs in', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const other = repo(t);

  const result = censusCli(dir, ['--rev', 'main'], { ...process.env, GIT_DIR: join(other, '.git') });

  assert.deepEqual(
    [result.status, git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending'])],
    [0, pendingCensusRef(sha)],
    result.stderr,
  );
});

function summaryOf(stdout: string): ReadonlyMap<string, unknown> {
  const parsed: unknown = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');

  return new Map(isRecord(parsed) ? Object.entries(parsed) : []);
}

async function takeAndRecord(dir: string, args: readonly string[] = []): Promise<Ran> {
  const result = await census(dir, ['--rev', 'HEAD', ...args]);
  assert.equal(result.status, 0, result.stderr);
  const sha = summaryOf(result.stdout).get('sha');
  assert.equal(typeof sha, 'string');
  sync(openSite(dir), { attempts: 1, census: String(sha) });

  return result;
}

test('a census in a garden that is not shared reads the census the last tick recorded as the previous one', async (t) => {
  const { dir } = planted(t);
  git(dir, ['config', 'lzGardening.share', 'false']);
  const first = summaryOf((await takeAndRecord(dir)).stdout).get('sha');
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(summaryOf(second.stdout).get('previousSha'), first);
});

test('a duplicate that gains a file names the new file apart from the files it was already in', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'function f() {}\n', 'src/b.ts': 'function f() {}\n' });
  await takeAndRecord(dir);
  commit(dir, { 'src/c.ts': 'function f() {}\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    second.stdout.split('\n').filter((line) => line.startsWith('+ duplicate ')),
    ['+ duplicate f: new src/c.ts; already src/a.ts, src/b.ts'],
  );
});

test('a duplicate whose every file is new names no earlier file', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);
  commit(dir, { 'src/x.ts': 'function g() {}\n', 'src/y.ts': 'function g() {}\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    second.stdout.split('\n').filter((line) => line.startsWith('+ duplicate ')),
    ['+ duplicate g: new src/x.ts, src/y.ts'],
  );
});

test('the CLI names a helper that became duplicated since the last census, not one that already was', async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': 'export function isRecord() {}\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'function isRecord() {}\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  const summary: unknown = JSON.parse(second.stdout.trim().split('\n').at(-1) ?? '');
  assert.ok(typeof summary === 'object' && summary !== null && 'newDuplicates' in summary);
  assert.deepEqual(summary.newDuplicates, ['isRecord']);
  assert.deepEqual(
    second.stdout.split('\n').filter((line) => line.startsWith('+ duplicate ')),
    ['+ duplicate isRecord: new src/b.ts; already src/a.ts'],
  );
});

test('--seed prints the seed list: files per pattern by hit count, and every duplicate name', async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n',
    'src/b.ts': '// eslint-disable-next-line\n// eslint-disable-next-line\nconst b = 1;\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const seedLines = result.stdout.split('\n').filter((line) => line.startsWith('= '));
  assert.deepEqual(seedLines, [
    '= [eslint-disable] src/b.ts 2',
    '= [eslint-disable] src/a.ts 1',
    '= duplicate toKey: src/x.ts, src/y.ts',
  ]);
});

test("--seed prints the seed report's census line: each pattern with hits and its count", async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\n// eslint-disable-next-line\nconst a = 1;\n',
    'src/t.ts': '// TODO one\n',
  });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('census: ')),
    ['census: eslint-disable 2, todo-marker 1'],
  );
});

test("--seed prints the census line as 'census: none' when no pattern has a hit", async (t) => {
  const { dir } = planted(t);

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('census: ')),
    ['census: none'],
  );
});

test('--seed adds exactly the seed list and the census line to the output', async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });

  const plain = await census(dir, ['--rev', 'HEAD']);
  const seeded = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(seeded.status, 0, seeded.stderr);
  const lines = seeded.stdout.split('\n');
  assert.ok(lines.some((line) => line.startsWith('= ')));
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('= ') && !line.startsWith('census: ')),
    plain.stdout.split('\n'),
  );
});

test('a census with no --rev is a usage error that names the flags', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = await census(dir, ['--seed']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: census\.ts --rev <rev>/);
});

test('the seed list keeps a colon inside a file path', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: '// eslint-disable-next-line\n',
    encoding: 'utf8',
  });
  git(dir, ['config', 'core.protectNTFS', 'false']);
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},src/a:b.ts`]);
  git(dir, ['commit', '-q', '-m', 'colon']);

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^= \[eslint-disable\] src\/a:b\.ts 1$/m);
});

test('the seed list names at most 20 files per pattern, keeping those with the most hits', async (t) => {
  const { dir } = planted(t);
  const files = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`src/f${String(index).padStart(2, '0')}.ts`, '// eslint-disable\n']),
  );
  commit(dir, { ...files, 'src/f20.ts': '// eslint-disable\n// eslint-disable\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const seedLines = result.stdout.split('\n').filter((line) => line.startsWith('= [eslint-disable]'));
  assert.equal(seedLines.length, 20);
  assert.equal(seedLines[0], '= [eslint-disable] src/f20.ts 2');
  assert.ok(!seedLines.includes('= [eslint-disable] src/f19.ts 1'));
});

test('a mistyped flag is a usage error, not ignored', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--ot', join(dir, '.garden', 'census.json')]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--ot/);
});

test('--out and --patterns are not options: the census goes to the garden, and its patterns come from there', async (t) => {
  const { dir, garden } = planted(t);
  const file = join(garden, '.garden', 'census.json');

  const results = [
    await census(dir, ['--rev', 'HEAD', '--out', file]),
    await census(dir, ['--rev', 'HEAD', '--patterns', file]),
  ];

  assert.deepEqual(
    results.map((result) => [result.status, /Unknown option '--(out|patterns)'/.test(result.stderr)]),
    [
      [2, true],
      [2, true],
    ],
  );
});

const todoPatterns = `${JSON.stringify({ patterns: [{ id: 'todo', regex: 'TODO' }] })}\n`;

function writeSitePatterns(garden: string, text = todoPatterns): void {
  mkdirSync(join(garden, '.garden'), { recursive: true });
  writeFileSync(join(garden, '.garden', 'patterns.json'), text);
}

test("the census counts the extra patterns in the site's .garden/patterns.json", async (t) => {
  const { dir, garden } = planted(t);
  commit(dir, { 'src/t.ts': '// TODO: one\n' });
  writeSitePatterns(garden);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^todo +1 {2}new$/m);
});

test("a census taken with the site's extra patterns carries them, so a clone without the file counts the same", async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  assert.equal(git(garden, ['show', `${pendingCensusRef(sha)}:patterns.json`]), todoPatterns.trim());
});

test('a site with no .garden/patterns.json counts with the extra patterns the previous census carried', async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden);
  await takeAndRecord(dir);
  rmSync(join(garden, '.garden', 'patterns.json'));
  commit(dir, { 'src/t.ts': '// TODO: one\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^todo +1 {2}\+1$/m);
});

test('a census that differs from the recorded one in nothing but the time taken leaves nothing pending', async (t) => {
  const { dir, garden } = planted(t);
  await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(garden, ['for-each-ref', 'refs/garden/pending']), '');
});

test('a first census is not behind the garden', async (t) => {
  const { dir } = planted(t);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('behind'), false);
});

test('a census of a commit the recorded census descends from is behind the garden', async (t) => {
  const { dir } = planted(t);
  const older = git(dir, ['rev-parse', 'HEAD']);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  await takeAndRecord(dir);

  const result = await census(dir, ['--rev', older]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('behind'), true);
});

function recordByHand(garden: string, sha: string, text: string): void {
  writePendingCensus(garden, sha, text);
  git(garden, ['update-ref', censusRef, pendingCensusRef(sha)]);
  git(garden, ['update-ref', '-d', pendingCensusRef(sha)]);
}

test('a previous census of a commit this checkout lacks reports no previous sha, so the tick reads no range', async (t) => {
  const { dir, garden } = planted(t);
  const unknown = 'f'.repeat(40);
  recordByHand(
    garden,
    unknown,
    JSON.stringify({ rev: 'main', sha: unknown, takenAt: '2026-11-13T00:00:00.000Z', counts: {}, hits: {} }),
  );

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('previousSha'), null);
});

test('malformed patterns carried by the recorded census are refused, naming the census as their source', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus(
    garden,
    sha,
    JSON.stringify({ rev: 'main', sha, takenAt: '2026-11-13T00:00:00.000Z', counts: {}, hits: {} }),
    '{"patterns": "x"}\n',
  );
  git(garden, ['update-ref', censusRef, pendingCensusRef(sha)]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, result.stderr],
    [2, 'census: refs/garden/census:patterns.json: "patterns" must be an array\n'],
  );
});

test('a census in a repository with no garden site is refused, saying to open the site first', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = censusCli(dir, ['--rev', 'HEAD']);

  assert.deepEqual([result.status, /no garden site at .*; run site\.ts open first/.test(result.stderr)], [2, true]);
});

test('a recorded census that is not a census is refused by name and left as it was', async (t) => {
  const { dir, garden } = planted(t);
  recordByHand(garden, git(dir, ['rev-parse', 'HEAD']), '{"rev": 1}\n');
  const recorded = git(garden, ['rev-parse', censusRef]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, /refs\/garden\/census in .* is not a census; delete it/.test(result.stderr)],
    [2, true],
  );
  assert.equal(git(garden, ['rev-parse', censusRef]), recorded);
});

test('a census of origin/main records the base as main, for each clone to resolve on its own', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', sha]);

  const result = await census(dir, ['--rev', 'origin/main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCensus(JSON.parse(git(garden, ['show', `${pendingCensusRef(sha)}:census.json`])))?.rev, 'main');
});

test('the seed list names at most 30 duplicate names, the most widely defined first, and counts the rest', async (t) => {
  const { dir } = planted(t);
  const files = Object.fromEntries(
    Array.from({ length: 31 }, (_, index) => index).flatMap((index) => [
      [`src/a${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
      [`src/b${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
    ]),
  );
  commit(dir, { ...files, 'src/c.ts': 'function helper30() {}\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split('\n').filter((line) => line.startsWith('= duplicate '));
  assert.equal(listed.length, 30);
  assert.equal(listed[0], '= duplicate helper30: src/a30.ts, src/b30.ts, src/c.ts');
  assert.match(result.stdout, /^1 more duplicate names not listed$/m);
});

test('--seed prints the seed list even when a census was recorded before, and only then', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n' });
  const first = await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(first.stdout, /^= /m);
  assert.match(again.stdout, /^= \[eslint-disable\] src\/a\.ts 1$/m);
});

test('a long hit the last census recorded, cut, is not new in the next census', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': `// eslint-disable ${'x'.repeat(5000)}\n` });
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(summaryOf(second.stdout).get('newHits'), 0);
});

test('the CLI writes the census, and a second run reports what grew', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  await takeAndRecord(dir);

  commit(dir, { 'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n' });
  const second = await census(dir, ['--rev', 'HEAD']);
  assert.equal(second.status, 0, second.stderr);

  const summary: unknown = JSON.parse(second.stdout.trim().split('\n').at(-1) ?? '');
  assert.ok(typeof summary === 'object' && summary !== null && 'grew' in summary);
  assert.ok(Array.isArray(summary.grew) && summary.grew.includes('eslint-disable'));
  assert.match(second.stdout, /\+ \[eslint-disable\] src\/a\.ts:1:/);
});

test('the table shows each count and its change in fixed columns, then the new hits, and the summary counts them', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': '// eslint-disable\n// eslint-disable\n', 'src/t.ts': '// TODO one\n' });
  await takeAndRecord(dir);
  commit(dir, { 'src/a.ts': '// eslint-disable\n', 'src/t.ts': '// TODO one\n// TODO two\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  const lines = second.stdout.split('\n');
  const summary = summaryOf(second.stdout);
  assert.deepEqual(
    [
      lines[0],
      lines.find((line) => line.startsWith('eslint-disable ')),
      lines.find((line) => line.startsWith('todo-marker ')),
      lines[lines.indexOf('+ [todo-marker] src/t.ts:2: // TODO two') - 1],
      summary.get('grew'),
      summary.get('newHits'),
    ],
    [
      `pattern${' '.repeat(25)}count  change`,
      `eslint-disable${' '.repeat(22)}1  -1`,
      `todo-marker${' '.repeat(25)}2  +1`,
      '',
      ['todo-marker'],
      1,
    ],
  );
});

test('a first census is written, with nothing grown, no new duplicate and no previous commit to be behind', async (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', censusRef]);
  const older = commit(dir, {
    'src/a.ts': '// eslint-disable\n',
    'src/x.ts': 'function f() {}\n',
    'src/y.ts': 'function f() {}\n',
  });
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['branch', 'null']);

  const result = await census(dir, ['--rev', older]);

  assert.equal(result.status, 0, result.stderr);
  const summary = summaryOf(result.stdout);
  assert.deepEqual(
    [
      git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']),
      summary.get('grew'),
      summary.get('newDuplicates'),
      summary.get('previousSha'),
      summary.get('behind'),
    ],
    [pendingCensusRef(older), [], [], null, false],
  );
});

test('a census of the commit the garden recorded is not behind it', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(summaryOf(again.stdout).get('behind'), false);
});

test('a census that differs from the recorded one is left pending for its commit', async (t) => {
  const { dir, garden } = planted(t);
  await takeAndRecord(dir);
  const later = commit(dir, { 'src/t.ts': '// TODO: one\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']), pendingCensusRef(later));
});

test('the summary counts the commits in the range from the previous census to this one', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  commit(dir, { 'src/c.ts': 'export const c = 3;\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), 2);
});

test('the commits in the range leave out merge commits, as the tick reads them', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);
  git(dir, ['switch', '-q', '-c', 'side']);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['switch', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), 1);
});

test('a census with no previous census to compare with counts no commits', async (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', censusRef]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), null);
});

test('a census of a commit that descends from the recorded one is not behind the garden', async (t) => {
  const { dir } = planted(t);
  const recorded = git(dir, ['rev-parse', 'HEAD']);
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  const summary = summaryOf(result.stdout);
  assert.deepEqual([summary.get('previousSha'), summary.get('behind')], [recorded, false]);
});
