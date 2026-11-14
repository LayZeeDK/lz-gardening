// Run: node --test census-duplicates.test.ts
// The duplicate helpers a census finds, and the duplicates its command line reports as new.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffDuplicates } from './census.ts';
import { census, censusOf, now, set, takeAndRecord, takeCensusInRun } from './test-census.ts';
import { commit, repo } from './test-repo.ts';
import { planted } from './test-site.ts';

test('a function defined in two files is reported as a duplicate with both paths', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'libs/a/util.ts': 'export function isRecord(value: unknown) {\n  return true;\n}\n',
    'libs/b/guards.ts': 'function isRecord(value: unknown) {\n  return true;\n}\n',
  });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { isRecord: ['libs/a/util.ts', 'libs/b/guards.ts'] });
});

test('a name defined in one file is not a duplicate', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/x.ts': 'export async function toArray() {}\nfunction once() {}\n',
    'src/y.mjs': '  function toArray() {}\n',
  });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

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

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

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

  const census = await takeCensusInRun(dir, 'HEAD', { ...set, exclude: [...set.exclude, 'gen/**'] }, now);

  assert.deepEqual(census.duplicates, {});
});

test('definitions under a dot-directory, such as mirrored agent skills, are not counted as duplicates', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'export function isRecord() {}\n',
    '.claude/skills/x/scripts/run.ts': 'function isRecord() {}\nfunction runSkill() {}\n',
    '.commandcode/skills/x/scripts/run.ts': 'function isRecord() {}\nfunction runSkill() {}\n',
  });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, {});
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

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(census.duplicates, { isRecord: ['src/a.tsx', 'src/b.cts'], toKey: ['src/c.js', 'src/d.cjs'] });
});

test('.jsx files are source files: their hits and definitions count', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.jsx': 'function Button() {} // eslint-disable-line\n',
    'src/b.jsx': 'function Button() {}\n',
  });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual([census.counts['eslint-disable'], census.duplicates], [1, { Button: ['src/a.jsx', 'src/b.jsx'] }]);
});

test('duplicate names are listed in alphabetical order', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'function zeta() {}\n',
    'src/b.ts': 'function zeta() {}\n',
    'src/c.ts': 'function alpha() {}\n',
    'src/d.ts': 'function alpha() {}\n',
  });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

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

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

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
