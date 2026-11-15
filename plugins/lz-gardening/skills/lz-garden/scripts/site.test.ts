import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renameRetrying, resolveBase } from './site.ts';
import { readStrategyVariable } from './store-git-objects.ts';
import { logRef } from './store-log.ts';
import { censusRef, pendingCensusRef, writePendingCensus } from './store-census.ts';
import type { BaseFacts } from './site.ts';
import { commit, git, repo, startedCommands } from './test-repo.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import {
  bareRemote,
  configEnv,
  planted,
  remoteHook,
  sharedPair,
  writeCensus,
  writeCensusText,
  site,
  siteProcess,
} from './test-site.ts';
import { cli } from './test-weeds.ts';

// A repository with branches feature/x and main, a hosted origin with no default, nothing recorded and nothing
// asked for.
function facts(known: Partial<BaseFacts>): BaseFacts {
  return {
    base: undefined,
    censusRev: undefined,
    originHead: undefined,
    originIsLocal: false,
    branches: ['feature/x', 'main'],
    originBranchNames: [],
    ...known,
  };
}

test('with nothing recorded and no remote default, the base is main, not another branch', () => {
  assert.equal(resolveBase(facts({})), 'main');
});

test('a repository with master and no main uses master', () => {
  assert.equal(resolveBase(facts({ branches: ['feature/x', 'master'] })), 'master');
});

test('an explicit base wins over every other source', () => {
  assert.equal(
    resolveBase(
      facts({
        base: 'develop',
        censusRev: 'release',
        originHead: 'trunk',
        branches: ['develop', 'feature/x', 'main', 'release', 'trunk'],
      }),
    ),
    'develop',
  );
});

test('without an explicit base, the base the last census recorded wins', () => {
  assert.equal(
    resolveBase(
      facts({ censusRev: 'release', originHead: 'trunk', branches: ['feature/x', 'main', 'release', 'trunk'] }),
    ),
    'release',
  );
});

test("the base a census recorded is read as origin/<name> in a clone with only origin's branch of that name", () => {
  assert.equal(
    resolveBase(facts({ censusRev: 'main', branches: ['feature/x'], originBranchNames: ['main'] })),
    'origin/main',
  );
});

test('a base the last census recorded that names no branch here, such as HEAD, is passed over', () => {
  assert.equal(resolveBase(facts({ censusRev: 'HEAD', originHead: 'trunk', branches: ['main', 'trunk'] })), 'trunk');
});

test('with no census yet, the remote default branch is the base', () => {
  assert.equal(resolveBase(facts({ originHead: 'trunk', branches: ['feature/x', 'main', 'trunk'] })), 'trunk');
});

test('a remote default from a local source, which is only what the source had checked out, is passed over', () => {
  assert.equal(
    resolveBase(
      facts({ originHead: 'milestone-3', originIsLocal: true, branches: ['feature/x', 'main', 'milestone-3'] }),
    ),
    'main',
  );
});

test('a branch only origin has is read as origin/<name>', () => {
  assert.equal(resolveBase(facts({ branches: ['feature/x'], originBranchNames: ['main'] })), 'origin/main');
  assert.equal(resolveBase(facts({ branches: ['feature/x'], originBranchNames: ['master'] })), 'origin/master');
});

test('open without a base reports main while a feature branch is checked out', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['switch', '-q', '-c', 'feature/x']);

  const result = site(dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'main');
});

test('open in a clone of a hosted repository reports its default branch while a feature branch is checked out', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  git(source, ['switch', '-q', '-c', 'trunk']);
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', source, clone]);
  git(clone, ['remote', 'set-url', 'origin', 'https://example.invalid/repo.git']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);
  git(clone, ['switch', '-q', '-c', 'feature/x']);

  const result = site(clone, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'trunk');
});

