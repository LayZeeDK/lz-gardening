import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { eventPath } from './log.ts';
import { inRun, mayPointAtARepository } from './store-git.ts';
import { logRef, openSite } from './store-log.ts';
import { censusRef, writePendingCensus } from './store-census.ts';
import { mergeShared, rejected, sync } from './store-sync.ts';
import { writeEntriesToLogByHand, writeToLogByHand } from './test-log.ts';
import { commit, git, repo } from './test-repo.ts';
import { serve, silentServer } from './test-serve.ts';
import { bareRemote, planted, scriptProcess, sharedPair, site, siteScript, writeCensus } from './test-site.ts';
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

test('the first sync to an origin with no shared log counts every event it pushed', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  addWeed(dir, 'src/b.ts:1');

  assert.equal(sync(openSite(dir), { attempts: 1 }).pushedEvents, 2);
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

function preReceive(remote: string, body: string): void {
  writeFileSync(join(remote, 'hooks', 'pre-receive'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

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
  preReceive(remote, 'echo "refs/garden is closed here"\nexit 1');
  addWeed(dir, 'src/a.ts:1');

  const result = sync(openSite(dir), { attempts: 1 });

  assert.deepEqual([result.state, result.reason], ['read-only', 'remote: refs/garden is closed here']);
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
  preReceive(
    remote,
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

// A path both sites hold with different content, a file the shared log holds that is not an event file, a shared
// census, and a second site with an event to push, on an origin whose log the next push moves first.
function conflictBeforeARace(t: TestContext): {
  readonly second: { readonly dir: string; readonly garden: string };
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
  const { second, stray } = conflictBeforeARace(t);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.skipped], ['behind', [stray]]);
});

test('a file skipped on a try that ended behind is reported when the next try cannot reach origin', (t) => {
  const { second, remote, stray } = conflictBeforeARace(t);

  const result = sync(openSite(second.dir), {
    attempts: 2,
    wait: () => {
      renameSync(remote, `${remote}.away`);
    },
  });

  assert.deepEqual([result.state, result.skipped], ['offline', [stray]]);
});

test('a file skipped on a try that ended behind and again on the try that lands is reported once', (t) => {
  const { second, stray } = conflictBeforeARace(t);

  const result = sync(openSite(second.dir), { attempts: 2, wait: () => undefined });

  assert.deepEqual([result.state, result.skipped], ['synced', [stray]]);
});

test('a try whose push takes longer than the time allowed still reports what its merge found', async (t) => {
  const { second, path, stray } = conflictBeforeARace(t);
  const port = await serve(t, silentServer);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', `git://127.0.0.1:${port}/repo.git`]);

  // Time enough for the fetch from the local origin on a loaded machine, so only the push runs out of it.
  const result = sync(openSite(second.dir), { attempts: 1, timeoutMs: 5000 });

  assert.deepEqual(
    [result.state, result.reason, result.conflicts, result.skipped],
    ['offline', 'timed out', [path], [stray]],
  );
});

test('a try whose census another sync of the site moved first still reports what its merge found', (t) => {
  const { second, path, stray } = conflictBeforeARace(t);
  const theirs = git(second.garden, ['rev-parse', `${logRef}^{commit}`]);
  const { spawnSync } = childProcess;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;

    if (Array.isArray(gitArgs) && gitArgs.includes('update-ref') && gitArgs.includes(censusRef)) {
      spawnSync('git', ['update-ref', censusRef, theirs], { cwd: second.garden });
    }

    return Reflect.apply(spawnSync, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.conflicts, result.skipped], ['behind', [path], [stray]]);
});

test('a try whose push fails before it reaches origin still reports what its merge found', (t) => {
  const { second, path, stray } = conflictBeforeARace(t);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', 'http://127.0.0.1:9/repo.git']);

  const result = sync(openSite(second.dir), { attempts: 1, timeoutMs: 10_000 });

  assert.deepEqual([result.state, result.conflicts, result.skipped], ['offline', [path], [stray]]);
});

test('a try that ends behind still reports the conflict its merge found', (t) => {
  const { second, path } = conflictBeforeARace(t);

  const result = sync(openSite(second.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.conflicts], ['behind', [path]]);
});

test('a conflict found on a try that ended behind is reported by the try that lands', (t) => {
  const { second, path } = conflictBeforeARace(t);

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

test('a sync waits about one second before its second try and about two before its third, give or take half', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  sync(openSite(dir), { attempts: 1 });
  moveWhileMarked(remote, 'moving', false);
  addWeed(dir, 'src/b.ts:1');
  const waits: number[] = [];

  sync(openSite(dir), { attempts: 3, wait: (ms) => waits.push(ms) });

  assert.deepEqual(
    waits.map((ms, index) => ms >= 500 * 2 ** index && ms < 1500 * 2 ** index),
    [true, true],
    String(waits),
  );
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
  preReceive(bareRemote(dir), 'exit 1');
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

test('an origin that asks for credentials leaves the site offline with what git said, without waiting for input', async (t) => {
  const { dir } = planted(t);
  const port = await serve(
    t,
    'require("node:http").createServer((q, s) => { s.writeHead(401, { "WWW-Authenticate": "Basic realm=garden" }); s.end(); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });',
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

test('every push a sync starts names only the garden log, the census or a bed, and never a bed with the log', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  addWeed(second.dir, 'src/b.ts:1');
  const tip = commit(anyTypeBedFromMain(second.garden), { 'checks/any-type.mjs': 'export {};\n' });
  git(second.dir, ['config', 'lzGardening.share', 'false']);
  assert.equal(cli(second.dir, ['claim', '--class', 'any-type']).code, 0);
  const closed = cli(second.dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip}`,
    '--check',
    'checks/any-type.mjs',
  ]);
  assert.equal(closed.code, 0, closed.stderr);
  git(second.dir, ['config', 'lzGardening.share', 'true']);
  const base = git(second.dir, ['rev-parse', 'HEAD']);
  writePendingCensus(
    { path: second.garden, checkout: second.dir },
    base,
    `${JSON.stringify({ rev: 'main', sha: base, takenAt: '', counts: {}, hits: {} })}\n`,
  );
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

test('a sync whose origin already holds the local log fetches, lists the beds and stops, with no merge and no push', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  sync(openSite(dir), { attempts: 1 });
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));

  const result = inRun(env, () => sync(openSite(dir), { attempts: 1 }));

  assert.deepEqual(
    [
      result.state,
      spawned.mock.calls.map(({ arguments: [, args] }) =>
        Array.isArray(args)
          ? args.filter((arg: unknown) => typeof arg === 'string').find((arg) => /^[a-z][a-z-]*$/.test(arg))
          : undefined,
      ),
    ],
    ['synced', ['rev-parse', 'config', 'remote', 'config', 'remote', 'fetch', 'cat-file', 'for-each-ref']],
  );
});

// The arguments of the fetch a sync starts, run in env.
function fetchArgs(t: TestContext, dir: string, env: NodeJS.ProcessEnv): readonly string[] {
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  inRun(env, () => sync(openSite(dir), { attempts: 1 }));

  return (
    spawned.mock.calls
      .map(({ arguments: [, args] }) => (Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : []))
      .find((args) => args.includes('fetch')) ?? []
  );
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

function syncProcess(
  dir: string,
  args: readonly string[] = [],
): Promise<{ readonly code: number | null; readonly stdout: string }> {
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
      runs.map(({ code, stdout }) => [
        code,
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
    runs.map(({ code }) => code),
    [0, 0, 0, 0],
  );
});

test('syncs of one site at once that each adopt the shared census all exit 0', async (t) => {
  const { first, second } = sharedPair(t);
  writeCensus(first.garden, git(first.dir, ['rev-parse', 'main']));
  sync(openSite(first.dir), { attempts: 1 });

  const runs = await Promise.all(Array.from({ length: 4 }, () => syncProcess(second.dir)));

  assert.deepEqual(
    [runs.map(({ code }) => code), git(second.garden, ['rev-parse', censusRef])],
    [[0, 0, 0, 0], git(first.garden, ['rev-parse', censusRef])],
  );
});

test('syncs of one site at once that each record the same pending census all exit 0', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus(
    { path: garden, checkout: dir },
    sha,
    JSON.stringify({ rev: 'main', sha, takenAt: '', counts: {}, hits: {} }),
  );
  const pending = git(garden, ['rev-parse', `refs/garden/pending/${sha}`]);

  const runs = await Promise.all(Array.from({ length: 4 }, () => syncProcess(dir, ['--census', sha])));

  assert.deepEqual(
    [
      runs.map(({ code }) => code),
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
      rejected('!\trefs/garden/log:refs/garden/log\t[remote rejected] (repository is locked for maintenance)'),
      rejected("!\trefs/garden/log:refs/garden/log\t[remote rejected] (cannot lock ref 'refs/garden/log': x)"),
    ],
    [false, true],
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
