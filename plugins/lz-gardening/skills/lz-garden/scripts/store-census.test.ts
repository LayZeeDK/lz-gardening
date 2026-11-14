import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openSite } from './store-log.ts';
import { censusRef, pendingCensusRef, readCensusAt, writePendingCensus } from './store-census.ts';
import type { StoredCensus } from './store-census.ts';
import { sync } from './store-sync.ts';
import { commit, git } from './test-repo.ts';
import { bareRemote, planted, sharedPair, site } from './test-site.ts';

function censusText(sha: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const census = {
    rev: 'main',
    sha,
    takenAt: '2026-11-13T00:00:00.000Z',
    counts: {},
    hits: {},
    duplicates: {},
    ...extra,
  };

  return `${JSON.stringify(census, null, 2)}\n`;
}

function storedAt(garden: string, ref: string): StoredCensus {
  const read = readCensusAt(garden, ref);
  assert.ok(typeof read === 'object' && read !== null, `${ref} holds a census`);

  return read;
}

test('a pending census reads back byte for byte', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const text = censusText(sha, { hits: { 'any-type': ['src/ä.ts:1: const ü: any = 1;'] } });

  writePendingCensus({ path: garden, checkout: dir }, sha, text);

  assert.equal(storedAt(garden, pendingCensusRef(sha)).text, text);
});

test('a pending census taken with extra patterns carries them as written', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const patterns = '{ "patterns": [{ "id": "todo", "regex": "TODO" }] }\n';

  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha), patterns);

  assert.equal(storedAt(garden, pendingCensusRef(sha)).patterns, patterns);
});

test('a census ref whose census.json is not a census reads as not a census', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);

  writePendingCensus({ path: garden, checkout: dir }, sha, '{"rev":"main"}\n');

  assert.equal(readCensusAt(garden, pendingCensusRef(sha)), 'not a census');
});

test('a census ref whose census.json is not JSON reads as not a census', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);

  writePendingCensus({ path: garden, checkout: dir }, sha, 'not json\n');

  assert.equal(readCensusAt(garden, pendingCensusRef(sha)), 'not a census');
});

function censusRefs(garden: string): string {
  return git(garden, ['for-each-ref', '--format=%(refname) %(objectname)', censusRef, 'refs/garden/pending']);
}

test('a sync of a garden with no origin records the pending census as its census', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));
  const pending = git(garden, ['rev-parse', pendingCensusRef(sha)]);

  sync(openSite(dir), { attempts: 1, census: sha });

  assert.equal(censusRefs(garden), `${censusRef} ${pending}`);
});

function record(place: { readonly dir: string; readonly garden: string }, sha: string): string {
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));
  const pending = git(place.garden, ['rev-parse', pendingCensusRef(sha)]);
  sync(openSite(place.dir), { attempts: 1, census: sha });

  return pending;
}

test('a sync keeps the census when the pending census is of an older base commit, and drops the pending one', (t) => {
  const place = planted(t);
  const older = git(place.dir, ['rev-parse', 'HEAD']);
  const kept = record(place, commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' }));

  record(place, older);

  assert.equal(censusRefs(place.garden), `${censusRef} ${kept}`);
});

test('a sync --census of a newer base deletes the pending census of an older base a crashed tick left', (t) => {
  const place = planted(t);
  const older = git(place.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, older, censusText(older));

  const recorded = record(place, commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' }));

  assert.equal(censusRefs(place.garden), `${censusRef} ${recorded}`);
});

test('a sync --census keeps a pending census of a base that descends from the census it records', (t) => {
  const place = planted(t);
  const older = git(place.dir, ['rev-parse', 'HEAD']);
  const newer = commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: place.garden, checkout: place.dir }, newer, censusText(newer));
  const pending = git(place.garden, ['rev-parse', pendingCensusRef(newer)]);

  const recorded = record(place, older);

  assert.equal(censusRefs(place.garden), `${censusRef} ${recorded}\n${pendingCensusRef(newer)} ${pending}`);
});