test('open in a clone whose origin/HEAD names a commit, not a branch, falls back to main', (t) => {
  const source = repo(t);
  const head = commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', source, clone]);
  git(clone, ['remote', 'set-url', 'origin', 'https://example.invalid/repo.git']);
  git(clone, ['update-ref', '--no-deref', 'refs/remotes/origin/HEAD', head]);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);

  const result = site(clone, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'main');
});

test('open without a base reports the base the last census recorded', (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['branch', 'release']);
  git(dir, ['switch', '-q', '-c', 'feature/x']);
  writeCensus(garden, 'a'.repeat(40), 'release');

  const result = site(dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'release');
});

test('open without a base reports the base of the census its sync just fetched from origin', (t) => {
  const { first, second } = sharedPair(t);
  git(first.dir, ['branch', 'release']);
  git(first.dir, ['push', '-q', 'origin', 'release']);
  writeCensus(first.garden, git(first.dir, ['rev-parse', 'release']), 'release');
  assert.equal(site(first.dir, ['sync']).summary.get('shared'), 'synced');
  git(second.dir, ['fetch', '-q', 'origin']);

  const result = site(second.dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'origin/release');
});

test('open plants the garden log, holding only its format file', (t) => {
  const { garden } = planted(t);

  assert.deepEqual(
    [git(garden, ['ls-tree', '-r', '--name-only', logRef]), git(garden, ['show', `${logRef}:garden.json`])],
    ['garden.json', '{"format":1}'],
  );
});

test('open gives a new site a writer id of its own, which a second open keeps', (t) => {
  const { dir, garden } = planted(t);
  const writer = git(garden, ['config', 'lzGardening.writer']);
  const other = repo(t);
  commit(other, { 'src/a.ts': 'export const a = 1;\n' });
  site(other, ['open', '--base', 'main']);

  site(dir, ['open', '--base', 'main']);

  assert.match(writer, /^[0-9a-f-]{36}$/);
  assert.equal(git(garden, ['config', 'lzGardening.writer']), writer);
  assert.notEqual(git(join(dirname(other), 'repo.garden'), ['config', 'lzGardening.writer']), writer);
});

test('open plants the garden log on a site planted before the site held one', (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', logRef]);

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(garden, ['show', `${logRef}:garden.json`]), '{"format":1}');
});

test('open gives a writer id to a site whose log has lost it, and keeps the log', (t) => {
  const { dir, garden } = planted(t);
  const log = git(garden, ['rev-parse', logRef]);
  git(garden, ['config', '--unset', 'lzGardening.writer']);

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(git(garden, ['config', 'lzGardening.writer']), /^[0-9a-f-]{36}$/);
  assert.equal(git(garden, ['rev-parse', logRef]), log);
});

test('open refuses a repository at the site path that has no garden branch, and writes nothing into it', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const garden = join(dirname(dir), 'repo.garden');
  git(dirname(dir), ['clone', '-q', dir, garden]);

  const result = site(dir, ['open', '--base', 'main']);

  assert.match(
    result.stderr,
    /^site: .+repo\.garden has no garden branch, so it is not a garden site; move it away and run open again\n$/,
  );
  assert.deepEqual(
    [
      result.status,
      git(garden, ['for-each-ref', 'refs/garden']),
      git(garden, ['config', '--local', '--list']).includes('lzgardening.writer'),
    ],
    [2, '', false],
  );
});

test('open on a site whose config git cannot read exits 2 with the error git gives, not as a site to move away', (t) => {
  const { dir, garden } = planted(t);
  appendFileSync(join(garden, '.git', 'config'), '[core\n');

  const result = site(dir, ['open', '--base', 'main']);

  assert.deepEqual([result.status, /fatal: bad config line \d+ in file /.test(result.stderr)], [2, true]);
});

test('open refuses a repository with no user.email and plants no site', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['config', 'user.email', '']);

  const result = site(dir, ['open']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /user\.email/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden')), false);
});

