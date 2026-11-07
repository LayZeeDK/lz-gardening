import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveBase } from './site.ts';
import { commit, git, repo } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'site.ts');

function site(cwd: string, args: readonly string[]): { readonly status: number | null; readonly summary: unknown } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  const last = result.stdout.trim().split('\n').at(-1) ?? '';

  return { status: result.status, summary: last.startsWith('{') ? JSON.parse(last) : result.stderr };
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
  assert.equal(resolveBase({ originHead: 'feature/x', current: 'feature/x', branches: ['feature/x', 'main'] }), 'main');
});

test('open on an existing site plants nothing new and fetches what landed in the repository since', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const first = site(dir, ['open', '--base', 'main']);
  assert.equal(first.status, 0, String(first.summary));
  const landed = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = site(dir, ['open', '--base', 'main']);

  assert.equal(second.status, 0, String(second.summary));
  assert.ok(typeof second.summary === 'object' && second.summary !== null && 'created' in second.summary);
  assert.equal(second.summary.created, false);
  const garden = join(dirname(dir), 'repo.garden');
  assert.equal(git(garden, ['rev-list', '--count', 'garden']), '1');
  assert.equal(git(garden, ['rev-parse', 'origin/main']), landed);
});

test('open creates the site beside the repository, holding only the plant commit on an orphan garden branch', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  const result = site(dir, ['open', '--base', 'main']);

  assert.equal(result.status, 0, String(result.summary));
  assert.ok(typeof result.summary === 'object' && result.summary !== null && 'site' in result.summary);
  const { summary } = result;
  assert.ok('created' in summary && 'base' in summary && typeof summary.site === 'string');
  const expected = join(dirname(dir), 'repo.garden');
  assert.equal(realpathSync.native(summary.site), realpathSync.native(expected));
  assert.equal(summary.created, true);
  assert.equal(summary.base, 'main');
  assert.equal(git(expected, ['branch', '--show-current']), 'garden');
  assert.equal(git(expected, ['log', '--format=%s | %an <%ae>']), 'garden: plant | test <test@example.com>');
  assert.equal(git(expected, ['ls-tree', '-r', '--name-only', 'HEAD']), '.gitignore');
  assert.equal(readFileSync(join(expected, '.gitignore'), 'utf8'), '/beds/\n');
});