test('a sync --census keeps a pending census of a commit the checkout lacks', (t) => {
  const place = planted(t);
  const missing = 'f'.repeat(40);
  writePendingCensus({ path: place.garden, checkout: place.dir }, missing, censusText(missing));
  const pending = git(place.garden, ['rev-parse', pendingCensusRef(missing)]);

  const recorded = record(place, git(place.dir, ['rev-parse', 'HEAD']));

  assert.equal(censusRefs(place.garden), `${censusRef} ${recorded}\n${pendingCensusRef(missing)} ${pending}`);
});

test('a sync whose log the origin already holds still pushes the census it records', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  assert.equal(sync(openSite(place.dir), { attempts: 1 }).state, 'synced');

  const recorded = record(place, git(place.dir, ['rev-parse', 'HEAD']));

  assert.equal(git(remote, ['for-each-ref', '--format=%(objectname)', censusRef]), recorded);
});

// A base commit pushed to origin, as a census is shared only of a commit a branch fetched from origin holds.
function onOrigin(place: { readonly dir: string }, sha: string): string {
  git(place.dir, ['push', '-q', 'origin', `${sha}:refs/heads/base-${sha.slice(0, 8)}`]);

  return sha;
}

function remoteCensus(remote: string): string {
  return git(remote, ['for-each-ref', '--format=%(objectname)', censusRef]);
}

test('a census of a newer base commit replaces the shared census on the origin', (t) => {
  const { first, second, remote } = sharedPair(t);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));

  const newer = record(second, onOrigin(second, commit(second.dir, { 'src/b.ts': 'export const b = 2;\n' })));

  assert.equal(remoteCensus(remote), newer);
});

test('a census deleted on the origin is pushed back by the next sync', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  const recorded = record(place, git(place.dir, ['rev-parse', 'HEAD']));
  git(remote, ['update-ref', '-d', censusRef]);

  sync(openSite(place.dir), { attempts: 1 });

  assert.equal(remoteCensus(remote), recorded);
});

test('a site with no census takes the shared census as its own', (t) => {
  const { first, second } = sharedPair(t);
  const shared = record(first, git(first.dir, ['rev-parse', 'HEAD']));

  sync(openSite(second.dir), { attempts: 1 });

  assert.equal(censusRefs(second.garden), `${censusRef} ${shared}`);
});

test('a site takes a shared census of a newer base commit in place of its own, and leaves it on the origin', (t) => {
  const { first, second, remote } = sharedPair(t);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));
  sync(openSite(second.dir), { attempts: 1 });
  const newer = record(first, onOrigin(first, commit(first.dir, { 'src/b.ts': 'export const b = 2;\n' })));

  sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([censusRefs(second.garden), remoteCensus(remote)], [`${censusRef} ${newer}`, newer]);
});

test('a census of a newer base commit recorded while the garden was local is kept over the shared one, and pushed', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  record(place, git(place.dir, ['rev-parse', 'HEAD']));
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  const newer = record(place, onOrigin(place, commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' })));
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([censusRefs(place.garden), remoteCensus(remote)], [`${censusRef} ${newer}`, newer]);
});

function pushNotACensus(place: { readonly dir: string; readonly garden: string }, remote: string): string {
  const sha = git(place.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, '{"rev":"main"}\n');
  git(place.garden, ['push', '-q', remote, `+${pendingCensusRef(sha)}:${censusRef}`]);
  git(place.garden, ['update-ref', '-d', pendingCensusRef(sha)]);

  return remoteCensus(remote);
}

test('a shared census that is not a census is not taken in place of the local one', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  const recorded = record(place, git(place.dir, ['rev-parse', 'HEAD']));
  pushNotACensus(place, remote);

  sync(openSite(place.dir), { attempts: 1 });

  assert.equal(censusRefs(place.garden), `${censusRef} ${recorded}`);
});

test('a sync says when it left out a shared census that is not a census', (t) => {
  const place = planted(t);
  pushNotACensus(place, bareRemote(place.dir));

  assert.equal(sync(openSite(place.dir), { attempts: 1 }).sharedCensusIgnored, true);
});

test('a sync whose origin cannot be reached records the pending census as its census', (t) => {
  const place = planted(t);
  git(place.dir, ['remote', 'add', 'origin', join(dirname(place.dir), 'no-such-remote.git')]);

  const pending = record(place, git(place.dir, ['rev-parse', 'HEAD']));

  assert.equal(censusRefs(place.garden), `${censusRef} ${pending}`);
});

