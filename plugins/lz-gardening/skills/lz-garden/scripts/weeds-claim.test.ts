// Run: node --test weeds-claim.test.ts
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { replay } from './log.ts';
import { logRef, openSite, readLog, sync } from './store.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import { git } from './test-repo.ts';
import { bareRemote, planted } from './test-site.ts';
import { cli, cliWith, now } from './test-weeds.ts';

function addWeed(dir: string, where: string, weedClass = 'any-type'): void {
  const added = cli(dir, ['add', '--class', weedClass, '--where', where, '--source', 'census:x']);
  assert.equal(added.code, 0, added.stderr);
}

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
    [claimed.code, claimed.stdout, claimsIn(remote)],
    [0, 'claimed any-type until 2026-11-07T18:00:00.000Z\n', [['any-type', '2026-11-07T18:00:00.000Z']]],
  );
});

test('claim with nothing ready prints nothing ready to tend, exits 1 and pushes no claim', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim'], process.env, now);

  assert.deepEqual([claimed.code, claimed.stdout, claimsIn(remote)], [1, 'nothing ready to tend\n', []]);
});

test('claim --class of a class with nothing open prints nothing open for it and exits 1', (t) => {
  const { dir, garden } = planted(t);

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual([claimed.code, claimed.stdout, claimsIn(garden)], [1, 'nothing open for any-type\n', []]);
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

  assert.equal(claimed.code, 1);
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function hook(remote: string, name: string, body: string): void {
  writeFileSync(join(remote, 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('claim --class whose origin declines the push says it cannot claim, read-only, with the reason, and releases', (t) => {
  const { dir, garden } = planted(t);
  hook(bareRemote(dir), 'pre-receive', 'echo "refs/garden is closed here"\nexit 1');
  addWeed(dir, 'src/a.ts:1');

  const claimed = cli(dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [claimed.code, claimed.stdout, releasedClaims(garden)],
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
  hook(remote, 'post-receive', 'if [ -f slow ]; then\n  rm slow\n  sleep 4\n  touch slept\nfi');
  writeFileSync(join(remote, 'slow'), '');

  const claimed = cliWith(dir, ['claim', '--class', 'any-type'], { timeoutMs: 1500 });
  waitFor(join(remote, 'slept'));

  assert.deepEqual(
    [claimed.code, claimed.stdout, releasedClaims(remote)],
    [1, 'cannot claim any-type: offline (timed out)\n', [['any-type', true]]],
  );
});

test("a holder that claims again renews: claimed with the later until, and the origin's owner is still the holder", (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cli(dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const later = new Date(now.getTime() + 60 * 60 * 1000);

  const renewed = cli(dir, ['claim', '--class', 'any-type'], process.env, later);
  const owner = replay(readLog({ path: remote }).events, later).claims.get('any-type');

  assert.deepEqual(
    [renewed.code, renewed.stdout, owner?.writer, owner?.until],
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
    [claimed.code, claimed.stdout, claimsIn(garden)],
    [1, 'taken any-type by Bea until 2026-11-07T15:00:00.000Z\n', [['any-type', '2026-11-07T15:00:00.000Z']]],
  );
});

function readyRows(dir: string): readonly unknown[] {
  const listed = cli(dir, ['groups', '--ready'], process.env, now);
  assert.equal(listed.code, 0, listed.stderr);

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
    [released.code, released.stdout, git(remote, ['for-each-ref', 'refs/garden'])],
    [1, 'no claim of any-type held here\n', ''],
  );
});

test('claim and release with a class that is not a kebab-case class id are usage errors', (t) => {
  const { dir } = planted(t);

  const results = [
    cli(dir, ['claim', '--class', 'Any Type'], process.env, now),
    cli(dir, ['release', '--class', 'Any Type'], process.env, now),
    cli(dir, ['release'], process.env, now),
  ];

  assert.deepEqual(
    results.map(({ code, stderr }) => [code, stderr]),
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
    [claimed.code, claimed.stdout, claimsIn(garden)],
    [0, 'claimed any-type until 2026-11-07T18:00:00.000Z\n', [['any-type', '2026-11-07T18:00:00.000Z']]],
  );
});
