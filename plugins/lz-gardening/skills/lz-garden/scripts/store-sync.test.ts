import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { eventPath, isRecord } from './log.ts';
import { inRun, mayPointAtARepository } from './store-git.ts';
import { readStrategies, readStrategyVariable } from './store-git-objects.ts';
import { logRef, openSite } from './store-log.ts';
import { censusRef, writePendingCensus } from './store-census.ts';
import { isShared, lostRaceOf, mergeShared, sleep, sync } from './store-sync.ts';
import { writeEntriesToLogByHand, writeToLogByHand } from './test-log.ts';
import { commit, git, repo, scriptProcess, startedCommands, startedGits } from './test-repo.ts';
import { serve, silentServer } from './test-serve.ts';
import {
  anotherSyncMovesTheCensusFirst,
  bareRemote,
  censusText,
  planted,
  remoteHook,
  sharedPair,
  site,
  siteScript,
  writeCensus,
} from './test-site.ts';
import type { Planted } from './test-site.ts';
import { addWeed, anyTypeBedFromMain, cli } from './test-weeds.ts';

test('a site whose checkout has no origin stays local and keeps its log as it was', (t) => {
  const { dir, garden } = planted(t);
  const tip = git(garden, ['rev-parse', logRef]);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, git(garden, ['rev-parse', logRef])], ['local', tip]);
});

test("a site whose checkout has an origin pushes its log to the origin's refs/garden/log", (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, git(remote, ['rev-parse', logRef])], ['synced', git(garden, ['rev-parse', logRef])]);
});

test('a checkout that sets lzGardening.share to false keeps the garden local and pushes nothing', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  git(dir, ['config', 'lzGardening.share', 'false']);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, git(remote, ['for-each-ref', 'refs/garden'])], ['local', '']);
});

test('a new site whose origin holds a shared log takes that log as its own', (t) => {
  const first = planted(t);
  const remote = bareRemote(first.dir);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  const second = planted(t);
  git(second.dir, ['remote', 'add', 'origin', remote]);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, git(second.garden, ['rev-parse', logRef])],
    ['synced', git(remote, ['rev-parse', logRef])],
  );
});

test('a site that takes the shared log as its own counts no event as pushed', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });

  assert.equal(sync(openSite(second.dir), { attempts: 1 }).pushedEvents, 0);
});

test('the first sync to an origin with no shared log counts every event it pushed', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  addWeed(dir, 'src/b.ts:1');

  assert.equal(sync(openSite(dir), { attempts: 1 }).pushedEvents, 2);
});

test('a sync whose origin already holds the local log counts no event as pushed', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });

  assert.equal(sync(openSite(dir), { attempts: 1 }).pushedEvents, 0);
});

test('a garden in a repository of SHA-256 objects counts the events its first sync pushed', (t) => {
  const dir = repo(t);
  git(dir, ['init', '-q', '--object-format=sha256', '-b', 'main', join(dirname(dir), 'sha256')]);
  const checkout = join(dirname(dir), 'sha256');
  git(checkout, ['config', 'user.name', 'test']);
  git(checkout, ['config', 'user.email', 'test@example.com']);
  commit(checkout, { 'src/a.ts': 'export const a = 1;\n' });
  const opened = site(checkout, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);
  git(dirname(dir), ['init', '-q', '--bare', '--object-format=sha256', 'remote.git']);
  git(checkout, ['remote', 'add', 'origin', join(dirname(dir), 'remote.git')]);
  addWeed(checkout, 'src/a.ts:1');

  assert.equal(sync(openSite(checkout), { attempts: 1 }).pushedEvents, 1);
});

test('a site whose log already holds the shared log pushes its own log as it is, without a merge', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  addWeed(dir, 'src/b.ts:1');
  const tip = git(garden, ['rev-parse', logRef]);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, git(garden, ['rev-parse', logRef]), git(remote, ['rev-parse', logRef])],
    ['synced', tip, tip],
  );
});

test('a sync that merges a shared log holding a weed the site lacks counts only its own weed as pushed, and lists no conflict', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  addWeed(second.dir, 'src/b.ts:1');

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.pushedEvents, result.conflicts], ['synced', 1, []]);
});

test("a site takes a shared log whose garden.json holds this version's format in other bytes", (t) => {
  const { first, second, remote } = sharedPair(t);
  writeToLogByHand(first.garden, 'garden.json', '{ "format": 1 }');
  git(first.garden, ['push', '-q', remote, `${logRef}:${logRef}`]);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.skipped, git(second.garden, ['rev-parse', logRef])],
    ['synced', [], git(remote, ['rev-parse', logRef])],
  );
});