test('open in a repository with no origin reports the garden as local', (t) => {
  const { dir } = planted(t);

  const result = site(dir, ['open', '--base', 'main']);

  assert.deepEqual([result.status, result.summary.get('shared')], [0, 'local'], result.stderr);
});

test('open to an origin it cannot reach prints offline with what git said', (t) => {
  const { dir } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);

  const result = site(dir, ['open', '--base', 'main']);

  assert.deepEqual([result.status, result.summary.get('shared')], [0, 'offline'], result.stderr);
  assert.match(
    String(result.summary.get('reason')),
    /^fatal: '.*missing\.git' does not appear to be a git repository$/,
  );
});

test('open pushes the events a run appended but never shared, as after a crash before its sync', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);
  assert.equal(site(dir, ['sync']).summary.get('shared'), 'synced');
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:x']);

  const result = site(dir, ['open', '--base', 'main']);

  assert.deepEqual(
    [result.summary.get('shared'), git(remote, ['rev-parse', logRef])],
    ['synced', git(garden, ['rev-parse', logRef])],
  );
});

test('a site planted from a clone of depth 1 fetches and pushes the garden log', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  commit(source, { 'src/b.ts': 'export const b = 1;\n' });
  const remote = join(dirname(source), 'remote.git');
  git(dirname(source), ['clone', '-q', '--bare', source, remote]);
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', '--depth', '1', `file://${remote.replaceAll('\\', '/')}`, clone]);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);
  assert.equal(site(clone, ['open']).summary.get('shared'), 'synced');
  cli(clone, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  const result = site(clone, ['sync']);

  assert.deepEqual(
    [result.summary.get('shared'), result.summary.get('events'), git(remote, ['rev-parse', logRef])],
    ['synced', 1, git(join(dirname(source), 'clone.garden'), ['rev-parse', logRef])],
  );
});

test('sync in a repository with no origin prints that the garden stays local and that no events were shared', (t) => {
  const { dir } = planted(t);

  const result = site(dir, ['sync']);

  assert.deepEqual(
    [result.status, Object.fromEntries(result.summary)],
    [0, { shared: 'local', events: 0 }],
    result.stderr,
  );
});

test('sync in a repository with no garden site exits 2 saying to open the site first', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['sync']);

  assert.deepEqual(
    [result.status, /^site: no garden site at .*repo\.garden; run site\.ts open first\n$/.test(result.stderr)],
    [2, true],
    result.stderr,
  );
});

test('sync to an origin it cannot reach exits 0 and prints offline with what git said', (t) => {
  const { dir } = planted(t);
  git(dir, ['remote', 'add', 'origin', join(dirname(dir), 'missing.git')]);

  const result = site(dir, ['sync']);

  assert.deepEqual(
    [result.status, result.summary.get('shared'), result.summary.get('events')],
    [0, 'offline', 0],
    result.stderr,
  );
  assert.match(
    String(result.summary.get('reason')),
    /^fatal: '.*missing\.git' does not appear to be a git repository$/,
  );
});

test('sync prints the files whose shared content it kept over the local one as conflicts', (t) => {
  const { first, second } = sharedPair(t);
  const path = 'events/0f/0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6.json';
  writeToLogByHand(first.garden, path, '{"from":"first"}');
  writeToLogByHand(second.garden, path, '{"from":"second"}');
  assert.equal(site(first.dir, ['sync']).status, 0);

  const result = site(second.dir, ['sync']);

  assert.deepEqual(
    [result.status, Object.fromEntries(result.summary)],
    [0, { shared: 'synced', events: 0, conflicts: [path] }],
    result.stderr,
  );
});

test('sync names each shared file it did not copy because it is not an event file, and still exits 0', (t) => {
  const { first, second } = sharedPair(t);
  writeToLogByHand(first.garden, 'notes.txt', 'hello');
  assert.equal(site(first.dir, ['sync']).status, 0);

  const result = site(second.dir, ['sync']);

  assert.deepEqual([result.status, result.stderr], [0, 'site: skipped notes.txt: not an event file\n']);
});

