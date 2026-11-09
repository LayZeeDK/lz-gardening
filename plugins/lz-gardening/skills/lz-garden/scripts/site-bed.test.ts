import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { commit, git, repo } from './test-repo.ts';
import { planted, site } from './test-site.ts';

test('bed makes a worktree on bed/<class> from the base as the repository has it now', (t) => {
  const { dir, garden } = planted(t);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  const main = git(dir, ['rev-parse', 'main']);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  const reported = result.summary.get('bed');
  assert.ok(typeof reported === 'string');
  const expected = join(garden, 'beds', 'any-type');
  assert.equal(realpathSync.native(reported), realpathSync.native(expected));
  assert.equal(result.summary.get('branch'), 'bed/any-type');
  assert.equal(result.summary.get('start'), main);
  assert.equal(result.summary.get('created'), true);
  assert.equal(git(expected, ['branch', '--show-current']), 'bed/any-type');
  assert.equal(git(expected, ['rev-parse', 'HEAD']), main);
});

test('bed on an existing bed keeps its work and reports where it started, after the base moved on', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/a.ts': 'export const a: number = 1;\n' });
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('bed'), first.summary.get('bed'));
  assert.equal(again.summary.get('start'), first.summary.get('start'));
  assert.equal(git(bed, ['rev-parse', 'HEAD']), work);
});

test('bed on an existing bed reports where its branch started, not where a tag of the same name points', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', 'old']);
  const later = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['tag', 'bed/any-type', later]);
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'old']);
  assert.equal(first.status, 0, first.stderr);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('start'), first.summary.get('start'));
});

test('bed on a bed whose folder is gone brings the folder back with the branch work', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  commit(bed, { 'src/kept.ts': 'export const kept = 1;\n' });
  rmSync(bed, { recursive: true, force: true });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(existsSync(join(bed, 'src', 'kept.ts')), true);
});

test('bed refuses a folder at the bed path that is no longer the worktree of its branch, and names it', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['worktree', 'remove', '--force', bed]);
  mkdirSync(bed);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type is not the worktree/);
});

test('bed refuses a file at the path of an existing bed, and names it', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['worktree', 'remove', '--force', bed]);
  writeFileSync(bed, 'not a folder\n');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type is not the worktree/);
});

test('bed refuses a link whose target is gone at the path of an existing bed, and names it', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['worktree', 'remove', '--force', bed]);
  symlinkSync(join(garden, 'gone'), bed, 'junction');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type is not the worktree/);
});

test('bed refuses a link at the bed path whose target is gone, before it makes the branch', (t) => {
  const { dir, garden } = planted(t);
  const bed = join(garden, 'beds', 'any-type');
  mkdirSync(dirname(bed), { recursive: true });
  symlinkSync(join(garden, 'gone'), bed, 'junction');

  const made = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(made.status, 2);
  assert.match(made.stderr, /beds[\\/]any-type is not the worktree/);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed refuses a folder at the bed path before it makes the branch, and names the folder', (t) => {
  const { dir, garden } = planted(t);
  const bed = join(garden, 'beds', 'any-type');
  mkdirSync(bed, { recursive: true });
  writeFileSync(join(bed, 'notes.txt'), 'left here\n');

  const made = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(made.status, 2);
  assert.match(made.stderr, /beds[\\/]any-type is not the worktree/);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed refuses a class that is not a kebab-case class id and makes no bed', (t) => {
  const { dir, garden } = planted(t);

  const result = site(dir, ['bed', '--class', 'nested/any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--class/);
  assert.equal(existsSync(join(garden, 'beds', 'nested')), false);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed needs no dependencies when the base has no package.json', (t) => {
  const { dir, garden } = planted(t);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'none');
  assert.throws(() => lstatSync(join(garden, 'beds', 'any-type', 'node_modules')), { code: 'ENOENT' });
});

function installed(t: TestContext, lockfile = 'package-lock.json'): string {
  const dir = repo(t);
  commit(dir, {
    '.gitignore': 'node_modules/\n',
    'package.json': '{ "name": "x" }\n',
    [lockfile]: 'lockfileVersion: 3\n',
  });
  mkdirSync(join(dir, 'node_modules'));
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  return dir;
}

test('bed links the checkout node_modules when the bed has the same lockfile', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'node_modules', 'marker.txt'), 'installed\n');

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'linked');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.equal(realpathSync.native(linked), realpathSync.native(join(dir, 'node_modules')));
  assert.equal(readFileSync(join(linked, 'marker.txt'), 'utf8'), 'installed\n');
});

