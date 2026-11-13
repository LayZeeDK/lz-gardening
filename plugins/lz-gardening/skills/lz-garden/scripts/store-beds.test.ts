// Run: node --test store-beds.test.ts
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { logRef, openSite, sync } from './store.ts';
import { commit, git } from './test-repo.ts';
import { bareRemote, planted, sharedPair, site, writeCensus } from './test-site.ts';
import { cli } from './test-weeds.ts';

interface Tended {
  readonly dir: string;
  readonly garden: string;
  readonly bed: string;
  readonly remote: string;
}

function bedRef(remote: string, weedClass = 'any-type'): string {
  return git(remote, ['for-each-ref', '--format=%(objectname)', `refs/garden/beds/${weedClass}`]);
}

function withBed(t: TestContext): Tended {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['fetch', '-q', 'origin', 'main']);
  git(garden, ['worktree', 'add', '-q', '-b', 'bed/any-type', bed, 'FETCH_HEAD']);

  return { dir, garden, bed, remote };
}

function tend(place: Tended, files: Readonly<Record<string, string>>, where = 'src/a.ts:1'): string {
  const tip = commit(place.bed, files);
  const added = cli(place.dir, ['add', '--class', 'any-type', '--where', where, '--source', 'census:x']);
  assert.equal(added.code, 0, added.stderr);
  const closed = cli(place.dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip.slice(0, 7)}`,
    '--check',
    'checks/any-type.mjs',
  ]);
  assert.equal(closed.code, 0, closed.stderr);

  return tip;
}

test("a sync that shares a tended close puts its bed commit on the origin's refs/garden/beds/<class>", (t) => {
  const place = withBed(t);
  const tip = tend(place, { 'checks/any-type.mjs': 'export {};\n' });

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, bedRef(place.remote)], ['synced', tip]);
});

test("a tended close whose bed descends from the origin's bed moves that bed forward", (t) => {
  const place = withBed(t);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  sync(openSite(place.dir), { attempts: 1 });
  const later = tend(place, { 'checks/any-type.mjs': 'export const later = 1;\n' }, 'src/b.ts:1');

  sync(openSite(place.dir), { attempts: 1 });

  assert.equal(bedRef(place.remote), later);
});

test("a tended close made in another clone is not pushed from this site's own bed of the class", (t) => {
  const place = withBed(t);
  const other = planted(t);
  git(other.dir, ['remote', 'add', 'origin', place.remote]);
  git(other.dir, ['fetch', '-q', 'origin']);
  const otherBed = join(other.garden, 'beds', 'any-type');
  git(other.garden, ['fetch', '-q', 'origin', 'main']);
  git(other.garden, ['worktree', 'add', '-q', '-b', 'bed/any-type', otherBed, 'FETCH_HEAD']);
  const theirs = tend({ ...other, bed: otherBed, remote: place.remote }, { 'checks/any-type.mjs': 'export {};\n' });
  commit(place.bed, { 'src/mine.ts': 'export const mine = 1;\n' });

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds, bedRef(place.remote)], ['synced', [], theirs]);
});

test('a bed branch moved past the commit its close names pushes nothing', (t) => {
  const place = withBed(t);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.remote, ['update-ref', '-d', 'refs/garden/beds/any-type']);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': 'export const again = 1;\n' }, 'src/b.ts:1');
  commit(place.bed, { 'src/later.ts': 'export const later = 1;\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds, bedRef(place.remote)], ['synced', [], '']);
});

test('a bed ref deleted on the origin after its close was shared is not pushed back', (t) => {
  const place = withBed(t);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  sync(openSite(place.dir), { attempts: 1 });
  git(place.remote, ['update-ref', '-d', 'refs/garden/beds/any-type']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds, bedRef(place.remote)], ['synced', [], '']);
});

test('site sync names a bed it left out on stderr', (t) => {
  const place = withBed(t);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.bed, ['reset', '-q', '--hard', 'HEAD~1']);
  tend(place, { 'checks/any-type.mjs': 'export const other = 1;\n' }, 'src/b.ts:1');

  const synced = site(place.dir, ['sync']);

  assert.deepEqual(
    [synced.status, synced.stderr],
    [0, "site: any-type: bed/any-type does not descend from origin's bed\n"],
  );
});

test("a bed the origin refuses leaves the log synced and is named with git's reason", (t) => {
  const place = withBed(t);
  writeFileSync(
    join(place.remote, 'hooks', 'pre-receive'),
    '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/garden/beds/*) echo "no beds here"; exit 1;; esac\ndone\n',
    { mode: 0o755 },
  );
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote), git(place.remote, ['rev-parse', logRef])],
    [
      'synced',
      ['any-type: [remote rejected] (pre-receive hook declined)'],
      '',
      git(place.garden, ['rev-parse', logRef]),
    ],
  );
});

test('a bed made from a commit no branch fetched from origin holds stays local and is named', (t) => {
  const place = withBed(t);
  const unpushed = commit(place.dir, { 'src/private.ts': 'export const unpushed = 1;\n' });
  git(place.garden, ['fetch', '-q', 'origin', 'main']);
  git(place.bed, ['merge', '-q', '--ff-only', unpushed]);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote)],
    ['synced', ['any-type: bed/any-type stays local: its base is on no branch fetched from origin'], ''],
  );
});

test("a bed that adds a line holding the site's path stays local and is named", (t) => {
  const place = withBed(t);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': `// made in ${realpathSync.native(place.garden)}\nexport {};\n` });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote)],
    ['synced', ['any-type: bed/any-type stays local: it adds a line holding a path on this machine'], ''],
  );
});

