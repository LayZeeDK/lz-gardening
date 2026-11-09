import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { namedHooksOff, renameRetrying, resolveBase } from './site.ts';
import type { BaseFacts } from './site.ts';
import { commit, git, repo } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'site.ts');

interface SiteRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly summary: ReadonlyMap<string, unknown>;
}

function site(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  const parsed: unknown = last.startsWith('{') ? JSON.parse(last) : {};
  const summary = new Map(typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []);

  return { status: result.status, stderr: result.stderr, summary };
}

// A repository with one commit on main and its site, planted.
function planted(t: TestContext): { readonly dir: string; readonly garden: string } {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  return { dir, garden: join(dirname(dir), 'repo.garden') };
}

function queueOneWeed(garden: string): void {
  mkdirSync(join(garden, '.garden'), { recursive: true });
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
}

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

test('open without a base reports the base the last census recorded', (t) => {
  const { dir, garden } = planted(t);
  git(dir, ['branch', 'release']);
  git(dir, ['switch', '-q', '-c', 'feature/x']);
  const records = join(garden, '.garden');
  mkdirSync(records);
  const census = { rev: 'release', sha: 'abc', takenAt: '2026-11-07T00:00:00.000Z', counts: {}, hits: {} };
  writeFileSync(join(records, 'census.json'), JSON.stringify(census));

  const result = site(dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'release');
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

test('commit records the .garden folder on the garden branch with the given message', (t) => {
  const { dir, garden } = planted(t);
  queueOneWeed(garden);

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('committed'), true);
  assert.equal(git(garden, ['log', '-1', '--format=%s']), 'garden: watch abc1234');
  assert.equal(git(garden, ['ls-tree', '-r', '--name-only', 'garden']), '.garden/weeds.jsonl\n.gitignore');
});

test('commit with nothing new in .garden reports committed false and adds no commit', (t) => {
  const { dir, garden } = planted(t);
  queueOneWeed(garden);
  const first = site(dir, ['commit', '--message', 'garden: watch abc1234']);
  assert.equal(first.status, 0, first.stderr);

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('committed'), false);
  assert.equal(git(garden, ['rev-list', '--count', 'garden']), '2');
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
  queueOneWeed(join(dirname(dir), 'repo.garden'));
  const baseOnCommit = site(dir, ['commit', '--message', 'garden: watch', '--base', 'main']);

  assert.deepEqual([branchWithoutFlag.status, messageOnOpen.status, baseOnCommit.status], [2, 2, 2]);
  assert.match(branchWithoutFlag.stderr, /usage/);
  assert.equal(plantedAnyway, false);
});

test('--class belongs to bed alone, and --message to commit alone', (t) => {
  const { dir, garden } = planted(t);
  queueOneWeed(garden);

  const classOnOpen = site(dir, ['open', '--class', 'any-type', '--base', 'main']);
  const classOnCommit = site(dir, ['commit', '--message', 'garden: watch', '--class', 'any-type']);
  const messageOnBed = site(dir, ['bed', '--class', 'any-type', '--base', 'main', '--message', 'garden: watch']);

  assert.deepEqual([classOnOpen.status, classOnCommit.status, messageOnBed.status], [2, 2, 2]);
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

test('commit without a message is a usage error and stages nothing', (t) => {
  const { dir, garden } = planted(t);
  queueOneWeed(garden);

  const result = site(dir, ['commit']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--message/);
  assert.equal(git(garden, ['diff', '--cached', '--name-only']), '');
});

test('commit before the site exists says to open it first', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /site\.ts open/);
});

test('commit in a site that is not on the garden branch is an error and commits nothing', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const garden = join(dirname(dir), 'repo.garden');
  git(dirname(dir), ['clone', '-q', '--no-checkout', dir, garden]);
  queueOneWeed(garden);

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /garden branch/);
  assert.equal(git(garden, ['rev-list', '--count', 'main']), '1');
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

