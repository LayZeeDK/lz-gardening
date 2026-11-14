import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { mayPointAtARepository } from './store-git.ts';
import { writePendingCensus } from './store-census.ts';
import { commit, git, repo } from './test-repo.ts';
import { bareRemote, censusText, planted, sharedPair, siteProcess } from './test-site.ts';
import { addWeed, cliProcess } from './test-weeds.ts';

const startsModule = new URL('test-git-starts.ts', import.meta.url).href;

function gitStarts(t: TestContext, run: (env: NodeJS.ProcessEnv) => number | null): readonly string[] {
  const folder = mkdtempSync(join(tmpdir(), 'garden-starts-'));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const starts = join(folder, 'starts.txt');
  const nodeOptions = [process.env['NODE_OPTIONS'], `--import=${startsModule}`].filter(
    (option) => option !== undefined,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));

  assert.equal(run({ ...env, NODE_OPTIONS: nodeOptions.join(' '), LZ_GARDEN_GIT_STARTS: starts }), 0);

  return existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').slice(0, -1) : [];
}

function assertCount(starts: readonly string[], count: number): void {
  assert.equal(starts.length, count, starts.join('\n'));
}

test('open plants a new site in a repository with no origin with 16 git processes', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status),
    16,
  );
});

test('open on a planted site in a repository with no origin starts 10 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status),
    10,
  );
});

test('open on a planted site whose origin holds its log starts 16 git processes and pushes nothing', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status),
    16,
  );
});

test('sync of a site with an event the origin lacks starts 13 git processes', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
  assert.equal(
    cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']).status,
    0,
  );

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['sync'], env).status),
    13,
  );
});

test('sync of a site whose events the origin lacks while the origin holds events it lacks starts 14 git processes', (t) => {
  const { first, second } = sharedPair(t);
  assert.equal(
    cliProcess(first.dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']).status,
    0,
  );
  assert.equal(siteProcess(first.dir, ['sync']).summary.get('shared'), 'synced');
  assert.equal(
    cliProcess(second.dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'census:x']).status,
    0,
  );

  assertCount(
    gitStarts(t, (env) => siteProcess(second.dir, ['sync'], env).status),
    14,
  );
});

test('sync --census --seeded that records the census of a garden with no origin starts 13 git processes', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha, '--seeded'], env).status),
    13,
  );
});

test('sync --census that records the census and pushes it, with no other pending census, starts 17 git processes', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha], env).status),
    17,
  );
});

test('sync --census --seeded of a census already recorded, with no pending census left, starts 12 git processes', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));
  assert.equal(siteProcess(dir, ['sync', '--census', sha, '--seeded']).status, 0);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha, '--seeded'], env).status),
    12,
  );
});

test('bed makes a new bed for a claimed class in a garden with no origin with 9 git processes', (t) => {
  const { dir } = planted(t);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cliProcess(dir, ['claim', '--class', 'any-type']).status, 0);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['bed', '--class', 'any-type', '--base', 'main'], env).status),
    9,
  );
});

test('an add that adds a weed starts 7 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(
      t,
      (env) =>
        cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], env).status,
    ),
    7,
  );
});

test('claim of a class with an origin and no race starts 28 git processes', (t) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');

  assertCount(
    gitStarts(t, (env) => cliProcess(dir, ['claim', '--class', 'any-type'], env).status),
    28,
  );
});

test('close-class --tended with an origin and no shared bed starts 35 git processes', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(cliProcess(dir, ['claim', '--class', 'any-type']).status, 0);
  assert.equal(siteProcess(dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const tip = commit(join(garden, 'beds', 'any-type'), { 'checks/any-type.mjs': 'export {};\n' });
  const close = [
    'close-class',
    '--class',
    'any-type',
    '--tended',
    `bed/any-type@${tip.slice(0, 7)}`,
    '--check',
    'x.mjs',
  ];

  assertCount(
    gitStarts(t, (env) => cliProcess(dir, close, env).status),
    35,
  );
});

test('sync --census with one pending census of an older base left by a crashed tick starts 18 git processes', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
  const older = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, older, censusText(older));
  const sha = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['push', '-q', 'origin', 'main']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha], env).status),
    18,
  );
});

test('list starts 5 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(t, (env) => cliProcess(dir, ['list'], env).status),
    5,
  );
});

test('git settings in the environment start no extra git process', (t) => {
  const { dir } = planted(t);
  const settings = {
    GIT_CONFIG_SYSTEM: join(dir, 'none'),
    GIT_CONFIG_PARAMETERS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'lzgardening.probe',
    GIT_CONFIG_VALUE_0: 'x',
  };

  assert.deepEqual(
    gitStarts(t, (env) => cliProcess(dir, ['list'], { ...env, ...settings }).status),
    gitStarts(t, (env) => cliProcess(dir, ['list'], env).status),
  );
});

test('a git variable that is not a setting makes the script ask git which variables point at a repository', (t) => {
  const { dir } = planted(t);

  assert.equal(
    gitStarts(t, (env) => cliProcess(dir, ['list'], { ...env, GIT_TRACE: '0' }).status)[0],
    'git rev-parse --local-env-vars',
  );
});