function eachHolds(
  places: readonly { readonly dir: string; readonly garden: string }[],
  remote: string,
): readonly string[] {
  places.forEach((place) => sync(openSite(place.dir), { attempts: 1 }));

  return [...places.map((place) => censusRefs(place.garden)), `${censusRef} ${remoteCensus(remote)}`];
}

test('two clones that take censuses of the same base commit both end with the first one shared', (t) => {
  const { first, second, remote } = sharedPair(t);
  const base = git(first.dir, ['rev-parse', 'HEAD']);
  const shared = record(first, base);

  record(second, base);

  assert.deepEqual(eachHolds([first, second], remote), Array(3).fill(`${censusRef} ${shared}`));
});

test('a clone that takes a census of an ancestor of the shared census base keeps the shared census', (t) => {
  const { first, second, remote } = sharedPair(t);
  const older = git(first.dir, ['rev-parse', 'HEAD']);
  const shared = record(first, onOrigin(first, commit(first.dir, { 'src/b.ts': 'export const b = 2;\n' })));
  git(second.dir, ['fetch', '-q', first.dir, 'main']);

  record(second, older);

  assert.deepEqual(eachHolds([first, second], remote), Array(3).fill(`${censusRef} ${shared}`));
});

test('a clone that takes a census of a descendant of the shared census base replaces it on both', (t) => {
  const { first, second, remote } = sharedPair(t);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));

  const newer = record(second, onOrigin(second, commit(second.dir, { 'src/b.ts': 'export const b = 2;\n' })));

  assert.deepEqual(eachHolds([first, second], remote), Array(3).fill(`${censusRef} ${newer}`));
});

test('a clone that takes a census of a rewritten base replaces the shared census on both', (t) => {
  const { first, second, remote } = sharedPair(t);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));

  const rewritten = record(second, onOrigin(second, rewrittenBase(second.dir)));

  assert.deepEqual(eachHolds([first, second], remote), Array(3).fill(`${censusRef} ${rewritten}`));
});

test('a clone whose checkout lacks the shared census base commit records its own census over it', (t) => {
  const { first, second, remote } = sharedPair(t);
  record(first, commit(first.dir, { 'src/b.ts': 'export const b = 2;\n' }));

  const own = record(second, git(second.dir, ['rev-parse', 'HEAD']));

  assert.deepEqual(eachHolds([second], remote), Array(2).fill(`${censusRef} ${own}`));
});

function rewrittenBase(dir: string): string {
  git(dir, ['switch', '-q', '--orphan', 'rewritten']);

  return commit(dir, { 'src/a.ts': 'export const a = 3;\n' });
}

test('a census push whose lease another clone took first is decided again against the census fetched next', (t) => {
  const { first, second, remote } = sharedPair(t);
  const staleMirror = join(dirname(second.dir), 'mirror.git');
  git(dirname(second.dir), ['init', '-q', '--bare', staleMirror]);
  git(second.dir, ['remote', 'set-url', 'origin', staleMirror]);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', remote]);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));
  const sha = onOrigin(second, rewrittenBase(second.dir));
  writePendingCensus({ path: second.garden, checkout: second.dir }, sha, censusText(sha));
  const pending = git(second.garden, ['rev-parse', pendingCensusRef(sha)]);
  const waits: number[] = [];

  const result = sync(openSite(second.dir), {
    attempts: 2,
    census: sha,
    wait: (ms) => {
      waits.push(ms);
      git(remote, ['push', '-q', staleMirror, 'refs/garden/*:refs/garden/*']);
    },
  });

  assert.deepEqual(
    [result.state, waits.length, remoteCensus(remote), censusRefs(second.garden)],
    ['synced', 1, pending, `${censusRef} ${pending}`],
  );
});

// Another sync of the site moves the census to `to` just before each census move this process makes.
function anotherSyncMovesTheCensusFirst(t: TestContext, garden: string, to: string): void {
  const { spawnSync } = childProcess;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;

    if (Array.isArray(gitArgs) && gitArgs.includes('update-ref') && gitArgs.includes(censusRef)) {
      spawnSync('git', ['update-ref', censusRef, to], { cwd: garden });
    }

    return Reflect.apply(spawnSync, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });
}