test('sync names a skipped shared file whose path breaks or reorders a line with those characters escaped', (t) => {
  const { first, second } = sharedPair(t);
  writeToLogByHand(first.garden, 'a b‮.txt', 'hello');
  assert.equal(site(first.dir, ['sync']).status, 0);

  const result = site(second.dir, ['sync']);

  assert.equal(result.stderr, 'site: skipped a\\u{2028}b\\u{202e}.txt: not an event file\n');
});

test('sync prints a reason whose text reorders a line with that character escaped', (t) => {
  const { dir } = planted(t);
  const remote = bareRemote(dir);
  remoteHook(remote, 'pre-receive', "printf 'closed \\342\\200\\256here\\n'\nexit 1");
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  const result = site(dir, ['sync']);

  assert.deepEqual(
    [result.summary.get('shared'), result.summary.get('reason')],
    ['read-only', 'remote: closed \\u{202e}here'],
  );
});

test('sync takes no option, so --base, --class and --message are usage errors', (t) => {
  const { dir } = planted(t);

  const statuses = [
    site(dir, ['sync', '--base', 'main']),
    site(dir, ['sync', '--class', 'any-type']),
    site(dir, ['sync', '--message', 'garden: watch']),
  ].map(({ status }) => status);

  assert.deepEqual(statuses, [2, 2, 2]);
});

function pendCensus(dir: string, garden: string): { readonly sha: string; readonly pending: string } {
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const census = { rev: 'main', sha, takenAt: '2026-11-13T00:00:00.000Z', counts: {}, hits: {}, duplicates: {} };
  writePendingCensus({ path: garden, checkout: dir }, sha, JSON.stringify(census));

  return { sha, pending: git(garden, ['rev-parse', pendingCensusRef(sha)]) };
}

test('sync --census records the census taken of that commit as the garden census', (t) => {
  const { dir, garden } = planted(t);
  const { sha, pending } = pendCensus(dir, garden);

  const result = site(dir, ['sync', '--census', sha]);

  assert.deepEqual(
    [result.status, git(garden, ['for-each-ref', '--format=%(objectname)', censusRef, 'refs/garden/pending'])],
    [0, pending],
  );
});

test('sync --census takes the commit id census.ts printed, and anything else is a usage error', (t) => {
  const { dir } = planted(t);

  const statuses = ['main', '../../heads/main', 'A'.repeat(40)].map(
    (census) => site(dir, ['sync', '--census', census]).status,
  );

  assert.deepEqual(statuses, [2, 2, 2]);
});

test('open names a shared census that is not a census, leaves it out, and still exits 0', (t) => {
  const { dir, garden } = planted(t);
  const remote = bareRemote(dir);
  writePendingCensus({ path: garden, checkout: dir }, 'bad', '{"rev":"main"}\n');
  git(garden, ['push', '-q', remote, `${pendingCensusRef('bad')}:${censusRef}`]);
  git(garden, ['update-ref', '-d', pendingCensusRef('bad')]);

  const result = site(dir, ['open', '--base', 'main']);

  assert.deepEqual([result.status, /refs\/garden\/census on origin is not a census/.test(result.stderr)], [0, true]);
});

test('commit is no longer a command: sync --census records the census', (t) => {
  const { dir } = planted(t);

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.deepEqual([result.status, /^(usage: |site: Unknown option '--message')/.test(result.stderr)], [2, true]);
});

test('a mistyped flag is a usage error, not ignored', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['open', '--bsae', 'release']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--bsae/);
});

test('an unknown command is a usage error and plants no site', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['opne']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden')), false);
});

