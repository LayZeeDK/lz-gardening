import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { mayPointAtARepository } from './store.ts';
import { commit, repo } from './test-repo.ts';
import { planted, siteProcess, writeCensus } from './test-site.ts';
import { cliProcess } from './test-weeds.ts';

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

test('open plants a new site with 15 git processes', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status),
    15,
  );
});

test('open on a planted site starts 6 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status),
    6,
  );
});

test('commit records the census with 6 git processes', (t) => {
  const { dir, garden } = planted(t);
  writeCensus(garden);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['commit', '--message', 'census'], env).status),
    6,
  );
});

test('bed makes a new bed with 5 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(t, (env) => siteProcess(dir, ['bed', '--class', 'any-type', '--base', 'main'], env).status),
    5,
  );
});

test('an add that adds a weed starts 10 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(
      t,
      (env) =>
        cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], env).code,
    ),
    10,
  );
});

test('list starts 5 git processes', (t) => {
  const { dir } = planted(t);

  assertCount(
    gitStarts(t, (env) => cliProcess(dir, ['list'], env).code),
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
    gitStarts(t, (env) => cliProcess(dir, ['list'], { ...env, ...settings }).code),
    gitStarts(t, (env) => cliProcess(dir, ['list'], env).code),
  );
});

test('a git variable that is not a setting makes the script ask git which variables point at a repository', (t) => {
  const { dir } = planted(t);

  assert.equal(
    gitStarts(t, (env) => cliProcess(dir, ['list'], { ...env, GIT_TRACE: '0' }).code)[0],
    'git rev-parse --local-env-vars',
  );
});
