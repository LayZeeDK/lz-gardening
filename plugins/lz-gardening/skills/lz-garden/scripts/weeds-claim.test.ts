// Run: node --test weeds-claim.test.ts
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { eventPath, replay } from './log.ts';
import { logRef, openSite, readLog } from './store-log.ts';
import { sleep, sync } from './store-sync.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import { git, now } from './test-repo.ts';
import { bareRemote, planted, remoteHook } from './test-site.ts';
import { addWeed, cli, cliWith } from './test-weeds.ts';

function claimsIn(gitDir: string): readonly (readonly unknown[])[] {
  if (git(gitDir, ['for-each-ref', logRef]) === '') {
    return [];
  }

  return [...logFiles(gitDir).values()]
    .filter((event) => event['op'] === 'claim')
    .map((event) => [event['class'], event['until']]);
}

test('claim --class with an origin pushes the claim and prints the class and until', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, claimsIn(remote)],
    [0, 'claimed any-type until 2026-11-07T18:00:00.000Z\n', [['any-type', '2026-11-07T18:00:00.000Z']]],
  );
});

test('claim with nothing ready prints nothing ready to tend, exits 1 and pushes no claim', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim'], process.env, now);

  assert.deepEqual([claimed.status, claimed.stdout, claimsIn(remote)], [1, 'nothing ready to tend\n', []]);
});

test('claim --class of a class with nothing open prints nothing open for it and exits 1', (t) => {
  const { dir, garden } = planted(t);

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual([claimed.status, claimed.stdout, claimsIn(garden)], [1, 'nothing open for any-type\n', []]);
});

function holders(gitDir: string): readonly unknown[] {
  return [...logFiles(gitDir).values()].filter((event) => event['op'] === 'claim').map((event) => event['holder']);
}

test("a claim's holder is the checkout's lzGardening.name when it is set", (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['config', 'lzGardening.name', 'Ada']);
  addWeed(dir, 'src/a.ts:1');

  cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(holders(garden), ['Ada']);
});

test("a claim's holder has a control character in lzGardening.name escaped, so every reader parses the claim", (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['config', 'lzGardening.name', 'Ada\u0007']);
  addWeed(dir, 'src/a.ts:1');

  cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.equal(replay(readLog({ path: garden }).events, now).claims.get('any-type')?.holder, 'Ada\\u{7}');
});

test("a claim's holder is writer and the first 8 characters of the writer id, never user.name", (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['config', 'user.name', 'Ada Lovelace']);
  git(garden, ['config', 'user.name', 'Ada Lovelace']);
  addWeed(dir, 'src/a.ts:1');

  cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(holders(garden), [`writer ${git(garden, ['config', 'lzGardening.writer']).slice(0, 8)}`]);
});

function releasedClaims(gitDir: string): readonly (readonly [unknown, boolean])[] {
  const events = [...logFiles(gitDir).values()];
  const released = new Set(events.filter((event) => event['op'] === 'release').map((event) => event['claim']));

  return events
    .filter((event) => event['op'] === 'claim')
    .map((event) => [event['class'], released.has(event['uuid'])] as const);
}

test('claim --class whose origin cannot be reached says it cannot claim, offline, with the release pending', (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.equal(claimed.status, 1);
  assert.match(
    claimed.stdout,
    /^cannot claim any-type: offline \(fatal: '.*missing\.git' does not appear to be a git repository\); release pending\n$/,
  );
  assert.deepEqual(releasedClaims(garden), [['any-type', true]]);
});

// A hook still sleeping holds the remote folder, so the test's clean-up waits for it to finish.
function waitFor(file: string): void {
  const deadline = Date.now() + 20_000;

  while (!existsSync(file) && Date.now() < deadline) {
    sleep(100);
  }
}

test('claim --class whose origin declines the push says it cannot claim, read-only, with the reason, and releases', (t) => {
  const { dir, garden } = planted(t);
  remoteHook(bareRemote(dir), 'pre-receive', 'echo "refs/garden is closed here"\nexit 1');
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, releasedClaims(garden)],
    [
      1,
      'cannot claim any-type: read-only (remote: refs/garden is closed here); release pending\n',
      [['any-type', true]],
    ],
  );
});