test('open reports the site seeded once the garden branch holds a commit past the plant', (t) => {
  const { dir, garden } = planted(t);
  const before = site(dir, ['open', '--base', 'main']);
  queueOneWeed(garden);
  const recorded = site(dir, ['commit', '--message', 'garden: seed abc1234']);
  assert.equal(recorded.status, 0, recorded.stderr);

  const after = site(dir, ['open', '--base', 'main']);

  assert.equal(before.summary.get('seeded'), false);
  assert.equal(after.summary.get('seeded'), true);
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

test('a corrupt census does not stop an explicit base, and is named when it is read', (t) => {
  const { dir, garden } = planted(t);
  const records = join(garden, '.garden');
  mkdirSync(records);
  writeFileSync(join(records, 'census.json'), '{"rev":');

  const explicit = site(dir, ['open', '--base', 'main']);
  const recorded = site(dir, ['open']);

  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.summary.get('base'), 'main');
  assert.equal(recorded.status, 2);
  assert.match(recorded.stderr, /census\.json/);
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

  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'commit.gpgsign',
    GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_KEY_2: 'gpg.program',
    GIT_CONFIG_VALUE_2: join(dirname(dir), 'no-gpg'),
  };

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  queueOneWeed(join(dirname(dir), 'repo.garden'));
  const recorded = site(dir, ['commit', '--message', 'garden: watch abc1234'], env);

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

test('the site runs none of the hooks the user set up by name in their git config', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
  const events = ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-index-change'];
  const settings = events.flatMap((event) => [
    [`hook.user-${event}.event`, event],
    [`hook.user-${event}.command`, `echo ${event} >> "${ran}"`],
  ]);
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
  };

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  queueOneWeed(join(dirname(dir), 'repo.garden'));
  const recorded = site(dir, ['commit', '--message', 'garden: watch abc1234'], env);
  assert.equal(recorded.status, 0, recorded.stderr);
  const bed = site(dir, ['bed', '--class', 'probe', '--base', 'main'], env);

  assert.equal(bed.status, 0, bed.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

test('the site runs no hook set up by name whose name holds an equals sign', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'hook.a=b.event',
    GIT_CONFIG_VALUE_0: 'pre-commit',
    GIT_CONFIG_KEY_1: 'hook.a=b.command',
    GIT_CONFIG_VALUE_1: `echo a=b >> "${ran}"`,
  };

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  queueOneWeed(join(dirname(dir), 'repo.garden'));
  const recorded = site(dir, ['commit', '--message', 'garden: watch abc1234'], env);

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

test('the site runs no hook set up by name whose name holds a line separator', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'hook.line sep.event',
    GIT_CONFIG_VALUE_0: 'pre-commit',
    GIT_CONFIG_KEY_1: 'hook.line sep.command',
    GIT_CONFIG_VALUE_1: `echo line-sep >> "${ran}"`,
  };

  const opened = site(dir, ['open', '--base', 'main'], env);
  assert.equal(opened.status, 0, opened.stderr);
  queueOneWeed(join(dirname(dir), 'repo.garden'));
  const recorded = site(dir, ['commit', '--message', 'garden: watch abc1234'], env);

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(existsSync(ran) ? readFileSync(ran, 'utf8') : '', '');
});

test('the hooks turned off are those the config names, by their whole name, and no other key', (t) => {
  const dir = repo(t);
  git(dir, ['config', 'hook.team.lint.event', 'pre-commit']);
  git(dir, ['config', 'hook.team.lint.command', 'npm run lint']);
  git(dir, ['config', 'alias.hook.x.command', 'log']);
  git(dir, ['config', 'hook.other.commandeer', 'x']);

  assert.deepEqual(namedHooksOff(dir), ['--config-env=hook.team.lint.enabled=LZ_GARDEN_HOOK_OFF']);
});

test('open without git on the PATH is an error that names git, not a crash', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const empty = join(dirname(dir), 'empty');
  mkdirSync(empty);
  const otherVariables = Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH');

  const result = site(dir, ['open', '--base', 'main'], { ...Object.fromEntries(otherVariables), PATH: empty });

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
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.email',
    GIT_CONFIG_VALUE_0: 'env@example.com',
  };

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
  assert.equal(result.summary.get('base'), 'main');
  assert.equal(git(expected, ['branch', '--show-current']), 'garden');
  assert.equal(git(expected, ['log', '--format=%s | %an <%ae>']), 'garden: plant | test <test@example.com>');
  assert.equal(git(expected, ['ls-tree', '-r', '--name-only', 'HEAD']), '.gitignore');
  assert.equal(readFileSync(join(expected, '.gitignore'), 'utf8'), '/beds/\n');
});

test('bed makes a worktree on bed/<class> from the base as the repository has it now', (t) => {
  const { dir, garden } = planted(t);
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

test('bed on an existing bed keeps its work and reports where it started, after the base moved on', (t) => {
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  const work = commit(bed, { 'src/a.ts': 'export const a: number = 1;\n' });
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('created'), false);
  assert.equal(again.summary.get('bed'), first.summary.get('bed'));
  assert.equal(again.summary.get('start'), first.summary.get('start'));
  assert.equal(git(bed, ['rev-parse', 'HEAD']), work);
});

test('bed on an existing bed reports where its branch started, not where a tag of the same name points', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', 'old']);
  const later = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['tag', 'bed/any-type', later]);
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'old']);
  assert.equal(first.status, 0, first.stderr);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.summary.get('start'), first.summary.get('start'));
});

test('bed on a bed whose folder is gone brings the folder back with the branch work', (t) => {
  const { dir, garden } = planted(t);
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
  const { dir, garden } = planted(t);
  const first = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['worktree', 'remove', '--force', bed]);
  mkdirSync(bed);

  const again = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(again.status, 2);
  assert.match(again.stderr, /beds[\\/]any-type/);
});

test('bed refuses a class that is not a kebab-case class id and makes no bed', (t) => {
  const { dir, garden } = planted(t);

  const result = site(dir, ['bed', '--class', 'nested/any-type', '--base', 'main']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--class/);
  assert.equal(existsSync(join(garden, 'beds', 'nested')), false);
  assert.equal(git(garden, ['branch', '--list', 'bed/*']), '');
});

test('bed needs no dependencies when the base has no package.json', (t) => {
  const { dir, garden } = planted(t);

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

  return dir;
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

  const result = site(dir, ['bed', '--class', 'any-type', '--base', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('deps'), 'install');
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
