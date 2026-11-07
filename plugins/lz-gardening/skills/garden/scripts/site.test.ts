import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveBase } from './site.ts';
import { commit, git, repo } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'site.ts');

interface SiteRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly summary: ReadonlyMap<string, unknown>;
}

function site(cwd: string, args: readonly string[]): SiteRun {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  const parsed: unknown = last.startsWith('{') ? JSON.parse(last) : {};
  const summary = new Map(typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []);

  return { status: result.status, stderr: result.stderr, summary };
}

test('with nothing recorded and no remote default, the base is main, not the branch checked out', () => {
  assert.equal(resolveBase({ current: 'feature/x', branches: ['feature/x', 'main'] }), 'main');
});

test('a repository with master and no main uses master', () => {
  assert.equal(resolveBase({ current: 'feature/y', branches: ['feature/y', 'master'] }), 'master');
});

test('an explicit base wins over every other source', () => {
  assert.equal(
    resolveBase({
      base: 'develop',
      censusRev: 'release',
      originHead: 'trunk',
      current: 'feature/x',
      branches: ['develop', 'feature/x', 'main', 'release', 'trunk'],
    }),
    'develop',
  );
});

test('without an explicit base, the base the last census recorded wins', () => {
  assert.equal(
    resolveBase({
      censusRev: 'release',
      originHead: 'trunk',
      current: 'feature/x',
      branches: ['feature/x', 'main', 'release', 'trunk'],
    }),
    'release',
  );
});

test('with no census yet, the remote default branch is the base', () => {
  assert.equal(
    resolveBase({ originHead: 'trunk', current: 'feature/x', branches: ['feature/x', 'main', 'trunk'] }),
    'trunk',
  );
});

test('a remote default that is only the branch checked out in a local source is passed over for main', () => {
  assert.equal(
    resolveBase({
      originHead: 'feature/x',
      current: 'feature/x',
      originIsLocal: true,
      branches: ['feature/x', 'main'],
    }),
    'main',
  );
});

test('a remote default of a hosted origin is the base even while it is checked out', () => {
  assert.equal(resolveBase({ originHead: 'develop', current: 'develop', branches: ['develop', 'main'] }), 'develop');
});

test('open without a base reports main while a feature branch is checked out', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  git(dir, ['switch', '-q', '-c', 'feature/x']);

  const result = site(dir, ['open']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.get('base'), 'main');
});

test('open in a clone reports the remote default branch while a feature branch is checked out', (t) => {
  const source = repo(t);
  commit(source, { 'src/a.ts': 'export const a = 1;\n' });
  git(source, ['switch', '-q', '-c', 'trunk']);
  const clone = join(dirname(source), 'clone');
  git(dirname(source), ['clone', '-q', source, clone]);
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
