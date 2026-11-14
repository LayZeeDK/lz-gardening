// Run: node --test store-beds.test.ts
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { logRef, openSite } from './store-log.ts';
import { sleep, sync } from './store-sync.ts';
import { commit, git } from './test-repo.ts';
import { serve, silentServer } from './test-serve.ts';
import { bareRemote, planted, remoteHook, sharedPair, site, siteScript, writeCensus } from './test-site.ts';
import type { Planted } from './test-site.ts';
import { anyTypeBedFromMain, cli, homeAt } from './test-weeds.ts';

interface Tended extends Planted {
  readonly bed: string;
  readonly remote: string;
}

function bedRef(remote: string, weedClass = 'any-type'): string {
  return git(remote, ['for-each-ref', '--format=%(objectname)', `refs/garden/beds/${weedClass}`]);
}

function withBed(t: TestContext): Tended {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);

  return { dir, garden, bed: anyTypeBedFromMain(garden), remote };
}

function tend(place: Tended, files: Readonly<Record<string, string>>, where = 'src/a.ts:1'): string {
  const tip = commit(place.bed, files);
  const added = cli(place.dir, ['add', '--class', 'any-type', '--where', where, '--source', 'census:x']);
  assert.equal(added.code, 0, added.stderr);
  const claimed = cli(place.dir, ['claim', '--class', 'any-type']);
  assert.equal(claimed.code, 0, claimed.stderr);
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
  const otherBed = anyTypeBedFromMain(other.garden);
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
  remoteHook(
    place.remote,
    'pre-receive',
    'while read old new ref; do\n  case "$ref" in refs/garden/beds/*) echo "no beds here"; exit 1;; esac\ndone',
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

// The log's push lands and leaves origin no repository, so the bed's push fails before git prints a line for its ref.
function bedPushFails(t: TestContext): Tended & { readonly tip: string } {
  const place = withBed(t);
  remoteHook(place.remote, 'post-receive', 'rm HEAD');
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  const tip = tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  return { ...place, tip };
}

function originBack(place: Tended): void {
  writeFileSync(join(place.remote, 'HEAD'), 'ref: refs/heads/main\n');
  rmSync(join(place.remote, 'hooks', 'post-receive'));
}

test("a bed whose push fails before git names its ref is named with git's reason", (t) => {
  const place = bedPushFails(t);

  const result = sync(openSite(place.dir), { attempts: 1 });
  originBack(place);

  assert.deepEqual(
    [result.state, result.divergedBeds.map((bed) => /^any-type: fatal: .+/.test(bed)), bedRef(place.remote)],
    ['synced', [true], ''],
    result.divergedBeds.join('\n'),
  );
});

test('a later sync pushes a bed whose push failed, though its close is already on origin', (t) => {
  const place = bedPushFails(t);
  sync(openSite(place.dir), { attempts: 1 });
  originBack(place);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds, bedRef(place.remote)], ['synced', [], place.tip]);
});

test('a bed a later sync pushed is not pushed back once origin deletes it', (t) => {
  const place = bedPushFails(t);
  sync(openSite(place.dir), { attempts: 1 });
  originBack(place);
  sync(openSite(place.dir), { attempts: 1 });
  git(place.remote, ['update-ref', '-d', 'refs/garden/beds/any-type']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, result.divergedBeds, bedRef(place.remote)], ['synced', [], '']);
});

test('a bed that lands keeps a mark another sync moved to another commit while it pushed', (t) => {
  const place = bedPushFails(t);
  sync(openSite(place.dir), { attempts: 1 });
  originBack(place);
  const moved = git(place.bed, ['rev-parse', 'HEAD~1']);
  remoteHook(
    place.remote,
    'post-receive',
    `unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${place.garden}' update-ref refs/garden-unpushed/beds/any-type ${moved}`,
  );

  sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [bedRef(place.remote), git(place.garden, ['for-each-ref', '--format=%(objectname)', 'refs/garden-unpushed/'])],
    [place.tip, moved],
  );
});

test('a bed whose push takes longer than the time allowed is named as timed out', async (t) => {
  const place = bedPushFails(t);
  sync(openSite(place.dir), { attempts: 1 });
  originBack(place);
  const port = await serve(t, silentServer);
  git(place.dir, ['remote', 'set-url', '--push', 'origin', `git://127.0.0.1:${port}/repo.git`]);

  const result = sync(openSite(place.dir), { attempts: 1, timeoutMs: 1000 });

  assert.deepEqual([result.state, result.divergedBeds], ['synced', ['any-type: timed out']]);
});

