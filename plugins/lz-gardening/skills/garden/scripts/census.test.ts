// Run: node --test census.test.ts
// Each test builds a throwaway git repository and counts weeds at one of its commits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diffCensus, mergePatternSets, parseCensus, parseGrep, parsePatternSet, takeCensus } from './census.ts';
import type { PatternSet } from './census.ts';
import { commit, git, repo } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'census.ts');
const now = new Date('2026-11-07T12:00:00.000Z');

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

test('git grep output keeps colons inside the matched text', () => {
  assert.deepEqual(parseGrep('abc:src/a.ts:3:  const x = { a: 1 } as any;\nother line\n', 'abc'), [
    'src/a.ts:3: const x = { a: 1 } as any;',
  ]);
});

test('the CLI names a helper that became duplicated since the last census, not one that already was', (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'export function isRecord() {}\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });
  const out = join(dir, 'census.json');
  const first = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  commit(dir, { 'src/b.ts': 'function isRecord() {}\n' });

  const second = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });

  assert.equal(second.status, 0, second.stderr);
  const summary: unknown = JSON.parse(second.stdout.trim().split('\n').at(-1) ?? '');
  assert.ok(typeof summary === 'object' && summary !== null && 'newDuplicates' in summary);
  assert.deepEqual(summary.newDuplicates, ['isRecord']);
  assert.match(second.stdout, /^\+ duplicate isRecord: src\/a\.ts, src\/b\.ts$/m);
});

test('a first census prints the seed list: files per pattern by hit count, and every duplicate name', (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n',
    'src/b.ts': '// eslint-disable-next-line\n// eslint-disable-next-line\nconst b = 1;\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', join(dir, 'census.json')], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const baseline = result.stdout.split('\n').filter((line) => line.startsWith('= '));
  assert.deepEqual(baseline, [
    '= [eslint-disable] src/b.ts 2',
    '= [eslint-disable] src/a.ts 1',
    '= duplicate toKey: src/x.ts, src/y.ts',
  ]);
});

test('the seed list keeps a colon inside a file path', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: '// eslint-disable-next-line\n',
    encoding: 'utf8',
  });
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},src/a:b.ts`]);
  git(dir, ['commit', '-q', '-m', 'colon']);

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', join(dirname(dir), 'census.json')], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^= \[eslint-disable\] src\/a:b\.ts 1$/m);
});

test('the seed list names at most 20 files per pattern, keeping those with the most hits', (t) => {
  const dir = repo(t);
  const files = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`src/f${String(index).padStart(2, '0')}.ts`, '// eslint-disable\n']),
  );
  commit(dir, { ...files, 'src/f20.ts': '// eslint-disable\n// eslint-disable\n' });

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', join(dir, 'census.json')], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const baseline = result.stdout.split('\n').filter((line) => line.startsWith('= [eslint-disable]'));
  assert.equal(baseline.length, 20);
  assert.equal(baseline[0], '= [eslint-disable] src/f20.ts 2');
  assert.ok(!baseline.includes('= [eslint-disable] src/f19.ts 1'));
});

test('a mistyped flag is a usage error, not ignored', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--ot', join(dir, 'census.json')], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--ot/);
});

test('the seed list names at most 30 duplicate names, the most widely defined first, and counts the rest', (t) => {
  const dir = repo(t);
  const files = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => index).flatMap((index) => [
      [`src/a${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
      [`src/b${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
    ]),
  );
  commit(dir, { ...files, 'src/c.ts': 'function helper31() {}\n' });

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', join(dir, 'census.json')], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split('\n').filter((line) => line.startsWith('= duplicate '));
  assert.equal(listed.length, 30);
  assert.equal(listed[0], '= duplicate helper31: src/a31.ts, src/b31.ts, src/c.ts');
  assert.match(result.stdout, /^2 more duplicate names not listed$/m);
});

test('the CLI creates the folder it writes the census into', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const out = join(dirname(dir), 'repo.garden', '.garden', 'census.json');

  const result = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCensus(JSON.parse(readFileSync(out, 'utf8')))?.sha, git(dir, ['rev-parse', 'HEAD']));
});

test('a census of the commit already recorded leaves the census file as it was', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const out = join(dirname(dir), 'census.json');
  const first = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const recorded = readFileSync(out, 'utf8');

  const second = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });

  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(out, 'utf8'), recorded);
});

test('the CLI writes the census, and a second run reports what grew', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const out = join(dir, 'census.json');
  const first = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);

  commit(dir, { 'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n' });
  const second = spawnSync(process.execPath, [script, '--rev', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);

  const summary: unknown = JSON.parse(second.stdout.trim().split('\n').at(-1) ?? '');
  assert.ok(typeof summary === 'object' && summary !== null && 'grew' in summary);
  assert.ok(Array.isArray(summary.grew) && summary.grew.includes('eslint-disable'));
  assert.match(second.stdout, /\+ \[eslint-disable\] src\/a\.ts:1:/);
  assert.equal(parseCensus(JSON.parse(readFileSync(out, 'utf8')))?.sha, git(dir, ['rev-parse', 'HEAD']));
});
