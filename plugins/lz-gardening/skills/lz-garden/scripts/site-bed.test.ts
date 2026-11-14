import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { writeToLogByHand } from './test-log.ts';
import { commit, git, init, repo } from './test-repo.ts';
import { logRef } from './store-log.ts';
import { bareRemote, planted, sharedPair, site } from './test-site.ts';
import { cli } from './test-weeds.ts';

function claimAnyType(dir: string): void {
  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  const claimed = cli(dir, ['claim', '--class', 'any-type']);
  assert.deepEqual([added.code, claimed.code], [0, 0], added.stderr + claimed.stderr);
}

function claimed(t: TestContext): { readonly dir: string; readonly garden: string } {
  const garden = planted(t);
  claimAnyType(garden.dir);

  return garden;
}

test('bed makes a worktree on bed/<class> from the base as the repository has it now', (t) => {
  const { dir, garden } = claimed(t);
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

test('bed on an existing bed takes what the base gained since, keeps its work, and starts from the base', (t) => {
  const { dir, garden } = claimed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/a.ts': 'export const a: number = 1;\n' });
  const gained = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('bed'), first.summary.get('bed'));
  assert.equal(again.summary.get('start'), gained);
  assert.equal(readFileSync(join(bed, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.equal(git(bed, ['merge-base', '--is-ancestor', work, 'HEAD']), '');
});

test('bed refuses a base that conflicts with the bed, names the bed, and leaves the bed as it was', (t) => {
  const { dir, garden } = claimed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/a.ts': 'export const a: number = 1;\n' });
  commit(dir, { 'src/a.ts': 'export const a: string = "1";\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type/);
  assert.equal(git(bed, ['rev-parse', 'HEAD']), work);
  assert.equal(git(bed, ['status', '--porcelain', '--untracked-files=no']), '');
});

test('bed refuses a base that would overwrite uncommitted work in the bed, names the bed, and keeps the work', (t) => {
  const { dir, garden } = claimed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  writeFileSync(join(bed, 'src', 'a.ts'), 'export const a: number = 1;\n');
  commit(dir, { 'src/a.ts': 'export const a: string = "1";\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type/);
  assert.equal(readFileSync(join(bed, 'src', 'a.ts'), 'utf8'), 'export const a: number = 1;\n');
});

test('bed whose merge git refuses over an untracked file names git reason, not a merge to finish by hand', (t) => {
  const { dir, garden } = claimed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  writeFileSync(join(bed, 'src', 'b.ts'), 'export const b = 99;\n');
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(
    again.stderr,
    /^site: main does not merge into .*beds[\\/]any-type: error: The following untracked working tree files would be overwritten by merge:\n$/,
  );
  assert.equal(readFileSync(join(bed, 'src', 'b.ts'), 'utf8'), 'export const b = 99;\n');
});

test('bed leaves a merge someone started in the bed alone, and names the bed', (t) => {
  const { dir, garden } = claimed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  commit(bed, { 'src/a.ts': 'export const a: number = 1;\n' });
  const gained = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(garden, ['fetch', '-q', 'origin', 'main']);
  git(bed, ['merge', '--no-commit', '--no-ff', gained]);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type/);
  assert.equal(git(bed, ['rev-parse', 'MERGE_HEAD']), gained);
});

test('bed on a bed whose folder is gone brings the folder back with the branch work', (t) => {
  const { dir, garden } = claimed(t);
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
  const { dir, garden } = claimed(t);
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
  const { dir, garden } = claimed(t);
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
  const { dir, garden } = claimed(t);
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
  const { dir, garden } = claimed(t);
  const bed = join(garden, 'beds', 'any-type');
  mkdirSync(dirname(bed), { recursive: true });
  symlinkSync(join(garden, 'gone'), bed, 'junction');

  const made = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(made.status, 2);
  assert.match(made.stderr, /beds[\\/]any-type is not the worktree/);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed refuses a folder at the bed path before it makes the branch, and names the folder', (t) => {
  const { dir, garden } = claimed(t);
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

test('bed for a class this site holds no claim of exits 1, names weeds claim, and makes no branch or worktree', (t) => {
  const { dir, garden } = planted(t);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.deepEqual(
    [result.status, result.stderr, git(garden, ['branch', '--list', 'bed/*']), existsSync(join(garden, 'beds'))],
    [1, 'site: bed: this site holds no claim of any-type; run weeds claim --class any-type\n', '', false],
  );
});

test('bed for a class another writer holds exits 1 and names the holder', (t) => {
  const { dir, garden } = planted(t);
  const at = new Date();
  const until = new Date(at.getTime() + 60 * 60 * 1000).toISOString();
  const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
  const held = { op: 'claim', uuid, clock: 9, at: at.toISOString(), class: 'any-type', writer: 'w', holder: 'Bea' };
  writeToLogByHand(garden, `events/0f/${uuid}.json`, JSON.stringify({ ...held, until }));

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.deepEqual(
    [result.status, result.stderr, git(garden, ['branch', '--list', 'bed/*'])],
    [1, `site: bed: any-type is claimed by Bea until ${until}\n`, ''],
  );
});

test("bed after this site's claim expired exits 1 and makes no branch", (t) => {
  const { dir, garden } = planted(t);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:any-type']);
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, new Date('2026-01-01T00:00:00.000Z')).code, 0);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.deepEqual(
    [result.status, result.stderr, git(garden, ['branch', '--list', 'bed/*'])],
    [1, 'site: bed: this site holds no claim of any-type; run weeds claim --class any-type\n', ''],
  );
});

test('bed whose pre-sync is offline exits 1, names the state, and makes no branch', (t) => {
  const { dir, garden } = claimed(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^site: bed: cannot check the claim of any-type: offline \(fatal: '.*missing\.git' does not appear to be a git repository\)\n$/,
  );
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed right after a pre-sync that shared a claim made while the garden was local makes the bed', (t) => {
  const { dir, garden } = claimed(t);
  const remote = bareRemote(dir);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, ['rev-parse', logRef]), git(garden, ['rev-parse', logRef]));
});

function sharedBed(
  t: TestContext,
  files: Readonly<Record<string, string>>,
): {
  readonly dir: string;
  readonly garden: string;
  readonly tip: string;
  readonly share: (more: Readonly<Record<string, string>>) => string;
} {
  const { first, second, remote } = sharedPair(t);
  git(first.dir, ['switch', '-q', '-c', 'tended']);
  const share = (more: Readonly<Record<string, string>>): string => {
    const shared = commit(first.dir, more);
    git(first.dir, ['push', '-q', '--force', remote, `${shared}:refs/garden/beds/any-type`]);

    return shared;
  };
  const tip = share(files);
  claimAnyType(second.dir);

  return { ...second, tip, share };
}

test('bed with a shared bed and no local branch starts from the shared bed commit and merges the base', (t) => {
  const { dir, garden } = sharedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' });
  const gained = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  const bed = join(garden, 'beds', 'any-type');

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [result.summary.get('start'), readFileSync(join(bed, 'src', 'a.ts'), 'utf8'), existsSync(join(bed, 'src', 'b.ts'))],
    [gained, 'export const a: number = 1;\n', true],
  );
});

test('bed with a local bed behind the shared bed fast-forwards it', (t) => {
  const { dir, garden, share } = sharedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' });
  assert.equal(site(dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const later = share({ 'src/c.ts': 'export const c = 3;\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(join(garden, 'beds', 'any-type'), ['rev-parse', 'HEAD']), later);
});

test('bed with a local bed and a shared bed that both moved merges the shared bed in', (t) => {
  const { dir, garden, share } = sharedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' });
  assert.equal(site(dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/d.ts': 'export const d = 4;\n' });
  const later = share({ 'src/c.ts': 'export const c = 3;\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [work, later].map((commitId) => git(bed, ['merge-base', '--is-ancestor', commitId, 'HEAD'])),
    ['', ''],
  );
});

test('bed whose shared bed conflicts with the local bed exits 2, names the bed, and leaves it as it was', (t) => {
  const { dir, garden, share } = sharedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' });
  assert.equal(site(dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/c.ts': 'export const c = 4;\n' });
  share({ 'src/c.ts': 'export const c = 3;\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /beds[\\/]any-type/);
  assert.deepEqual(
    [git(bed, ['rev-parse', 'HEAD']), git(bed, ['status', '--porcelain', '--untracked-files=no'])],
    [work, ''],
  );
});

test('bed whose shared bed conflicts with the base and no local branch exits 2 and leaves the branch at the shared bed', (t) => {
  const { dir, garden, tip } = sharedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' });
  commit(dir, { 'src/a.ts': 'export const a: string = "1";\n' });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^site: main does not merge into .*beds[\\/]any-type cleanly/);
  assert.deepEqual(
    [git(garden, ['rev-parse', 'bed/any-type']), git(join(garden, 'beds', 'any-type'), ['status', '--porcelain'])],
    [tip, ''],
  );
});

test('bed needs no dependencies when the base has no package.json', (t) => {
  const { dir, garden } = claimed(t);

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
  claimAnyType(dir);

  return dir;
}

function bedOf(summary: ReadonlyMap<string, unknown>): string {
  const bed = summary.get('bed');
  assert.ok(typeof bed === 'string');

  return bed;
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

test('bed names no install command for a bed linked to the checkout install', (t) => {
  const dir = installed(t);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'linked');
  assert.equal(result.summary.has('install'), false);
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
  claimAnyType(dir);

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

test('bed unlinks a linked bed whose lockfile the base changed, asks for an install, and keeps the checkout install', (t) => {
  const dir = installed(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'linked');
  commit(dir, { 'package-lock.json': 'lockfileVersion: 3\n# a new dependency\n' });
  git(dir, ['checkout', '-q', 'HEAD~1']);
  const bed = join(dirname(dir), 'repo.garden', 'beds', 'any-type');

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('deps'), 'install');
  assert.equal(lstatSync(join(bed, 'node_modules'), { throwIfNoEntry: false }), undefined);
  assert.equal(existsSync(join(dir, 'node_modules')), true);
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

test('bed on an existing bed that was never installed names the install command again', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('install'), `npm --prefix '${bedOf(again.summary)}' ci`);
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

test('bed asks for an install, and reads nothing through it, when the bed package.json is a link', (t) => {
  const dir = installed(t);
  writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.summary.get('deps'), 'install');
  const bed = bedOf(first.summary);
  writeFileSync(join(bed, 'package-lock.json'), readFileSync(join(dir, 'package-lock.json')));
  rmSync(join(bed, 'package.json'));
  symlinkSync(join(dir, 'package.json'), join(bed, 'package.json'), 'file');

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

test('bed names the npm command that installs the bed from its npm lockfile', (t) => {
  const dir = installed(t);
  rmSync(join(dir, 'node_modules'), { recursive: true });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
  assert.equal(result.summary.get('install'), `npm --prefix '${bedOf(result.summary)}' ci`);
});

test('bed quotes the bed path in the install command so a shell expands nothing in it', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
  });
  const dir = join(parent, "it's $HOME `x`");
  init(dir);
  commit(dir, { 'package.json': '{ "name": "x" }\n', 'package-lock.json': 'lockfileVersion: 3\n' });
  assert.equal(site(dir, ['open', '--base', 'main']).status, 0);
  claimAnyType(dir);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  const bed = bedOf(result.summary);
  assert.equal(result.summary.get('install'), `npm --prefix '${bed.replaceAll("'", "'\\''")}' ci`);
});

test('bed names the pnpm command that installs the bed from its pnpm lockfile', (t) => {
  const dir = installed(t, 'pnpm-lock.yaml');
  rmSync(join(dir, 'node_modules'), { recursive: true });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('install'), `pnpm -C '${bedOf(result.summary)}' install --frozen-lockfile`);
});

test('bed names the yarn command that installs the bed from its yarn lockfile with the flag Yarn 1 honours too', (t) => {
  const dir = installed(t, 'yarn.lock');
  rmSync(join(dir, 'node_modules'), { recursive: true });

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('install'), `yarn --cwd '${bedOf(result.summary)}' install --frozen-lockfile`);
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
  claimAnyType(dir);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
});

test('bed names npm install, not npm ci, for a bed without a lockfile', (t) => {
  const dir = repo(t);
  commit(dir, { 'package.json': '{ "name": "x" }\n' });
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);
  claimAnyType(dir);

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('install'), `npm --prefix '${bedOf(result.summary)}' install`);
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