function tendedInFirstClone(t: TestContext): {
  readonly second: { dir: string; garden: string };
  readonly tip: string;
} {
  const { first, second } = sharedPair(t);
  const added = cli(first.dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);
  const claimed = cli(first.dir, ['claim', '--class', 'any-type']);
  const made = site(first.dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.deepEqual([added.code, claimed.code, made.status], [0, 0, 0], made.stderr);
  const tip = commit(join(first.garden, 'beds', 'any-type'), { 'checks/any-type.mjs': 'export {};\n' });
  const closed = cli(first.dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip.slice(0, 7)}`,
    '--check',
    'checks/any-type.mjs',
  ]);
  assert.equal(closed.stdout, 'closed 1; synced\n', closed.stderr);

  return { second, tip };
}

test("a class tended in one clone and claimed in another continues the same bed from the first clone's bed", (t) => {
  const { second, tip } = tendedInFirstClone(t);
  cli(second.dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:y']);
  assert.equal(cli(second.dir, ['claim', '--class', 'any-type']).code, 0);

  const made = site(second.dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(made.status, 0, made.stderr);
  assert.equal(git(join(second.garden, 'beds', 'any-type'), ['rev-parse', 'HEAD']), tip);
});

test("a regrown weed in a second clone reads not on the base from the first clone's shared bed", (t) => {
  const { second, tip } = tendedInFirstClone(t);
  assert.equal(site(second.dir, ['open']).status, 0);
  writeCensus(second.garden, git(second.dir, ['rev-parse', 'main']));

  const back = cli(second.dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:y']);

  assert.match(
    back.stdout,
    new RegExp(
      `^regrown \\S+ after bed/any-type@${tip.slice(0, 7)} \\(check: checks/any-type\\.mjs not on the base\\)\\n$`,
    ),
  );
});

test("a bed that does not descend from the origin's bed is left out and named, and the log is still synced", (t) => {
  const place = withBed(t);
  const shared = tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  sync(openSite(place.dir), { attempts: 1 });
  git(place.bed, ['reset', '-q', '--hard', 'HEAD~1']);
  const rewritten = tend(place, { 'checks/any-type.mjs': 'export const other = 1;\n' }, 'src/b.ts:1');
  assert.notEqual(rewritten, shared);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote)],
    ['synced', ["any-type: bed/any-type does not descend from origin's bed"], shared],
  );
});