test('an argument the command does not take is a usage error, not ignored', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const branchWithoutFlag = site(dir, ['open', 'develop']);
  const messageOnOpen = site(dir, ['open', '--message', 'garden: watch']);
  const plantedAnyway = existsSync(join(dirname(dir), 'repo.garden'));
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);
  const baseOnSync = site(dir, ['sync', '--census', 'a'.repeat(40), '--base', 'main']);

  assert.deepEqual([branchWithoutFlag.status, messageOnOpen.status, baseOnSync.status], [2, 2, 2]);
  assert.match(branchWithoutFlag.stderr, /usage/);
  assert.equal(plantedAnyway, false);
});

test('--class belongs to bed alone, and --message to no command', (t) => {
  const { dir, garden } = planted(t);

  const classOnOpen = site(dir, ['open', '--class', 'any-type', '--base', 'main']);
  const classOnSync = site(dir, ['sync', '--census', 'a'.repeat(40), '--class', 'any-type']);
  const messageOnBed = site(dir, ['bed', '--class', 'any-type', '--base', 'main', '--message', 'garden: watch']);

  assert.deepEqual([classOnOpen.status, classOnSync.status, messageOnBed.status], [2, 2, 2]);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed without --class or without --base is a usage error, not an open', (t) => {
  const { dir, garden } = planted(t);

  const withoutBase = site(dir, ['bed', '--class', 'any-type']);
  const withoutClass = site(dir, ['bed', '--base', 'main']);

  assert.deepEqual([withoutBase.status, withoutClass.status], [2, 2]);
  assert.match(withoutClass.stderr, /usage/);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

// A rename on Windows that fails with each given error code in turn, then goes through. Renames and waits go to
// one log.
function renameFailing(...codes: readonly string[]): {
  readonly calls: string[];
  readonly rename: (from: string, to: string) => void;
  readonly wait: () => void;
  readonly platform: NodeJS.Platform;
} {
  const calls: string[] = [];
  let tries = 0;
  const rename = (from: string, to: string): void => {
    calls.push(`${from}->${to}`);
    const code = codes[tries];
    tries += 1;

    if (code !== undefined) {
      throw Object.assign(new Error(code), { code });
    }
  };

  return { calls, rename, wait: () => calls.push('wait'), platform: 'win32' };
}

test('a rename that nothing holds up runs once', () => {
  const standIn = renameFailing();

  renameRetrying('a', 'b', standIn);

  assert.deepEqual(standIn.calls, ['a->b']);
});

test('a rename held up by a Windows file lock waits and tries again until it goes through', () => {
  const standIn = renameFailing('EPERM', 'EPERM', 'EPERM');

  renameRetrying('a', 'b', standIn);

  assert.deepEqual(standIn.calls, ['a->b', 'wait', 'a->b', 'wait', 'a->b', 'wait', 'a->b']);
});

test('a rename held up as busy or access denied is waited out like any file lock', () => {
  const standIn = renameFailing('EBUSY', 'EACCES');

  renameRetrying('a', 'b', standIn);

  assert.deepEqual(standIn.calls, ['a->b', 'wait', 'a->b', 'wait', 'a->b']);
});

test('a file lock is waited out for real time when no wait is given', () => {
  const { rename, platform } = renameFailing('EPERM');
  const started = performance.now();

  renameRetrying('a', 'b', { rename, platform });

  assert.ok(performance.now() - started >= 200);
});

test('a file lock that never lets go is thrown after a bounded number of tries', () => {
  const standIn = renameFailing(...Array.from({ length: 100 }, () => 'EPERM'));

  assert.throws(() => {
    renameRetrying('a', 'b', standIn);
  }, /EPERM/);
  assert.equal(standIn.calls.filter((call) => call === 'a->b').length, 20);
});

test('a rename error that is not a file lock is thrown at once', () => {
  const standIn = renameFailing('ENOENT');

  assert.throws(() => {
    renameRetrying('a', 'b', standIn);
  }, /ENOENT/);
  assert.deepEqual(standIn.calls, ['a->b']);
});

test('on Linux and macOS a permission error from a rename is thrown at once, not waited out', () => {
  const standIn = renameFailing('EPERM');

  assert.throws(() => {
    renameRetrying('a', 'b', { ...standIn, platform: 'linux' });
  }, /EPERM/);
  assert.deepEqual(standIn.calls, ['a->b']);
});

test('open in a clone with no local main reports origin/main', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  git(source, ['switch', '-q', '-c', 'milestone/M1']);
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', source, clone]);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);

  const result = site(clone, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'origin/main');
});

test('open in a clone of a file: URL passes over the branch the source had checked out', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  git(source, ['switch', '-q', '-c', 'milestone/M1']);
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', `file://${source.replaceAll('\\', '/')}`, clone]);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);

  const result = site(clone, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'origin/main');
});