test('a later sync pushes the bed of a close whose log push landed after the sync stopped waiting', (t) => {
  const place = withBed(t);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  const tip = tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);
  remoteHook(place.remote, 'post-receive', 'sleep 4');
  const stopped = sync(openSite(place.dir), { attempts: 1, timeoutMs: 1500 });
  // The hook goes on after the push stopped waiting; it must end before the next push runs it again.
  sleep(5000);
  rmSync(join(place.remote, 'hooks', 'post-receive'));
  const landed = git(place.remote, ['rev-parse', logRef]) === git(place.garden, ['rev-parse', logRef]);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([stopped.reason, landed, result.state, bedRef(place.remote)], ['timed out', true, 'synced', tip]);
});

// A post-receive hook that stops the process whose id the file holds, once: the sync dies after its log landed.
function stopOnReceive(pidFile: string): string {
  const stop = `const { existsSync, readFileSync, rmSync } = require("node:fs"); const file = process.argv[1]; if (existsSync(file)) { const pid = Number(readFileSync(file, "utf8")); rmSync(file); process.kill(pid, "SIGKILL"); }`;

  return `'${process.execPath}' -e '${stop}' '${pidFile}'`;
}

test('a later sync pushes the bed of a close whose sync process stopped once its log landed', async (t) => {
  const place = withBed(t);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  const tip = tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);
  const pidFile = join(place.remote, 'sync.pid');
  remoteHook(place.remote, 'post-receive', stopOnReceive(pidFile));
  const stopped = spawn(process.execPath, [siteScript, 'sync'], { cwd: place.dir, stdio: 'ignore' });
  writeFileSync(pidFile, String(stopped.pid));
  await once(stopped, 'exit');
  const landed = git(place.remote, ['rev-parse', logRef]) === git(place.garden, ['rev-parse', logRef]);
  const before = bedRef(place.remote);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([landed, before, result.state, bedRef(place.remote)], [true, '', 'synced', tip]);
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

test('a bed made from a commit only a tag holds stays local and is named', (t) => {
  const place = withBed(t);
  commit(place.dir, { 'src/private.ts': 'export const unpushed = 1;\n' });
  git(place.dir, ['tag', 'private']);
  git(place.dir, ['reset', '-q', '--hard', 'HEAD~1']);
  git(place.bed, ['fetch', '-q', 'origin', 'refs/tags/private']);
  git(place.bed, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote)],
    ['synced', ['any-type: bed/any-type stays local: its base is on no branch fetched from origin'], ''],
  );
});

// Rewrites the bed's last commit with a signature header, as a signing setup leaves it; no key could check it.
function signTipByHand(bed: string): void {
  const text = git(bed, ['cat-file', 'commit', 'HEAD']);
  const signed = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: bed,
    encoding: 'utf8',
    input: `${text.replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----')}\n`,
  });
  git(bed, ['update-ref', 'refs/heads/bed/any-type', signed.stdout.trim()]);
}

test("a sync reads a signed bed's commits without starting the program that checks signatures", (t) => {
  const place = withBed(t);
  const checked = join(dirname(place.dir), 'signature-checked');
  const gpg = join(dirname(place.dir), 'gpg.sh');
  writeFileSync(gpg, `#!/bin/sh\necho checked > '${checked}'\nexit 1\n`, { mode: 0o755 });
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  commit(place.bed, { 'checks/notes.txt': 'notes\n' });
  signTipByHand(place.bed);
  const tip = tend(place, { 'checks/any-type.mjs': 'export {};\n' });
  git(place.dir, ['config', 'lzGardening.share', 'true']);
  git(place.dir, ['config', 'log.showSignature', 'true']);
  git(place.dir, ['config', 'gpg.program', gpg]);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual([result.state, bedRef(place.remote), existsSync(checked)], ['synced', tip, false]);
});

test("a bed that adds a line holding the site's path stays local and is named", (t) => {
  const place = withBed(t);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  tend(place, { 'checks/any-type.mjs': `// made in ${realpathSync.native(place.garden)}\nexport {};\n` });
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  assert.deepEqual(
    [result.state, result.divergedBeds, bedRef(place.remote)],
    ['synced', ['any-type: bed/any-type stays local: it holds a path on this machine'], ''],
  );
});