test('a file the shared log and the local log hold with different content keeps the shared content and is listed as a conflict', (t) => {
  const { first, second } = sharedPair(t);
  const path = eventPath('0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6');
  writeToLogByHand(first.garden, path, '{"from":"first"}');
  writeToLogByHand(second.garden, path, '{"from":"second"}');
  sync(openSite(first.dir), { attempts: 1 });

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.conflicts, git(second.garden, ['show', `${logRef}:${path}`])], [[path], '{"from":"first"}']);
});

test('a file in the shared log that is not an event file is named and not copied', (t) => {
  const { first, second } = sharedPair(t);
  const stray = 'events/0f/not-an-event.json';
  writeToLogByHand(first.garden, stray, '{}');
  sync(openSite(first.dir), { attempts: 1 });

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.skipped, git(second.garden, ['ls-tree', '-r', '--name-only', logRef])],
    [[stray], 'garden.json'],
  );
});

test('an origin that cannot be reached leaves the site offline, with what git said', (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);
  const tip = git(garden, ['rev-parse', logRef]);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.equal(result.state, 'offline');
  assert.match(result.reason, /^fatal: '.*missing\.git' does not appear to be a git repository$/);
  assert.equal(git(garden, ['rev-parse', logRef]), tip);
});

test('a sync that left the site offline has not shared what the site holds', (t) => {
  const { dir } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, isShared(result)], ['offline', false]);
});

test('a site whose garden log is gone is refused by a sync, naming the site and the fix', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  git(garden, ['update-ref', '-d', logRef]);

  assert.throws(() => sync(openSite(dir), { attempts: 1 }), {
    message: /^no garden log at .*repo\.garden; run site\.ts open first$/,
  });
});

test('an origin whose hook declines the push leaves the site read-only, with what the hook said', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  remoteHook(remote, 'pre-receive', 'echo "refs/garden is closed here"\nexit 1');
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, result.reason], ['read-only', 'remote: refs/garden is closed here']);
});

test('a sync whose push the origin declines names no bed as left out', (t) => {
  const { dir } = planted(t);
  remoteHook(bareRemote(dir), 'pre-receive', 'exit 1');
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds], ['read-only', []]);
});

test('a site set to sign every push still shares its log, unsigned', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  git(garden, ['config', 'push.gpgSign', 'true']);
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.reason, git(remote, ['for-each-ref', '--format=%(objectname)', logRef])],
    ['synced', undefined, git(garden, ['rev-parse', logRef])],
  );
});

test('an origin with a push URL of its own is fetched from its URL and pushed to its push URL', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  const pushRemote = join(dirname(second.dir), 'push.git');
  git(dirname(second.dir), ['init', '-q', '--bare', pushRemote]);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', pushRemote]);
  addWeed(second.dir, 'src/b.ts:1');

  sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [wheres(second.dir), git(pushRemote, ['rev-parse', logRef]), git(remote, ['rev-parse', logRef])],
    [['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef]), git(first.garden, ['rev-parse', logRef])],
  );
});

test('an origin with two push URLs is pushed to at the first, as git remote get-url --push gives it', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  git(second.dir, ['remote', 'set-url', '--push', 'origin', remote]);
  git(second.dir, ['remote', 'set-url', '--push', '--add', 'origin', join(dirname(second.dir), 'missing.git')]);
  addWeed(second.dir, 'src/b.ts:1');

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, git(remote, ['rev-parse', logRef])],
    ['synced', git(second.garden, ['rev-parse', logRef])],
  );
});

test('an origin URL that a url.<base>.insteadOf rewrites is fetched from and pushed to at the rewritten URL', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  git(second.dir, ['config', `url.${remote}.insteadOf`, 'garden-alias:origin']);
  git(second.dir, ['remote', 'set-url', 'origin', 'garden-alias:origin']);
  addWeed(second.dir, 'src/b.ts:1');

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, wheres(second.dir), git(remote, ['rev-parse', logRef])],
    ['synced', ['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef])],
  );
});

test('an origin URL that a url.<base>.pushInsteadOf rewrites is fetched from as it is and pushed to rewritten', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  const pushRemote = join(dirname(second.dir), 'push.git');
  git(dirname(second.dir), ['init', '-q', '--bare', pushRemote]);
  git(second.dir, ['config', `url.${pushRemote}.pushInsteadOf`, remote]);
  addWeed(second.dir, 'src/b.ts:1');

  sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [wheres(second.dir), git(pushRemote, ['rev-parse', logRef]), git(remote, ['rev-parse', logRef])],
    [['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef]), git(first.garden, ['rev-parse', logRef])],
  );
});

test('an origin with a partial clone filter is synced at its URL, which git lists with the filter beside it', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  git(second.dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  addWeed(second.dir, 'src/b.ts:1');

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, wheres(second.dir), git(remote, ['rev-parse', logRef])],
    ['synced', ['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef])],
  );
});

