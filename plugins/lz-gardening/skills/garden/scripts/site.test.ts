import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveBase } from './site.ts';
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

// A repository with feature/x checked out, no remote default, nothing recorded and nothing asked for.
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

test('with nothing recorded and no remote default, the base is main, not the branch checked out', () => {
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

test('a remote default of a hosted origin is the base even while it is checked out', () => {
  assert.equal(resolveBase(facts({ originHead: 'develop', branches: ['develop', 'main'] })), 'develop');
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
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', 'release']);
  git(dir, ['switch', '-q', '-c', 'feature/x']);
  site(dir, ['open']);
  const records = join(dirname(dir), 'repo.garden', '.garden');
  mkdirSync(records, { recursive: true });
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
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  site(dir, ['open']);
  const garden = join(dirname(dir), 'repo.garden');
  mkdirSync(join(garden, '.garden'));
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('committed'), true);
  assert.equal(git(garden, ['log', '-1', '--format=%s']), 'garden: watch abc1234');
  assert.equal(git(garden, ['ls-tree', '-r', '--name-only', 'garden']), '.garden/weeds.jsonl\n.gitignore');
});

test('commit with nothing new in .garden reports committed false and adds no commit', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  site(dir, ['open']);
  const garden = join(dirname(dir), 'repo.garden');
  mkdirSync(join(garden, '.garden'));
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
  site(dir, ['commit', '--message', 'garden: watch abc1234']);

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
  const planted = existsSync(join(dirname(dir), 'repo.garden'));
  site(dir, ['open', '--base', 'main']);
  mkdirSync(join(dirname(dir), 'repo.garden', '.garden'));
  writeFileSync(join(dirname(dir), 'repo.garden', '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
  const baseOnCommit = site(dir, ['commit', '--message', 'garden: watch', '--base', 'main']);

  assert.deepEqual([branchWithoutFlag.status, messageOnOpen.status, baseOnCommit.status], [2, 2, 2]);
  assert.match(branchWithoutFlag.stderr, /usage/);
  assert.equal(planted, false);
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
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  site(dir, ['open']);
  const garden = join(dirname(dir), 'repo.garden');
  mkdirSync(join(garden, '.garden'));
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');

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
  mkdirSync(join(garden, '.garden'));
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');

  const result = site(dir, ['commit', '--message', 'garden: watch abc1234']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /garden branch/);
  assert.equal(git(garden, ['rev-list', '--count', 'main']), '1');
});

test('open from inside a bed is an error and plants no site there', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  site(dir, ['open', '--base', 'main']);
  const garden = join(dirname(dir), 'repo.garden');
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
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const planted = site(dir, ['open', '--base', 'main']);
  const garden = join(dirname(dir), 'repo.garden');
  mkdirSync(join(garden, '.garden'));
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
  site(dir, ['commit', '--message', 'garden: seed abc1234']);

  const seeded = site(dir, ['open', '--base', 'main']);

  assert.equal(planted.summary.get('seeded'), false);
  assert.equal(seeded.summary.get('seeded'), true);
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
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  site(dir, ['open', '--base', 'main']);
  const records = join(dirname(dir), 'repo.garden', '.garden');
  mkdirSync(records);
  writeFileSync(join(records, 'census.json'), '{"rev":');

  const explicit = site(dir, ['open', '--base', 'main']);
  const recorded = site(dir, ['open']);

  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.summary.get('base'), 'main');
  assert.equal(recorded.status, 2);
  assert.match(recorded.stderr, /census\.json/);
});

test('a census file that is not a census stops open and is named, rather than being passed over', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['branch', 'release']);
  site(dir, ['open', '--base', 'main']);
  const records = join(dirname(dir), 'repo.garden', '.garden');
  mkdirSync(records);
  writeFileSync(join(records, 'census.json'), '{"rev":"release"}');

  const result = site(dir, ['open']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /census\.json/);
});

test('the site commits run none of the user hooks and sign nothing, whatever the user set globally', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const hooks = join(dirname(dir), 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
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

  const planted = site(dir, ['open', '--base', 'main'], env);
  assert.equal(planted.status, 0, planted.stderr);
  mkdirSync(join(dirname(dir), 'repo.garden', '.garden'));
  writeFileSync(join(dirname(dir), 'repo.garden', '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
  const recorded = site(dir, ['commit', '--message', 'garden: watch abc1234'], env);

  assert.equal(recorded.status, 0, recorded.stderr);
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
