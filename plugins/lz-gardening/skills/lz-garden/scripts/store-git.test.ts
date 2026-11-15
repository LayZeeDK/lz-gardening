// Run: node --test store-git.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { inRun, objectIds, treeAt } from './store-git.ts';
import { readStrategies, readStrategyVariable } from './store-git-objects.ts';
import type { ReadStrategy } from './store-git-objects.ts';
import { commit, git, repo } from './test-repo.ts';

function readThrough<T>(strategy: ReadStrategy, read: () => T): T {
  return inRun({ ...process.env, [readStrategyVariable]: strategy }, read);
}

// A commit whose tree holds a nested folder, an executable, a symbolic link and a submodule.
function mixedTree(dir: string): string {
  const blob = git(dir, ['rev-parse', `${commit(dir, { 'a.txt': 'a\n', 'src/deep/b.ts': 'b\n' })}:a.txt`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `100755,${blob},run.sh`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(dir, ['rev-parse', 'HEAD'])},sub`]);
  git(dir, ['commit', '-q', '-m', 'mixed']);

  return git(dir, ['rev-parse', 'HEAD']);
}

function sha256Repo(t: TestContext): string {
  const dir = join(dirname(repo(t)), 'sha256');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main', '--object-format=sha256']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);

  return dir;
}

test('each read strategy lists the tree of a commit as ls-tree does', (t) => {
  const dir = repo(t);
  const sha = mixedTree(dir);
  const listed = git(dir, ['ls-tree', '-r', '-z', sha])
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const [info = '', path = ''] = line.split('\t');
      const [, type, oid] = info.split(' ');

      return { type, oid, path };
    });

  assert.deepEqual(
    readStrategies.map((strategy) => readThrough(strategy, () => treeAt(dir, sha))),
    readStrategies.map(() => listed),
  );
});

test('each read strategy reads a repository of SHA-256 object names', (t) => {
  const dir = sha256Repo(t);
  const sha = commit(dir, { 'src/a.ts': 'a\n' });
  const blob = git(dir, ['rev-parse', `${sha}:src/a.ts`]);

  assert.deepEqual(
    readStrategies.map((strategy) =>
      readThrough(strategy, () => [objectIds(dir, ['HEAD', 'HEAD:none']), treeAt(dir, sha)]),
    ),
    readStrategies.map(() => [[sha, undefined], [{ type: 'blob', oid: blob, path: 'src/a.ts' }]]),
  );
});

test('each read strategy leaves the folder free to rename once the run returns', (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });

  for (const strategy of readStrategies) {
    readThrough(strategy, () => treeAt(dir, sha));
    renameSync(dir, `${dir}-${strategy}`);
    renameSync(`${dir}-${strategy}`, dir);
  }
});

test('each read strategy leaves the folder free to rename once the run throws', (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });

  for (const strategy of readStrategies) {
    assert.throws(
      () =>
        readThrough(strategy, () => {
          treeAt(dir, sha);
          throw new Error('the command failed');
        }),
      { message: 'the command failed' },
    );
    renameSync(dir, `${dir}-${strategy}`);
    renameSync(`${dir}-${strategy}`, dir);
  }
});