function keptLocalForAPath(t: TestContext, make: (place: Tended) => void): readonly unknown[] {
  const place = withBed(t);
  git(place.dir, ['config', 'lzGardening.share', 'false']);
  make(place);
  git(place.dir, ['config', 'lzGardening.share', 'true']);

  const result = sync(openSite(place.dir), { attempts: 1 });

  return [result.state, result.divergedBeds, bedRef(place.remote)];
}

const keptForAPath = ['synced', ['any-type: bed/any-type stays local: it holds a path on this machine'], ''] as const;

test("a bed that adds a line starting with ++ and holding the site's path stays local", (t) => {
  assert.deepEqual(
    keptLocalForAPath(t, (place) => {
      tend(place, { 'checks/notes.txt': `++ built in ${realpathSync.native(place.garden)}\n` });
    }),
    keptForAPath,
  );
});

test("a bed that edits a file with no final newline, adding the site's path as the hunk's last line, stays local", (t) => {
  assert.deepEqual(
    keptLocalForAPath(t, (place) => {
      commit(place.bed, { 'checks/notes.txt': 'old' });
      tend(place, { 'checks/notes.txt': `new\nbuilt in ${realpathSync.native(place.garden)}\n` });
    }),
    keptForAPath,
  );
});

test("a bed that adds a file git reads as binary, holding the site's path, stays local", (t) => {
  assert.deepEqual(
    keptLocalForAPath(t, (place) => {
      tend(place, { 'checks/built.bin': `\0\0built in ${realpathSync.native(place.garden)}\0` });
    }),
    keptForAPath,
  );
});

test("a bed whose merge adds, in its resolution only, a line holding the site's path stays local", (t) => {
  assert.deepEqual(
    keptLocalForAPath(t, (place) => {
      git(place.bed, ['switch', '-q', '-c', 'side']);
      commit(place.bed, { 'checks/side.txt': 'side\n' });
      git(place.bed, ['switch', '-q', 'bed/any-type']);
      commit(place.bed, { 'checks/main.txt': 'main\n' });
      git(place.bed, ['merge', '-q', '--no-commit', 'side']);
      writeFileSync(join(place.bed, 'checks', 'merged.txt'), `built in ${realpathSync.native(place.garden)}\n`);
      git(place.bed, ['add', '-A']);
      git(place.bed, ['commit', '-q', '--no-edit']);
      tend(place, { 'checks/any-type.mjs': 'export {};\n' });
    }),
    keptForAPath,
  );
});

test("a bed whose commit message holds the site's path stays local", (t) => {
  assert.deepEqual(
    keptLocalForAPath(t, (place) => {
      writeFileSync(join(place.bed, 'notes.txt'), 'notes\n');
      git(place.bed, ['add', 'notes.txt']);
      git(place.bed, ['commit', '-q', '-m', 'notes', '-m', `built in ${realpathSync.native(place.garden)}`]);
      tend(place, { 'checks/any-type.mjs': 'export {};\n' });
    }),
    keptForAPath,
  );
});

function tendedInFirstClone(
  t: TestContext,
  files: Readonly<Record<string, string>> = { 'checks/any-type.mjs': 'export {};\n' },
): {
  readonly second: Planted;
  readonly tip: string;
  readonly remote: string;
} {
  const { first, second, remote } = sharedPair(t);
  const added = cli(first.dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);
  const claimed = cli(first.dir, ['claim', '--class', 'any-type']);
  const made = site(first.dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.deepEqual([added.code, claimed.code, made.status], [0, 0, 0], made.stderr);
  const tip = commit(join(first.garden, 'beds', 'any-type'), files);
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

  return { second, tip, remote };
}

test("a bed continued from origin's bed reads only the commits origin lacks for a path on this machine", (t) => {
  const home = 'Q:\\gardener-home';
  const { second, remote } = tendedInFirstClone(t, { 'checks/notes.txt': `built in ${home}\\src\n` });
  homeAt(t, home);
  cli(second.dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:y']);
  assert.equal(cli(second.dir, ['claim', '--class', 'any-type']).code, 0);
  assert.equal(site(second.dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const tip = commit(join(second.garden, 'beds', 'any-type'), { 'checks/any-type.mjs': 'export const later = 1;\n' });

  const closed = cli(second.dir, [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip.slice(0, 7)}`,
    '--check',
    'checks/any-type.mjs',
  ]);

  assert.deepEqual([closed.stdout, closed.stderr, bedRef(remote)], ['closed 1; synced\n', '', tip]);
});

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