test('an origin whose URL holds a password stays local when the checkout sets transfer.credentialsInUrl to die', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['remote', 'set-url', 'origin', 'https://user:password@127.0.0.1:1/r.git']);
  git(dir, ['config', 'transfer.credentialsInUrl', 'die']);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.equal(result.state, 'local');
});

test('an origin whose URL holds no password syncs when the checkout sets transfer.credentialsInUrl to die', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['config', 'transfer.credentialsInUrl', 'die']);
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.equal(result.state, 'synced');
});

test('a checkout with no origin stays local when another remote URL holds lines that read as origin', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  git(dir, ['remote', 'remove', 'origin']);
  git(dir, ['config', 'remote.aaa.url', `x\norigin\t${remote} (fetch)\norigin\t${remote}`]);

  const result = sync(openSite(dir), { attempts: 1 });

  assert.equal(result.state, 'local');
});

test('a checkout with another remote that git lists before origin syncs with origin', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  git(second.dir, ['remote', 'add', 'a-mirror', join(dirname(second.dir), 'missing.git')]);
  addWeed(second.dir, 'src/b.ts:1');

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, wheres(second.dir), git(remote, ['rev-parse', logRef])],
    ['synced', ['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef])],
  );
});

for (const [value, state] of [
  ['no', 'local'],
  ['off', 'local'],
  ['0', 'local'],
  ['', 'local'],
  ['yes', 'synced'],
  ['on', 'synced'],
  ['1', 'synced'],
  ['TRUE', 'synced'],
] as const) {
  test(`a checkout whose lzGardening.share is '${value}' reads as ${state}`, (t) => {
    const { dir } = planted(t);
    bareRemote(dir);
    git(dir, ['config', 'lzGardening.share', value]);

    const result = sync(openSite(dir), { attempts: 1 });

    assert.equal(result.state, state);
  });
}

test('a checkout that names lzGardening.share with no value shares the garden', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  appendFileSync(join(dir, '.git', 'config'), '[lzGardening]\n\tshare\n');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.equal(result.state, 'synced');
});

test("a checkout whose lzGardening.share is not a boolean fails the sync with git's reason", (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['config', 'lzGardening.share', 'maybe']);

  assert.throws(
    () => sync(openSite(dir), { attempts: 1 }),
    /bad boolean config value 'maybe' for 'lzgardening\.share'/,
  );
});

test('a push the origin rejects as not a fast-forward waits, fetches again, and lands on the next attempt', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  const staleMirror = join(dirname(second.dir), 'mirror.git');
  git(dirname(second.dir), ['init', '-q', '--bare', staleMirror]);
  git(second.dir, ['remote', 'set-url', 'origin', staleMirror]);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', remote]);
  addWeed(second.dir, 'src/b.ts:1');
  const waits: number[] = [];

  const result = sync(openSite(second.dir), {
    attempts: 2,
    wait: (ms) => {
      waits.push(ms);
      git(remote, ['push', '-q', staleMirror, `${logRef}:${logRef}`]);
    },
  });

  assert.deepEqual(
    [result.state, waits.length, wheres(second.dir), git(remote, ['rev-parse', logRef])],
    ['synced', 1, ['src/a.ts:1', 'src/b.ts:1'], git(second.garden, ['rev-parse', logRef])],
  );
});

// The quarantine variable is unset so git lets the hook move a ref.
function moveWhileMarked(remote: string, marker: string, once: boolean): void {
  remoteHook(
    remote,
    'pre-receive',
    [
      'unset GIT_QUARANTINE_PATH',
      `if [ -f ${marker} ]; then`,
      ...(once ? [`  rm ${marker}`] : []),
      '  t=$(git rev-parse refs/garden/log)',
      '  export GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@example.com GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@example.com',
      '  git update-ref refs/garden/log "$(git commit-tree "$t^{tree}" -p "$t" -m moved)"',
      'fi',
    ].join('\n'),
  );
  writeFileSync(join(remote, marker), '');
}

test('a push the origin refuses because another push moved the log first is tried again, and lands', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  moveWhileMarked(remote, 'moving', true);
  addWeed(dir, 'src/b.ts:1');

  const result = sync(openSite(dir), { attempts: 2, wait: () => undefined });

  assert.deepEqual([result.state, git(remote, ['rev-parse', logRef])], ['synced', git(garden, ['rev-parse', logRef])]);
});