test('open in a repository with master and a branch features/main uses master, not an origin/main', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', '-q', '-m', 'master']);
  git(dir, ['branch', '-q', 'features/main']);

  const result = site(dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'master');
});

for (const [strategy, commands] of [
  [
    'spawn',
    [
      'rev-parse',
      'rev-parse',
      'remote',
      'for-each-ref',
      'rev-parse',
      'cat-file',
      'config',
      'remote',
      'rev-parse',
      'ls-tree',
      'cat-file',
    ],
  ],
  ['reader', ['rev-parse', 'rev-parse', 'remote', 'for-each-ref', 'cat-file', 'cat-file', 'config', 'remote']],
] as const) {
  test(`open on a planted site reads the base without reading the repository config first, reading through ${strategy}`, (t) => {
    const { dir } = planted(t);
    const started = startedCommands(t);

    const result = site(dir, ['open', '--base', 'main'], { ...process.env, [readStrategyVariable]: strategy });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(started, commands);
  });
}

test('open in a clone takes --base HEAD as the commit checked out, not origin/HEAD', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', source, clone]);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.com']);

  const result = site(clone, ['open', '--base', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'HEAD');
});

test('open with a base that names no branch is an error that names it', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['open', '--base', 'relase']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /relase/);
});

test('open refuses a base whose name the agent could not pass to a shell as it is', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', 'x$(id)']);

  const result = site(dir, ['open', '--base', 'x$(id)']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /x\$\(id\)/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden')), false);
});

test('open refuses a base whose first character a shell would expand', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', '$HOME']);

  const result = site(dir, ['open', '--base', '$HOME']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /\$HOME has characters a shell would expand/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden')), false);
});

test('open from inside a bed is an error and plants no site there', (t) => {
  const { garden } = planted(t);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['worktree', 'add', '-q', '-b', 'bed/any-type', bed, 'main']);

  const result = site(bed, ['open', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /checkout/);
  assert.equal(existsSync(join(garden, 'beds', 'any-type.garden')), false);
});

test('open from a linked worktree uses the site beside the main checkout', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const worktree = join(dirname(dir), 'agent-x');
  git(dir, ['worktree', 'add', '-q', '-b', 'agent-x', worktree]);

  const result = site(worktree, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  const reported = result.summary.get('site');
  assert.ok(typeof reported === 'string');
  assert.equal(realpathSync.native(reported), realpathSync.native(join(dirname(dir), 'repo.garden')));
  assert.equal(existsSync(join(dirname(dir), 'agent-x.garden')), false);
});

test('sync --census --seeded adds a seed event naming the commit the seed pass read', (t) => {
  const { dir, garden } = planted(t);
  const { sha } = pendCensus(dir, garden);

  const result = site(dir, ['sync', '--census', sha, '--seeded']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...logFiles(garden).values()].map((event) => [event['op'], event['sha']]),
    [['seed', sha]],
  );
});

test('sync --census --seeded with no census taken of that commit logs no seed and says why', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);

  const result = site(dir, ['sync', '--census', sha, '--seeded']);

  assert.deepEqual(
    [result.status, result.stderr, logFiles(garden).size],
    [1, `site: no census of ${sha} to record: run census.ts --rev ${sha} first\n`, 0],
  );
});