test('bed links the checkout node_modules when the bed has the same pnpm lockfile', (t) => {
  const dir = installed(t, 'pnpm-lock.yaml');

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'linked');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.equal(realpathSync.native(linked), realpathSync.native(join(dir, 'node_modules')));
});

test('bed links the checkout node_modules when the bed has the same yarn lockfile', (t) => {
  const dir = installed(t, 'yarn.lock');

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'linked');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.equal(realpathSync.native(linked), realpathSync.native(join(dir, 'node_modules')));
});

test('bed names the package.json that is not valid JSON, with its bed path', (t) => {
  const dir = repo(t);
  commit(dir, {
    '.gitignore': 'node_modules/\n',
    'package.json': '{ "name": \n',
    'package-lock.json': 'lockfileVersion: 3\n',
  });
  mkdirSync(join(dir, 'node_modules'));
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /beds[\\/]any-type[\\/]package\.json/);
});

test('bed on an existing linked bed reports it linked', (t) => {
  const dir = installed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'linked');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('deps'), 'linked');
});

test('bed on an existing bed that was never installed asks for the install again', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'install');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('deps'), 'install');
});

test('bed asks for an install, and links nothing, when the bed lockfile is a link to the checkout lockfile', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'install');
  const bedLockfile = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'package-lock.json');
  rmSync(bedLockfile);
  symlinkSync(join(dir, 'package-lock.json'), bedLockfile, 'file');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('deps'), 'install');
});

test('bed on an existing bed with its own install reports it installed, not linked', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'install');
  mkdirSync(join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules'));

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('deps'), 'installed');
});

test('bed on an existing bed with a Plug and Play install reports it installed', (t) => {
  const dir = installed(t, 'yarn.lock');
  writeFileSync(join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'install');
  writeFileSync(join(dirname(dir), 'repo.garden', 'beds', 'any-type', '.pnp.cjs'), '');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('deps'), 'installed');
});

test('bed asks for an install, and links nothing, when the checkout installed from another lockfile', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
  assert.equal(existsSync(join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules')), false);
});

test('bed asks for an install, and links nothing, when the checkout has no node_modules', (t) => {
  const dir = installed(t);
  rmSync(join(dir, 'node_modules'), { recursive: true });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.throws(() => lstatSync(linked), { code: 'ENOENT' });
});

test('bed asks for an install, and links nothing, when package.json declares workspaces', (t) => {
  const dir = installed(t);
  commit(dir, { 'package.json': '{ "name": "x", "workspaces": ["packages/*"] }\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.throws(() => lstatSync(linked), { code: 'ENOENT' });
});

test('bed asks for an install, and links nothing, in a pnpm workspace', (t) => {
  const dir = installed(t, 'pnpm-lock.yaml');
  commit(dir, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
  const linked = join(dirname(dir), 'repo.garden', 'beds', 'any-type', 'node_modules');
  assert.throws(() => lstatSync(linked), { code: 'ENOENT' });
});

test('bed before the site exists says to open it first and makes nothing', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /site\.ts open/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden')), false);
});

test('bed with a folder at the site path that is no site says to open it first', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  mkdirSync(join(dirname(dir), 'repo.garden'));

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /site\.ts open/);
});

test('bed asks for an install when only the checkout has a lockfile', (t) => {
  const dir = repo(t);
  commit(dir, { '.gitignore': 'node_modules/\npackage-lock.json\n', 'package.json': '{ "name": "x" }\n' });
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
  mkdirSync(join(dir, 'node_modules'));
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
});

test('bed refuses a base that git would read as an option and runs nothing it names', (t) => {
  const { dir, garden } = planted(t);
  const marker = join(dirname(dir), 'injected').replaceAll('\\', '/');

  const result = site(dir, ['bed', '--class', 'any-type', `--base=--upload-pack=touch '${marker}'`]);

  assert.equal(existsSync(marker), false);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /upload-pack/);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});