test('claim --class whose push the origin takes after the time is up releases the claim on the origin', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(sync(openSite(dir), { attempts: 1 }).state, 'synced');
  remoteHook(
    remote,
    'post-receive',
    'if [ -f slow ]; then\n  rm slow\n  i=0\n  while [ ! -f go ] && [ $i -lt 600 ]; do\n    sleep 0.1\n    i=$((i + 1))\n  done\n  touch slept\nfi',
  );
  writeFileSync(join(remote, 'slow'), '');

  const claimed = cliWith(dir, ['claim', '--class', 'any-type'], { timeoutMs: 4000 });
  writeFileSync(join(remote, 'go'), '');
  waitFor(join(remote, 'slept'));

  assert.deepEqual(
    [claimed.status, claimed.stdout, releasedClaims(remote)],
    [1, 'cannot claim any-type: offline (timed out)\n', [['any-type', true]]],
  );
});

test("a holder that claims again renews: claimed with the later until, and the origin's owner is still the holder", (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).status, 0);
  const later = new Date(now.getTime() + 60 * 60 * 1000);

  const renewed = cli(dir, ['claim', '--class', 'any-type'], process.env, later);
  const owner = replay(readLog({ path: remote }).events, later).claims.get('any-type');

  assert.deepEqual(
    [renewed.status, renewed.stdout, owner?.writer, owner?.until],
    [
      0,
      'claimed any-type until 2026-11-07T19:00:00.000Z\n',
      git(garden, ['config', 'lzGardening.writer']),
      '2026-11-07T19:00:00.000Z',
    ],
  );
});

test('claim --class of a class another writer holds prints taken with the holder, exits 1 and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  addWeed(dir, 'src/a.ts:1');
  const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
  const held = { op: 'claim', uuid, clock: 9, at: now.toISOString(), class: 'any-type', writer: 'w', holder: 'Bea' };
  writeToLogByHand(garden, `events/0f/${uuid}.json`, JSON.stringify({ ...held, until: '2026-11-07T15:00:00.000Z' }));

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, claimsIn(garden)],
    [1, 'taken any-type by Bea until 2026-11-07T15:00:00.000Z\n', [['any-type', '2026-11-07T15:00:00.000Z']]],
  );
});

// Another writer's claim of each of the classes reaches origin after this site claims the class and before the site's
// next fetch, so the sync that shares the site's claim finds the class lost.
function anotherWriterClaimsFirst(t: TestContext, garden: string, remote: string, classes: readonly string[]): void {
  const { spawnSync } = childProcess;
  const stillToClaim = new Set(classes);
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;

    if (Array.isArray(gitArgs) && gitArgs.includes('fetch')) {
      claimsIn(garden).forEach(([weedClass]) => {
        if (typeof weedClass === 'string' && stillToClaim.delete(weedClass)) {
          const uuid = randomUUID();
          const held = { op: 'claim', uuid, clock: 1, at: now.toISOString(), class: weedClass, writer: 'w' };
          const claim = { ...held, holder: 'Bea', until: '2026-11-07T15:00:00.000Z' };
          writeToLogByHand(remote, eventPath(uuid), JSON.stringify(claim));
        }
      });
    }

    return Reflect.apply(spawnSync, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });
}

function addReadyClass(dir: string, weedClass: string): void {
  addWeed(dir, 'src/a.ts:1', weedClass);
  addWeed(dir, 'src/b.ts:1', weedClass);
}

test('claim with no class claims the next ready class when another writer takes the first one first', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addReadyClass(dir, 'any-type');
  addReadyClass(dir, 'todo-marker');
  anotherWriterClaimsFirst(t, garden, remote, ['any-type']);

  const claimed = cli(dir, ['claim'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, replay(readLog({ path: remote }).events, now).claims.get('any-type')?.holder],
    [0, 'claimed todo-marker until 2026-11-07T18:00:00.000Z\n', 'Bea'],
  );
});

test('claim with no class gives up after three classes other writers took first, and says who took the third', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  const classes = ['any-type', 'double-cast', 'todo-marker'];
  classes.forEach((weedClass) => {
    addReadyClass(dir, weedClass);
  });
  anotherWriterClaimsFirst(t, garden, remote, classes);

  const claimed = cli(dir, ['claim'], process.env, now);

  assert.deepEqual([claimed.status, claimed.stdout], [1, 'taken todo-marker by Bea until 2026-11-07T15:00:00.000Z\n']);
});