test("a push lost to another push ends behind with the lost ref and origin's summary for it as the reason", (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  moveWhileMarked(remote, 'moving', true);
  addWeed(dir, 'src/b.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.match(result.reason ?? '', /^refs\/garden\/log: \[remote rejected\] \(.+\)$/);
});

function conflictedSiteFacingARace(t: TestContext): {
  readonly second: Planted;
  readonly remote: string;
  readonly path: string;
  readonly stray: string;
} {
  const { first, second, remote } = sharedPair(t);
  const path = eventPath('0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6');
  const stray = 'events/0f/not-an-event.json';
  writeToLogByHand(first.garden, path, '{"from":"first"}');
  writeToLogByHand(first.garden, stray, '{}');
  writeToLogByHand(second.garden, path, '{"from":"second"}');
  writeCensus(first.garden, git(first.dir, ['rev-parse', 'main']));
  sync(openSite(first.dir), { attempts: 1 });
  addWeed(second.dir, 'src/b.ts:1');
  moveWhileMarked(remote, 'moving', true);

  return { second, remote, path, stray };
}

test('a try that ends behind still reports the file it skipped', (t) => {
  const { second, stray } = conflictedSiteFacingARace(t);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.skipped], ['behind', [stray]]);
});

test('a file skipped on a try that ended behind is reported when the next try cannot reach origin', (t) => {
  const { second, remote, stray } = conflictedSiteFacingARace(t);

  const result = sync(openSite(second.dir), {
    attempts: 2,
    wait: () => {
      renameSync(remote, `${remote}.away`);
    },
  });

  assert.deepEqual([result.state, result.skipped], ['offline', [stray]]);
});

test('a file skipped on a try that ended behind and again on the try that lands is reported once', (t) => {
  const { second, stray } = conflictedSiteFacingARace(t);

  const result = sync(openSite(second.dir), { attempts: 2, wait: () => undefined });

  assert.deepEqual([result.state, result.skipped], ['synced', [stray]]);
});

test('a try whose push takes longer than the time allowed still reports what its merge found', async (t) => {
  const { second, path, stray } = conflictedSiteFacingARace(t);
  const port = await serve(t, silentServer);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', `git://127.0.0.1:${port}/repo.git`]);

  const pushAllowedMs = 5000;

  const result = sync(openSite(second.dir), { attempts: 1, timeoutMs: pushAllowedMs });

  assert.deepEqual(
    [result.state, result.reason, result.conflicts, result.skipped],
    ['offline', 'timed out', [path], [stray]],
  );
});

test('a try whose census another sync of the site moved first still reports what its merge found', (t) => {
  const { second, path, stray } = conflictedSiteFacingARace(t);
  anotherSyncMovesTheCensusFirst(t, second.garden, git(second.garden, ['rev-parse', `${logRef}^{commit}`]));

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.conflicts, result.skipped], ['behind', [path], [stray]]);
});

test('a try whose push fails before it reaches origin still reports what its merge found', (t) => {
  const { second, path, stray } = conflictedSiteFacingARace(t);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:9/repo.git']);

  const result = sync(openSite(second.dir), { attempts: 1, timeoutMs: 10_000 });

  assert.deepEqual([result.state, result.conflicts, result.skipped], ['offline', [path], [stray]]);
});

test('a try that ends behind still reports the conflict its merge found', (t) => {
  const { second, path } = conflictedSiteFacingARace(t);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.conflicts], ['behind', [path]]);
});

test('a conflict found on a try that ended behind is reported by the try that lands', (t) => {
  const { second, path } = conflictedSiteFacingARace(t);

  const result = sync(openSite(second.dir), { attempts: 2, wait: () => undefined });

  assert.deepEqual([result.state, result.conflicts], ['synced', [path]]);
});

test('a site whose origin keeps moving is behind after its attempts, and one sync after the race holds every event', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  moveWhileMarked(remote, 'moving', false);
  addWeed(first.dir, 'src/b.ts:1');
  const raced: string[] = [];

  const result = sync(openSite(first.dir), {
    attempts: 3,
    wait: () => {
      const where = `src/raced-${String(raced.length)}.ts:1`;
      raced.push(where);
      rmSync(join(remote, 'moving'));
      addWeed(second.dir, where);
      assert.equal(sync(openSite(second.dir), { attempts: 1 }).state, 'synced');
      writeFileSync(join(remote, 'moving'), '');
    },
  });
  rmSync(join(remote, 'moving'));
  const after = sync(openSite(first.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, raced.length, after.state, wheres(first.dir), git(remote, ['rev-parse', logRef])],
    ['behind', 2, 'synced', ['src/a.ts:1', 'src/b.ts:1', ...raced], git(first.garden, ['rev-parse', logRef])],
  );
});

test('a merge whose log another writer moves under each of its tries gives up after that many and says the log kept moving', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  addWeed(second.dir, 'src/b.ts:1');
  git(second.garden, ['fetch', '-q', remote, '+refs/garden/*:refs/garden-shared/*']);
  const { spawnSync } = childProcess;
  let imports = 0;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;

    if (Array.isArray(gitArgs) && gitArgs.includes('fast-import')) {
      imports += 1;
      const tip = git(second.garden, ['rev-parse', logRef]);
      git(second.garden, [
        'update-ref',
        logRef,
        git(second.garden, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'moved']),
      ]);
    }

    return Reflect.apply(spawnSync, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  assert.throws(() => mergeShared(openSite(second.dir), 3), {
    message: 'refs/garden/log kept moving; 3 tries to merge the shared log failed',
  });
  assert.equal(imports, 3);
});

