// Run: node --test weeds-close.test.ts
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claimLifetimeMs, replay } from './log.ts';
import { openSite, readLog } from './store-log.ts';
import { commit, git } from './test-repo.ts';
import { bareRemote, planted, sharedPair, site } from './test-site.ts';
import { addWeed, cli, now } from './test-weeds.ts';

test("close-class after the site's claim expired is refused once its first sync fetches another writer's newer claim", (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const afterUntil = new Date(now.getTime() + claimLifetimeMs);
  git(second.dir, ['config', 'lzGardening.name', 'test']);
  assert.equal(cli(second.dir, ['claim', '--class', 'any-type'], process.env, afterUntil).code, 0);

  const closed = cli(
    first.dir,
    ['close-class', '--class', 'any-type', '--one-off', 'generated code'],
    process.env,
    afterUntil,
  );

  assert.deepEqual(
    [closed.code, closed.stderr],
    [1, 'weeds close-class: any-type is claimed by test until 2026-11-08T00:00:00.000Z\n'],
  );
});

test('close-class by a site that holds no claim of the class exits 1, says so and closes nothing', (t) => {
  const { dir, garden } = planted(t);
  addWeed(dir, 'src/a.ts:1');

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code'], process.env, now);

  assert.deepEqual(
    [closed.code, closed.stderr, replay(readLog({ path: garden }).events, now).open.length],
    [1, 'weeds close-class: this site holds no claim of any-type; run weeds claim --class any-type\n', 1],
  );
});

test('close whose origin cannot be reached closes, exits 0, and says it planned offline and why it shared nothing', (t) => {
  const { dir } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);
  const id = addWeed(dir, 'src/a.ts:1');

  const closed = cli(dir, ['close', '--id', id, '--one-off', 'generated code']);

  assert.deepEqual([closed.code, closed.stdout], [0, 'closed 1; offline\n']);
  assert.match(
    closed.stderr,
    /^weeds close: planned offline \(fatal: '.*missing\.git' does not appear to be a git repository\)\nweeds close: fatal: '.*missing\.git' does not appear to be a git repository\n$/,
  );
});

function ownerOn(remote: string): string | undefined {
  return replay(readLog({ path: remote }).events, now).claims.get('any-type')?.writer;
}

test('close-class --one-off by the holder shares the close and the release of its claim', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code'], process.env, now);

  assert.deepEqual(
    [closed.stdout, ownerOn(remote), replay(readLog({ path: remote }).events, now).open.length],
    ['closed 1; synced\n', undefined, 0],
  );
});

test('close --id --keep by the holder leaves the class claimed on the origin', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  const id = addWeed(dir, 'src/a.ts:1');
  addWeed(dir, 'src/b.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);

  const kept = cli(dir, ['close', '--id', id, '--keep', 'on purpose'], process.env, now);

  assert.deepEqual([kept.stdout, ownerOn(remote)], ['kept 1; synced\n', openSite(dir).writer]);
});

function bedOf(garden: string): string {
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['fetch', '-q', 'origin', 'main']);
  git(garden, ['worktree', 'add', '-q', '-b', 'bed/any-type', bed, 'FETCH_HEAD']);

  return bed;
}

function tendedClose(dir: string, tip: string, at = now): ReturnType<typeof cli> {
  const by = `bed/any-type@${tip.slice(0, 7)}`;

  return cli(dir, ['close-class', '--class', 'any-type', '--tended', by, '--check', 'checks/a.mjs'], process.env, at);
}

test('close-class --tended by the holder shares the close and the release, then the bed', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const tip = commit(bedOf(garden), { 'checks/a.mjs': 'export {};\n' });

  const closed = tendedClose(dir, tip);

  assert.deepEqual(
    [closed.stdout, ownerOn(remote), git(remote, ['rev-parse', 'refs/garden/beds/any-type'])],
    ['closed 1; synced\n', undefined, tip],
  );
});

test('a tended close made with sharing off exits 0, and the next open pushes the close and then its bed', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  git(dir, ['config', 'lzGardening.share', 'false']);
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const tip = commit(bedOf(garden), { 'checks/a.mjs': 'export {};\n' });
  const closed = tendedClose(dir, tip);
  git(dir, ['config', 'lzGardening.share', 'true']);

  const opened = site(dir, ['open', '--base', 'main']);

  assert.deepEqual(
    [closed.code, closed.stdout, opened.summary.get('shared'), git(remote, ['rev-parse', 'refs/garden/beds/any-type'])],
    [0, 'closed 1; local\n', 'synced', tip],
  );
});

test('close-class whose origin cannot be reached exits 1 and closes nothing, as the claim cannot be checked', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  git(dir, ['remote', 'set-url', 'origin', join(dirname(dir), 'missing.git')]);

  const closed = cli(dir, ['close-class', '--class', 'any-type', '--one-off', 'generated code'], process.env, now);

  assert.deepEqual([closed.code, replay(readLog({ path: garden }).events, now).open.length], [1, 1]);
  assert.match(closed.stderr, /^weeds close-class: cannot check the claim of any-type: offline \(fatal: .*\)\n$/);
});

test('close-class --tended whose bed does not descend from the shared bed names it on stderr and exits 0', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  const bed = bedOf(garden);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  assert.equal(tendedClose(dir, commit(bed, { 'checks/a.mjs': 'export {};\n' })).code, 0);
  git(bed, ['reset', '-q', '--hard', 'HEAD~1']);
  addWeed(dir, 'src/b.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);

  const closed = tendedClose(dir, commit(bed, { 'checks/a.mjs': 'export const b = 1;\n' }));

  assert.deepEqual(
    [closed.code, closed.stdout, closed.stderr],
    [0, 'closed 1; synced\n', "weeds close-class: any-type: bed/any-type does not descend from origin's bed\n"],
  );
});

test('close on a garden with no origin prints what it closed and the share state local', (t) => {
  const { dir } = planted(t);
  const id = addWeed(dir, 'src/a.ts:1');

  const closed = cli(dir, ['close', '--id', id, '--one-off', 'generated code']);

  assert.deepEqual([closed.code, closed.stdout, closed.stderr], [0, 'closed 1; local\n', '']);
});