test('sync --census of a commit the garden census already covers records nothing and exits 0', (t) => {
  const { dir, garden } = planted(t);
  const older = git(dir, ['rev-parse', 'HEAD']);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  assert.equal(site(dir, ['sync', '--census', pendCensus(dir, garden).sha]).status, 0);
  const recorded = git(garden, ['rev-parse', censusRef]);

  const result = site(dir, ['sync', '--census', older]);

  assert.deepEqual([result.status, result.stderr, git(garden, ['rev-parse', censusRef])], [0, '', recorded]);
});

test('open reports the site seeded once sync --census --seeded has run, and not before', (t) => {
  const { dir, garden } = planted(t);
  const before = site(dir, ['open', '--base', 'main']);
  const recorded = site(dir, ['sync', '--census', pendCensus(dir, garden).sha, '--seeded']);
  assert.equal(recorded.status, 0, recorded.stderr);

  const after = site(dir, ['open', '--base', 'main']);

  assert.deepEqual([before.summary.get('seeded'), after.summary.get('seeded')], [false, true]);
});

test('open refuses a folder where the site goes that is not a site, before cloning anything', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const garden = join(dirname(dir), 'repo.garden');
  mkdirSync(garden);
  writeFileSync(join(garden, 'notes.txt'), 'mine\n');

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repo\.garden is not a garden site/);
  assert.equal(existsSync(join(dirname(dir), 'repo.garden.planting')), false);
  assert.equal(readFileSync(join(garden, 'notes.txt'), 'utf8'), 'mine\n');
});

test('open plants over the leftover of a plant that stopped part way', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const leftover = join(dirname(dir), 'repo.garden.planting');
  git(dirname(dir), ['clone', '-q', '--no-checkout', dir, leftover]);

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('created'), true);
  assert.equal(existsSync(leftover), false);
  assert.equal(git(join(dirname(dir), 'repo.garden'), ['log', '--format=%s']), 'garden: plant');
});

test('a census that is not a census does not stop open, which takes the base it would take with none', (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, '{"rev":');

  const recorded = site(dir, ['open']);

  assert.deepEqual([recorded.status, recorded.summary.get('base')], [0, 'main']);
});

test('the site runs none of the user hooks and signs nothing, whatever the user set globally', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const hooks = join(dirname(dir), 'hooks');
  const ran = join(dirname(dir), 'hooks-ran.log');
  mkdirSync(hooks);
  const commitHooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];

  for (const hook of [...commitHooks, 'post-checkout', 'reference-transaction', 'post-index-change']) {
    const body = `#!/bin/sh\necho ${hook} >> "${ran.replaceAll('\\', '/')}"\nexit 1\n`;
    writeFileSync(join(hooks, hook), body, { mode: 0o755 });
  }

  const env = configEnv([
    ['core.hooksPath', hooks],
    ['commit.gpgsign', 'true'],
    ['gpg.program', join(dirname(dir), 'no-gpg')],
  ]);

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  const recorded = site(dir, ['sync', '--census', pendCensus(dir, join(dirname(dir), 'repo.garden')).sha], env);

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