test("a move of the log to origin's that fails while the log has not moved stops the sync with what git said", (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  mkdirSync(join(second.garden, '.git', 'refs', 'garden'), { recursive: true });
  writeFileSync(join(second.garden, '.git', 'refs', 'garden', 'log.lock'), '');

  assert.throws(() => sync(openSite(second.dir), { attempts: 1 }), {
    message: /^git update-ref refs\/garden\/log \S+ \S+: .*cannot lock ref 'refs\/garden\/log'/s,
  });
});

function waitsOfThreeLostTries(t: TestContext, random: number): readonly number[] {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  moveWhileMarked(remote, 'moving', false);
  addWeed(dir, 'src/b.ts:1');
  const waits: number[] = [];
  t.mock.method(Math, 'random', () => random);

  sync(openSite(dir), { attempts: 3, wait: (ms) => waits.push(ms) });

  return waits;
}

test('a sync waits half a second before its second try and one before its third at the least jitter', (t) => {
  assert.deepEqual(waitsOfThreeLostTries(t, 0), [500, 1000]);
});

test('a sync waits under one and a half seconds before its second try and under three before its third at the most jitter', (t) => {
  const waits = waitsOfThreeLostTries(t, 0.999);

  assert.deepEqual(
    waits.map((ms, index) => ms > 1400 * 2 ** index && ms < 1500 * 2 ** index),
    [true, true],
    String(waits),
  );
});

test('a sleep holds the thread for the time given', () => {
  const started = performance.now();

  sleep(100);

  const held = performance.now() - started;
  assert.ok(held >= 90, `held for ${String(held)} ms`);
});

test('a fetch that finds the shared log locked by another sync of the site waits, tries again, and lands', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  const lock = join(second.garden, '.git', 'refs', 'garden-shared', 'log.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '');

  const result = sync(openSite(second.dir), {
    attempts: 2,
    wait: () => {
      rmSync(lock);
    },
  });

  assert.deepEqual([result.state, wheres(second.dir)], ['synced', ['src/a.ts:1']]);
});

test('a push the origin declines counts no event as pushed', (t) => {
  const { dir } = planted(t);
  remoteHook(bareRemote(dir), 'pre-receive', 'exit 1');
  addWeed(dir, 'src/a.ts:1');

  assert.equal(sync(openSite(dir), { attempts: 1 }).pushedEvents, 0);
});

test('an origin that takes the connection and never answers leaves the site offline once the time is up', async (t) => {
  const { dir } = planted(t);
  const port = await serve(t, silentServer);
  git(dir, ['remote', 'add', 'origin', `git://127.0.0.1:${port}/repo.git`]);
  const started = Date.now();

  const result = sync(openSite(dir), { attempts: 1, timeoutMs: 1000 });

  assert.deepEqual([result.state, result.reason, Date.now() - started < 10_000], ['offline', 'timed out', true]);
});

test('a push URL that takes the connection and never answers leaves the site offline once the time is up', async (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  const port = await serve(t, silentServer);
  git(dir, ['remote', 'set-url', '--push', 'origin', `git://127.0.0.1:${port}/repo.git`]);
  addWeed(dir, 'src/a.ts:1');
  const started = Date.now();

  const result = sync(openSite(dir), { attempts: 1, timeoutMs: 1000 });

  assert.deepEqual([result.state, result.reason, Date.now() - started < 10_000], ['offline', 'timed out', true]);
});

test('a push URL nobody listens on leaves the site offline with what git said, not read-only', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:9/repo.git']);
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1, timeoutMs: 10_000 });

  assert.deepEqual(
    [result.state, result.reason?.startsWith("fatal: unable to access 'http://127.0.0.1:9/repo.git/': ")],
    ['offline', true],
  );
});

test('a push that fails though the origin took every ref leaves the site offline with what git said, not read-only', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  const { spawnSync } = childProcess;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;
    const result: unknown = Reflect.apply(spawnSync, childProcess, args);

    return Array.isArray(gitArgs) && gitArgs.includes('push') && isRecord(result)
      ? { ...result, status: 1, stderr: 'fatal: the remote end hung up unexpectedly\n' }
      : result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, result.reason], ['offline', 'fatal: the remote end hung up unexpectedly']);
});

