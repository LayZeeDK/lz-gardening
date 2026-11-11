// Run: node --test weeds-changed-check.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { commit, git, repo } from './test-repo.ts';
import { configEnv } from './test-site.ts';
import { cli, eslintConfig, recordCensus, tendedBed } from './test-weeds.ts';
import { weedId } from './weeds.ts';

test('a check whose file the base deleted after the bed landed is not on the base', (t) => {
  const check = { 'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n" };
  const { dir, garden, tip } = tendedBed(t, check);
  commit(dir, check);
  git(dir, ['rm', '-q', 'eslint.config.mjs']);
  git(dir, ['commit', '-q', '-m', 'x']);
  recordCensus(garden, git(dir, ['rev-parse', 'HEAD']));

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('a user who colours every git diff still sees an unlanded check as not on the base', (t) => {
  const { dir, garden, tip } = tendedBed(t, {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }"),
  });
  recordCensus(garden, commit(dir, { 'eslint.config.mjs': eslintConfig("['lib/**']", '{}') }));

  const back = cli(
    garden,
    ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'],
    dir,
    configEnv([['color.diff', 'always']]),
  );

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('run from a folder inside the checkout, an unlanded check is still not on the base', (t) => {
  const { dir, garden, tip } = tendedBed(t, {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }"),
  });

  const back = cli(
    garden,
    ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'],
    join(dir, 'src'),
  );

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('a check the bed took from an unrelated history it merged is not on the base', (t) => {
  const { dir, garden, bed } = tendedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' }, 'eslint.config.mjs');
  const other = repo(t);
  commit(other, { 'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }") });
  git(bed, ['fetch', '-q', other, 'main']);
  git(bed, ['merge', '-q', '--allow-unrelated-histories', '-X', 'theirs', '-m', 'x', 'FETCH_HEAD']);
  const tip = git(bed, ['rev-parse', 'HEAD']);
  cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);
  cli(
    garden,
    ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs'],
    dir,
  );

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('a check the bed and the base both took from the same older unrelated history is on the base', (t) => {
  const { dir, garden, bed } = tendedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' }, 'eslint.config.mjs');
  const other = repo(t);
  writeFileSync(join(other, 'eslint.config.mjs'), eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }"));
  git(other, ['add', '-A']);
  const olderThanTheFork = {
    ...process.env,
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
  };
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: other, env: olderThanTheFork }).status, 0);
  for (const checkout of [bed, dir]) {
    git(checkout, ['fetch', '-q', other, 'main']);
    git(checkout, ['merge', '-q', '--allow-unrelated-histories', '-X', 'theirs', '-m', 'x', 'FETCH_HEAD']);
  }
  const tip = git(bed, ['rev-parse', 'HEAD']);
  recordCensus(garden, git(dir, ['rev-parse', 'HEAD']));
  cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);
  cli(
    garden,
    ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs'],
    dir,
  );

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a new check file the base created with content of its own is on the base', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  recordCensus(garden, commit(dir, { 'checks/any-type.test.mjs': 'export const other = 1;\n' }));

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});

test('a check the bed changed and then changed back is on the base', (t) => {
  const { dir, garden, bed } = tendedBed(t, {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }"),
  });
  const tip = commit(bed, { 'eslint.config.mjs': eslintConfig("['src/**']", '{}') });
  cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);
  cli(
    garden,
    ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs'],
    dir,
  );

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a check the base changed in another way than the bed did is not on the base', (t) => {
  // These two changes have patch ids that start with the same character.
  const { dir, garden, tip } = tendedBed(t, {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'curly': 'error' }"),
  });
  recordCensus(garden, commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-debugger': 'error' }") }));

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('a check path holding glob characters names that one file, not the files the glob would match', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'src/b.txt': 'b2\n' }, 'src/[ab].txt', {
    'src/[ab].txt': 'check\n',
    'src/b.txt': 'b\n',
  });

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: src/[ab].txt)\n`,
  );
});

test('a checkout cloned without every object never fetches for the label', (t) => {
  const { dir, garden } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  git(dir, ['config', 'uploadpack.allowFilter', 'true']);
  const partial = join(dirname(dir), 'partial');
  git(dirname(dir), ['clone', '-q', '--filter=blob:none', `file://${dir.replaceAll('\\', '/')}`, partial]);
  const elsewhere = commit(dir, { 'src/c.ts': 'export const c = 1;\n' });
  cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);
  cli(
    garden,
    ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${elsewhere}`, '--check', 'src/c.ts'],
    dir,
  );

  cli(garden, ['add', '--class', 'any-type', '--where', 'src/d.ts:1', '--source', 'commit:ddd4444'], partial);

  const fetched = spawnSync('git', ['cat-file', '-e', elsewhere], {
    cwd: partial,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  assert.notEqual(fetched.status, 0);
});