test('the site runs none of the hooks the user set up by name in their git config', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
  const events = ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-index-change'];
  const settings = events.flatMap((event): [string, string][] => [
    [`hook.user-${event}.event`, event],
    [`hook.user-${event}.command`, `echo ${event} >> "${ran}"`],
  ]);
  const env = configEnv(settings);

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  const recorded = site(dir, ['sync', '--census', pendCensus(dir, join(dirname(dir), 'repo.garden')).sha], env);
  assert.equal(recorded.status, 0, recorded.stderr);
  cli(dir, ['add', '--class', 'probe', '--where', 'src/a.ts:1', '--source', 'census:probe'], env);
  cli(dir, ['claim', '--class', 'probe'], env);
  const bed = site(dir, ['bed', '--class', 'probe', '--base', 'main'], env);

  assert.equal(bed.status, 0, bed.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

for (const [holds, name] of [
  ['an equals sign', 'a=b'],
  ['a line separator', `line${String.fromCodePoint(0x2028)}sep`],
  ['nothing at all', ''],
] as const) {
  test(`the site runs no hook set up by name whose name holds ${holds}`, (t) => {
    const dir = repo(t);
    commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
    const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
    const env = configEnv([
      [`hook.${name}.event`, 'pre-commit'],
      [`hook.${name}.command`, `echo ran >> "${ran}"`],
    ]);

    const opened = site(dir, ['open', '--base', 'main'], env);
    assert.equal(opened.status, 0, opened.stderr);
    const recorded = site(dir, ['sync', '--census', pendCensus(dir, join(dirname(dir), 'repo.garden')).sha], env);

    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
  });
}

test('open without git on the PATH is an error that names git, not a crash', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const empty = join(dirname(dir), 'empty');
  mkdirSync(empty);
  const otherVariables = Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH');

  const result = siteProcess(dir, ['open', '--base', 'main'], { ...Object.fromEntries(otherVariables), PATH: empty });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^site: git /);
});

test('open run with GIT_DIR set, as from a git hook, plants the site and leaves the repository alone', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['open', '--base', 'main'], { ...process.env, GIT_DIR: join(dir, '.git') });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(dir, ['branch', '--show-current']), 'main');
  assert.equal(git(join(dirname(dir), 'repo.garden'), ['log', '--format=%s', 'garden']), 'garden: plant');
});

test('open keeps git settings passed in the environment, such as an identity for a container', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['config', '--unset', 'user.email']);
  const env = configEnv([['user.email', 'env@example.com']]);

  const result = site(dir, ['open', '--base', 'main'], env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(join(dirname(dir), 'repo.garden'), ['log', '--format=%ae', 'garden']), 'env@example.com');
});

test('open reads the identity from the repository even with GIT_CONFIG naming another config file', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const other = join(dirname(dir), 'other.gitconfig');
  writeFileSync(other, '[user]\n');

  const result = site(dir, ['open', '--base', 'main'], { ...process.env, GIT_CONFIG: other });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(other, 'utf8'), '[user]\n');
});

test('open in a checkout whose git folder lives elsewhere plants the site beside the checkout', (t) => {
  const parent = dirname(repo(t));
  const checkout = join(parent, 'separate');
  git(parent, ['init', '-q', '-b', 'main', '--separate-git-dir', join(parent, 'separate.git'), checkout]);
  git(checkout, ['config', 'user.email', 'test@example.com']);
  git(checkout, ['config', 'user.name', 'test']);
  commit(checkout, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(checkout, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(join(parent, 'separate.garden'), ['log', '--format=%s', 'garden']), 'garden: plant');
});

test('open on an existing site plants nothing new', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const first = site(dir, ['open', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = site(dir, ['open', '--base', 'main']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.summary.get('created'), false);
  assert.equal(git(join(dirname(dir), 'repo.garden'), ['rev-list', '--count', 'garden']), '1');
});

test('open creates the site beside the repository, holding only the plant commit on an orphan garden branch', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  const reported = result.summary.get('site');
  assert.ok(typeof reported === 'string');
  const expected = join(dirname(dir), 'repo.garden');
  assert.equal(realpathSync.native(reported), realpathSync.native(expected));
  assert.equal(result.summary.get('created'), true);
  assert.equal(result.summary.get('seeded'), false);
  assert.equal(result.summary.get('base'), 'main');
  assert.equal(git(expected, ['branch', '--show-current']), 'garden');
  assert.equal(git(expected, ['log', '--format=%s | %an <%ae>']), 'garden: plant | test <test@example.com>');
  assert.equal(git(expected, ['ls-tree', '-r', '--name-only', 'HEAD']), '.gitignore');
  assert.equal(readFileSync(join(expected, '.gitignore'), 'utf8'), '/beds/\n');
});