test('an origin that asks for credentials leaves the site offline with what git said, without waiting for input', async (t) => {
  const { dir } = planted(t);
  const port = await serve(
    t,
    'require("node:http").createServer((q, s) => { s.writeHead(401, { "WWW-Authenticate": "Basic realm=garden" }); s.end(); }).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port)); });',
  );
  git(dir, ['remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`]);

  const result = sync(openSite(dir), { attempts: 1, timeoutMs: 10_000 });

  assert.deepEqual([result.state, result.reason], ['offline', 'fatal: unable to get password from user']);
});

test('a shared log in another format stops the sync with an error naming both formats, and changes nothing', (t) => {
  const { first, second, remote } = sharedPair(t);
  writeToLogByHand(first.garden, 'garden.json', '{"format":2}');
  git(first.garden, ['push', '-q', remote, `${logRef}:${logRef}`]);
  addWeed(second.dir, 'src/a.ts:1');
  const tip = git(second.garden, ['rev-parse', logRef]);

  assert.throws(() => sync(openSite(second.dir), { attempts: 1 }), {
    message: 'the shared refs/garden/log is in format 2 and this version reads format 1; update lz-gardening',
  });
  assert.equal(git(second.garden, ['rev-parse', logRef]), tip);
});

const notAGardenLog =
  'the shared refs/garden/log on origin is not a garden log (a commit holding garden.json); delete or fix it on origin';

test('a shared log that names no commit stops the sync with an error saying it is not a garden log', (t) => {
  const { first, second, remote } = sharedPair(t);
  git(first.garden, ['push', '-q', remote, `${logRef}^{tree}:${logRef}`]);
  addWeed(second.dir, 'src/a.ts:1');

  assert.throws(() => sync(openSite(second.dir), { attempts: 1 }), { message: notAGardenLog });
});

test('a shared log whose commit holds no garden.json stops the sync with an error saying it is not a garden log', (t) => {
  const { first, second, remote } = sharedPair(t);
  writeEntriesToLogByHand(first.garden, [`0 ${'0'.repeat(40)}\tgarden.json`]);
  git(first.garden, ['push', '-q', remote, `${logRef}:${logRef}`]);
  addWeed(second.dir, 'src/a.ts:1');

  assert.throws(() => sync(openSite(second.dir), { attempts: 1 }), { message: notAGardenLog });
});

// Two sites with a weed each to share; the second also holds a tended close with its bed and a pending census.
function withALogACensusAndABedToShare(t: TestContext): {
  readonly first: Planted;
  readonly second: Planted;
  readonly base: string;
} {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  addWeed(second.dir, 'src/b.ts:1');
  const tip = commit(anyTypeBedFromMain(second.garden), { 'checks/any-type.mjs': 'export {};\n' });
  git(second.dir, ['config', 'lzGardening.share', 'false']);
  assert.equal(cli(second.dir, ['claim', '--class', 'any-type']).status, 0);
  const closed = cli(second.dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip}`,
    '--check',
    'checks/any-type.mjs',
  ]);
  assert.equal(closed.status, 0, closed.stderr);
  git(second.dir, ['config', 'lzGardening.share', 'true']);
  const base = git(second.dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: second.garden, checkout: second.dir }, base, censusText(base));

  return { first, second, base };
}

test('a sync turns the hooks and signing off for the gits that write, and for none of those that only read', (t) => {
  const { first, second, base } = withALogACensusAndABedToShare(t);
  writeToLogByHand(first.garden, 'garden.json', '{ "format": 1 }');
  sync(openSite(first.dir), { attempts: 1 });
  // With the key set, the sync also asks git remote get-url.
  git(second.dir, ['config', 'transfer.credentialsInUrl', 'die']);
  const started = startedGits(t);

  sync(openSite(second.dir), { attempts: 1, census: base });

  const turnsHooksOff = (args: readonly string[]): boolean => args.some((arg) => arg.startsWith('core.hooksPath='));
  const commands = (which: (args: readonly string[]) => boolean): readonly (string | undefined)[] =>
    [
      ...new Set(
        started()
          .map(({ args }) => args)
          .filter(which)
          .map((args) => args.find((arg) => /^[a-z][a-z-]*$/.test(arg))),
      ),
    ].sort();
  assert.deepEqual(
    [commands(turnsHooksOff), commands((args) => !turnsHooksOff(args))],
    [
      ['fast-import', 'fetch', 'push', 'update-ref'],
      ['cat-file', 'config', 'diff-tree', 'for-each-ref', 'log', 'ls-tree', 'merge-base', 'remote', 'rev-parse'],
    ],
  );
});

test('every push a sync starts names only the garden log, the census or a bed, and never a bed with the log', (t) => {
  const { first, second, base } = withALogACensusAndABedToShare(t);
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  sync(openSite(first.dir), { attempts: 1 });
  sync(openSite(second.dir), { attempts: 1, census: base });
  sync(openSite(first.dir), { attempts: 1 });
  const pushes = spawned.mock.calls
    .map(({ arguments: [, args] }) => (Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : []))
    .filter((args) => args.includes('push'));

  assert.deepEqual(
    pushes.map((args) => args.slice(args.indexOf('--end-of-options') + 2).map((refspec) => refspec.split(':')[1])),
    [[logRef], [logRef, censusRef], ['refs/garden/beds/any-type']],
  );
});

for (const strategy of readStrategies) {
  test(`a sync whose origin already holds the local log fetches, lists the beds and stops, with no merge and no push, reading through ${strategy}`, (t) => {
    const { dir } = planted(t);
    bareRemote(dir);
    sync(openSite(dir), { attempts: 1 });
    const started = startedCommands(t);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));

    const result = inRun({ ...env, [readStrategyVariable]: strategy }, () => sync(openSite(dir), { attempts: 1 }));

    assert.deepEqual(
      [result.state, started],
      ['synced', ['rev-parse', 'config', 'remote', 'config', 'fetch', 'cat-file', 'for-each-ref']],
    );
  });
}

test('a sync of a checkout with no origin lists its remotes and stops, with no further config read', (t) => {
  const { dir } = planted(t);
  const started = startedCommands(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));

  const result = inRun({ ...env, [readStrategyVariable]: 'spawn' }, () => sync(openSite(dir), { attempts: 1 }));

  assert.deepEqual([result.state, started], ['local', ['rev-parse', 'config', 'remote']]);
});

test('a sync that pushes a weed and gives back no claim fetches, compares the logs, reads the weed, lists the beds and pushes, and never reads the whole log', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  sync(openSite(dir), { attempts: 1 });
  addWeed(dir, 'src/a.ts:1');
  const started = startedCommands(t);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));

  const result = inRun({ ...env, [readStrategyVariable]: 'spawn' }, () => sync(openSite(dir), { attempts: 1 }));

  assert.deepEqual(
    [result.state, started],
    [
      'synced',
      [
        'rev-parse',
        'config',
        'remote',
        'config',
        'fetch',
        'cat-file',
        'diff-tree',
        'merge-base',
        'cat-file',
        'for-each-ref',
        'push',
      ],
    ],
  );
});

function fetchArgs(t: TestContext, dir: string, env: NodeJS.ProcessEnv): readonly string[] {
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  inRun(env, () => sync(openSite(dir), { attempts: 1 }));

  const fetch = spawned.mock.calls
    .map(({ arguments: [, args] }) => (Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : []))
    .find((args) => args.includes('fetch'));
  assert.ok(fetch !== undefined, 'the sync ran a fetch');

  return fetch;
}

const sshInBatchMode = 'core.sshCommand=ssh -o BatchMode=yes';

test('a fetch with no ssh command of the user runs ssh in batch mode, so ssh asks for no passphrase or host key', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);

  assert.ok(fetchArgs(t, dir, process.env).includes(sshInBatchMode));
});

test('a fetch for a user who set core.sshCommand runs their ssh command as it is', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  git(garden, ['config', 'core.sshCommand', 'ssh -i ~/.ssh/garden']);

  assert.ok(!fetchArgs(t, dir, process.env).includes(sshInBatchMode));
});

test("a fetch for a user who set core.sshCommand in the checkout's own config runs that ssh command", (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['config', 'core.sshCommand', 'ssh -i ~/.ssh/garden']);

  assert.ok(fetchArgs(t, dir, process.env).includes('core.sshCommand=ssh -i ~/.ssh/garden'));
});

test("a fetch for a user who set core.sshCommand globally and in the checkout runs the checkout's", (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['config', 'core.sshCommand', 'ssh -i ~/.ssh/garden']);
  const global = join(dir, '..', 'global.gitconfig');
  writeFileSync(global, '[maintenance]\n\tauto = false\n[core]\n\tsshCommand = ssh -i ~/.ssh/personal\n');

  assert.ok(
    fetchArgs(t, dir, { ...process.env, GIT_CONFIG_GLOBAL: global }).includes('core.sshCommand=ssh -i ~/.ssh/garden'),
  );
});

test('a fetch for a user who set GIT_SSH_COMMAND runs their ssh command as it is', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);

  assert.ok(!fetchArgs(t, dir, { ...process.env, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/garden' }).includes(sshInBatchMode));
});

// core.sshCommand outranks GIT_SSH, so setting it would drop the user's program.
test('a fetch for a user who set GIT_SSH runs their ssh program as it is', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);

  assert.ok(!fetchArgs(t, dir, { ...process.env, GIT_SSH: 'plink' }).includes(sshInBatchMode));
});

test("a fetch for a user who set GIT_SSH and core.sshCommand in the checkout runs the checkout's, as git does", (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  git(dir, ['config', 'core.sshCommand', 'ssh -i ~/.ssh/garden']);

  assert.ok(fetchArgs(t, dir, { ...process.env, GIT_SSH: 'plink' }).includes('core.sshCommand=ssh -i ~/.ssh/garden'));
});

function syncProcess(
  dir: string,
  args: readonly string[] = [],
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return scriptProcess(siteScript, dir, ['sync', ...args]);
}

test('two syncs of one site at once both end synced or behind, and no event is lost', async (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  addWeed(second.dir, 'src/b.ts:1');
  addWeed(second.dir, 'src/c.ts:1');

  const runs = await Promise.all([syncProcess(second.dir), syncProcess(second.dir)]);
  sync(openSite(second.dir), { attempts: 1 });
  sync(openSite(first.dir), { attempts: 1 });

  assert.deepEqual(
    [
      runs.map(({ status, stdout }) => [
        status,
        ['synced', 'behind'].some((state) => stdout.includes(`"shared":"${state}"`)),
      ]),
      wheres(first.dir),
      git(remote, ['rev-parse', logRef]),
    ],
    [
      [
        [0, true],
        [0, true],
      ],
      ['src/a.ts:1', 'src/b.ts:1', 'src/c.ts:1'],
      git(first.garden, ['rev-parse', logRef]),
    ],
  );
});

test('syncs of one site at once that each move its log to the shared log all exit 0', async (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });

  const runs = await Promise.all(Array.from({ length: 4 }, () => syncProcess(second.dir)));

  assert.deepEqual(
    runs.map(({ status }) => status),
    [0, 0, 0, 0],
  );
});

test('syncs of one site at once that each adopt the shared census all exit 0', async (t) => {
  const { first, second } = sharedPair(t);
  writeCensus(first.garden, git(first.dir, ['rev-parse', 'main']));
  sync(openSite(first.dir), { attempts: 1 });

  const runs = await Promise.all(Array.from({ length: 4 }, () => syncProcess(second.dir)));

  assert.deepEqual(
    [runs.map(({ status }) => status), git(second.garden, ['rev-parse', censusRef])],
    [[0, 0, 0, 0], git(first.garden, ['rev-parse', censusRef])],
  );
});

test('syncs of one site at once that each record the same pending census all exit 0', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));
  const pending = git(garden, ['rev-parse', `refs/garden/pending/${sha}`]);

  const runs = await Promise.all(Array.from({ length: 4 }, () => syncProcess(dir, ['--census', sha])));

  assert.deepEqual(
    [
      runs.map(({ status }) => status),
      git(garden, ['rev-parse', censusRef]),
      git(garden, ['for-each-ref', 'refs/garden/pending']),
    ],
    [[0, 0, 0, 0], pending, ''],
  );
});

test("a sync whose fetch finds a fetched ref's lock left behind ends behind with git's reason", (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  mkdirSync(join(garden, '.git', 'refs', 'garden-shared'), { recursive: true });
  writeFileSync(join(garden, '.git', 'refs', 'garden-shared', 'log.lock'), '');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.reason?.includes("cannot lock ref 'refs/garden-shared/log'")],
    ['behind', true],
  );
});

test('a push origin refused for a reason that only mentions a lock lost no race; one git could not lock a ref for did', () => {
  assert.deepEqual(
    [
      lostRaceOf('!\trefs/garden/log:refs/garden/log\t[remote rejected] (repository is locked for maintenance)'),
      lostRaceOf("!\trefs/garden/log:refs/garden/log\t[remote rejected] (cannot lock ref 'refs/garden/log': x)"),
    ],
    [undefined, "refs/garden/log: [remote rejected] (cannot lock ref 'refs/garden/log': x)"],
  );
});

function wheres(dir: string): readonly string[] {
  return cli(dir, ['list'])
    .stdout.trimEnd()
    .split('\n')
    .map((line) => line.split(' ')[2] ?? '')
    .sort();
}

test('two sites that each added a weed both hold both weeds once each has synced after the other', (t) => {
  const first = planted(t);
  const remote = bareRemote(first.dir);
  const second = planted(t);
  git(second.dir, ['remote', 'add', 'origin', remote]);
  addWeed(first.dir, 'src/a.ts:1');
  addWeed(second.dir, 'src/b.ts:1');

  sync(openSite(first.dir), { attempts: 1 });
  sync(openSite(second.dir), { attempts: 1 });
  sync(openSite(first.dir), { attempts: 1 });

  assert.deepEqual(
    [wheres(first.dir), wheres(second.dir), git(remote, ['rev-parse', logRef])],
    [['src/a.ts:1', 'src/b.ts:1'], ['src/a.ts:1', 'src/b.ts:1'], git(first.garden, ['rev-parse', logRef])],
  );
});