test('claim --class of a class another writer takes first says taken, exits 1 and plans once, naming a skipped event file once', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  writeToLogByHand(garden, 'events/ab/abc.json', '{}');
  anotherWriterClaimsFirst(t, garden, remote, ['any-type']);

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, claimed.stderr],
    [
      1,
      'taken any-type by Bea until 2026-11-07T15:00:00.000Z\n',
      'weeds: skipped events/ab/abc.json: missing uuid, clock or at\n',
    ],
  );
});

function readyRows(dir: string): readonly unknown[] {
  const listed = cli(dir, ['groups', '--ready'], process.env, now);
  assert.equal(listed.status, 0, listed.stderr);

  return listed.stdout
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((row) => row.split(' ')[0]);
}

test('groups --ready lists the classes a claim would take, not stale-verification', (t) => {
  const { dir } = planted(t);
  ['any-type', 'stale-verification'].forEach((weedClass) => {
    addWeed(dir, 'src/a.ts:1', weedClass);
    addWeed(dir, 'src/b.ts:1', weedClass);
  });

  assert.deepEqual(readyRows(dir), ['any-type']);
});

test('groups --ready leaves out a class another writer holds and keeps one this writer holds', (t) => {
  const { dir, garden } = planted(t);
  ['any-type', 'todo-marker'].forEach((weedClass) => {
    addWeed(dir, 'src/a.ts:1', weedClass);
    addWeed(dir, 'src/b.ts:1', weedClass);
  });
  cli(dir, ['claim', '--class', 'todo-marker'], process.env, now);
  const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
  const held = { op: 'claim', uuid, clock: 99, at: now.toISOString(), class: 'any-type', writer: 'w', holder: 'Bea' };
  writeToLogByHand(garden, `events/0f/${uuid}.json`, JSON.stringify({ ...held, until: '2026-11-07T15:00:00.000Z' }));

  assert.deepEqual(readyRows(dir), ['todo-marker']);
});

test('release --class by a site holding no claim of the class says so, exits 1 and pushes nothing', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);

  const released = cli(dir, ['release', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [released.status, released.stdout, git(remote, ['for-each-ref', 'refs/garden'])],
    [1, 'no claim of any-type held here\n', ''],
  );
});

test('release whose origin can no longer be reached releases, exits 0, and says why it shared nothing', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).status, 0);
  git(dir, ['remote', 'set-url', 'origin', join(dirname(dir), 'missing.git')]);

  const released = cli(dir, ['release', '--class', 'any-type'], process.env, now);

  assert.deepEqual([released.status, released.stdout], [0, 'released any-type; offline\n']);
  assert.match(released.stderr, /^weeds release: fatal: '.*missing\.git' does not appear to be a git repository\n$/);
});

test('claim and release with a class that is not a kebab-case class id are usage errors', (t) => {
  const { dir } = planted(t);

  const results = [
    cli(dir, ['claim', '--class', 'Any Type'], process.env, now),
    cli(dir, ['release', '--class', 'Any Type'], process.env, now),
    cli(dir, ['release'], process.env, now),
  ];

  assert.deepEqual(
    results.map(({ status, stderr }) => [status, stderr]),
    [
      [2, 'weeds claim: --class must be kebab-case\n'],
      [2, 'weeds release: --class must be kebab-case\n'],
      [2, 'weeds release: --class must be kebab-case\n'],
    ],
  );
});

test('groups shows the holder of a claimed class in a last tending column and a dash for the others', (t) => {
  const { dir } = planted(t);
  git(dir, ['config', 'lzGardening.name', 'test']);
  addWeed(dir, 'src/a.ts:1');
  addWeed(dir, 'src/b.ts:1', 'todo-marker');
  cli(dir, ['claim', '--class', 'any-type']);

  const lines = cli(dir, ['groups']).stdout.trimEnd().split('\n');

  assert.deepEqual(
    [lines[0]?.endsWith(' first-seen tending'), lines[1]?.split(' ').at(-1), lines[2]?.split(' ').at(-1)],
    [true, 'test', '-'],
  );
});

test('claim --class with no origin claims in the local log', (t) => {
  const { dir, garden } = planted(t);
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.status, claimed.stdout, claimsIn(garden)],
    [0, 'claimed any-type until 2026-11-07T18:00:00.000Z\n', [['any-type', '2026-11-07T18:00:00.000Z']]],
  );
});