test('a sync whose move to the shared census another sync of the site beat with another census ends behind', (t) => {
  const { first, second } = sharedPair(t);
  record(first, git(first.dir, ['rev-parse', 'HEAD']));
  const sha = commit(second.dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: second.garden, checkout: second.dir }, sha, censusText(sha));
  anotherSyncMovesTheCensusFirst(t, second.garden, git(second.garden, ['rev-parse', pendingCensusRef(sha)]));

  assert.equal(sync(openSite(second.dir), { attempts: 1 }).state, 'behind');
});

test('a sync whose record of its pending census another sync of the site beat with another census ends behind', (t) => {
  const place = planted(t);
  bareRemote(place.dir);
  const sha = git(place.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));
  const other = commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: place.garden, checkout: place.dir }, other, censusText(other));
  anotherSyncMovesTheCensusFirst(t, place.garden, git(place.garden, ['rev-parse', pendingCensusRef(other)]));

  assert.equal(sync(openSite(place.dir), { attempts: 1, census: sha }).state, 'behind');
});

test('a sync --census whose last record another sync of the site beat keeps the pending census', (t) => {
  const place = planted(t);
  const sha = git(place.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));
  const pending = git(place.garden, ['rev-parse', pendingCensusRef(sha)]);
  const other = commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: place.garden, checkout: place.dir }, other, censusText(other));
  const theirs = git(place.garden, ['rev-parse', pendingCensusRef(other)]);
  anotherSyncMovesTheCensusFirst(t, place.garden, theirs);

  sync(openSite(place.dir), { attempts: 1, census: sha });

  assert.deepEqual(
    [
      git(place.garden, ['rev-parse', censusRef]),
      git(place.garden, ['for-each-ref', '--format=%(objectname)', pendingCensusRef(sha)]),
    ],
    [theirs, pending],
  );
});

test('a census move that fails while the census is as it was stops the sync with what git said', (t) => {
  const place = planted(t);
  const sha = git(place.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));
  mkdirSync(join(place.garden, '.git', 'refs', 'garden'), { recursive: true });
  writeFileSync(join(place.garden, '.git', 'refs', 'garden', 'census.lock'), '');

  assert.throws(
    () => sync(openSite(place.dir), { attempts: 1, census: sha }),
    /cannot lock ref 'refs\/garden\/census'/,
  );
});

test('a census of a commit no branch fetched from origin holds stays local, and the sync says so on stderr', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  const sha = commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));
  const pending = git(place.garden, ['rev-parse', pendingCensusRef(sha)]);

  const synced = site(place.dir, ['sync', '--census', sha]);

  assert.deepEqual(
    [synced.status, synced.stderr, remoteCensus(remote), git(place.garden, ['rev-parse', censusRef])],
    [0, `site: the census of ${sha} stays local: no branch fetched from origin holds that commit\n`, '', pending],
  );
});

test('a census of a commit only a tag and another remote hold stays local', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  const upstream = join(dirname(place.dir), 'upstream.git');
  git(place.dir, ['init', '-q', '--bare', upstream]);
  git(place.dir, ['remote', 'add', 'upstream', upstream]);
  const sha = commit(place.dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(place.dir, ['tag', 'private']);
  git(place.dir, ['push', '-q', 'upstream', 'main']);
  git(place.dir, ['reset', '-q', '--hard', 'HEAD~1']);
  writePendingCensus({ path: place.garden, checkout: place.dir }, sha, censusText(sha));

  const synced = site(place.dir, ['sync', '--census', sha]);

  assert.deepEqual(
    [synced.status, synced.stderr, remoteCensus(remote), git(upstream, ['rev-parse', 'main'])],
    [0, `site: the census of ${sha} stays local: no branch fetched from origin holds that commit\n`, '', sha],
  );
});

test('a census commit is signed lz-gardening with no address, and an origin that checks every object takes it', (t) => {
  const place = planted(t);
  const remote = bareRemote(place.dir);
  git(remote, ['config', 'receive.fsckObjects', 'true']);
  const sha = git(place.dir, ['rev-parse', 'HEAD']);

  const pending = record(place, sha);

  assert.deepEqual(
    [git(place.garden, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', pending]), remoteCensus(remote)],
    ['lz-gardening <>|lz-gardening <>', pending],
  );
});
