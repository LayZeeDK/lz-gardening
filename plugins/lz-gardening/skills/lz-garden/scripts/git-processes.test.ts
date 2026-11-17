import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { mayPointAtARepository } from './store-git.ts';
import { readStrategies, readStrategyVariable } from './store-git-objects.ts';
import type { ReadStrategy } from './store-git-objects.ts';
import { writePendingCensus } from './store-census.ts';
import { commit, git, repo } from './test-repo.ts';
import { bareRemote, censusText, planted, sharedPair, siteProcess } from './test-site.ts';
import { addWeed, cliProcess } from './test-weeds.ts';

const startsModule = new URL('test-git-starts.ts', import.meta.url).href;

function gitStarts(
  t: TestContext,
  run: (env: NodeJS.ProcessEnv) => number | null,
  strategy?: ReadStrategy,
): readonly string[] {
  const folder = mkdtempSync(join(tmpdir(), 'garden-starts-'));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  const starts = join(folder, 'starts.txt');
  const nodeOptions = [process.env['NODE_OPTIONS'], `--import=${startsModule}`].filter(
    (option) => option !== undefined,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !mayPointAtARepository(name)));
  const reads = strategy === undefined ? {} : { [readStrategyVariable]: strategy };

  assert.equal(
    run({ ...env, ...reads, NODE_OPTIONS: nodeOptions.join(' '), _LZ_GARDENING_INTERNAL_GIT_STARTS: starts }),
    0,
  );

  return existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').slice(0, -1) : [];
}

// One test per read strategy: the git processes the command starts, a reader's git counted once.
function startCounts(
  name: string,
  counts: Readonly<Record<ReadStrategy, number>>,
  starts: (t: TestContext, strategy: ReadStrategy) => readonly string[],
): void {
  for (const strategy of readStrategies) {
    test(`${name} starts ${String(counts[strategy])} git processes, reading through ${strategy}`, (t) => {
      const started = starts(t, strategy);

      assert.equal(started.length, counts[strategy], started.join('\n'));
    });
  }
}

startCounts('open that plants a new site in a repository with no origin', { spawn: 16, reader: 14 }, (t, strategy) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });

  return gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status, strategy);
});

startCounts('open on a planted site in a repository with no origin', { spawn: 10, reader: 7 }, (t, strategy) => {
  const { dir } = planted(t);

  return gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status, strategy);
});

startCounts(
  'open on a planted site whose origin holds its log, pushing nothing,',
  { spawn: 14, reader: 10 },
  (t, strategy) => {
    const { dir } = planted(t);
    bareRemote(dir);
    assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');

    return gitStarts(t, (env) => siteProcess(dir, ['open', '--base', 'main'], env).status, strategy);
  },
);

startCounts('sync of a site with an event the origin lacks', { spawn: 11, reader: 10 }, (t, strategy) => {
  const { dir } = planted(t);
  bareRemote(dir);
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
  assert.equal(
    cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']).status,
    0,
  );

  return gitStarts(t, (env) => siteProcess(dir, ['sync'], env).status, strategy);
});

startCounts(
  'sync of a site whose events the origin lacks while the origin holds events it lacks',
  { spawn: 12, reader: 11 },
  (t, strategy) => {
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

    return gitStarts(t, (env) => siteProcess(second.dir, ['sync'], env).status, strategy);
  },
);

startCounts(
  'sync --census --seeded that records the census of a garden with no origin',
  { spawn: 14, reader: 9 },
  (t, strategy) => {
    const { dir, garden } = planted(t);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

    return gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha, '--seeded'], env).status, strategy);
  },
);

startCounts(
  'sync --census that records the census and pushes it, with no other pending census,',
  { spawn: 15, reader: 12 },
  (t, strategy) => {
    const { dir, garden } = planted(t);
    bareRemote(dir);
    assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
    const sha = git(dir, ['rev-parse', 'HEAD']);
    writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

    return gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha], env).status, strategy);
  },
);

startCounts(
  'sync --census --seeded of a census already recorded, with no pending census left,',
  { spawn: 12, reader: 6 },
  (t, strategy) => {
    const { dir, garden } = planted(t);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));
    assert.equal(siteProcess(dir, ['sync', '--census', sha, '--seeded']).status, 0);

    return gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha, '--seeded'], env).status, strategy);
  },
);

startCounts(
  'bed that makes a new bed for a claimed class in a garden with no origin',
  { spawn: 9, reader: 6 },
  (t, strategy) => {
    const { dir } = planted(t);
    addWeed(dir, 'src/a.ts:1');
    assert.equal(cliProcess(dir, ['claim', '--class', 'any-type']).status, 0);

    return gitStarts(
      t,
      (env) => siteProcess(dir, ['bed', '--class', 'any-type', '--base', 'main'], env).status,
      strategy,
    );
  },
);

startCounts('an add that adds a weed', { spawn: 7, reader: 5 }, (t, strategy) => {
  const { dir } = planted(t);

  return gitStarts(
    t,
    (env) =>
      cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], env).status,
    strategy,
  );
});

startCounts('claim of a class with an origin and no race', { spawn: 24, reader: 14 }, (t, strategy) => {
  const { dir } = planted(t);
  bareRemote(dir);
  addWeed(dir, 'src/a.ts:1');
  assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');

  return gitStarts(t, (env) => cliProcess(dir, ['claim', '--class', 'any-type'], env).status, strategy);
});

startCounts('close-class --tended with an origin and no shared bed', { spawn: 31, reader: 19 }, (t, strategy) => {
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

  return gitStarts(t, (env) => cliProcess(dir, close, env).status, strategy);
});

startCounts(
  'sync --census with one pending census of an older base left by a crashed tick',
  { spawn: 16, reader: 13 },
  (t, strategy) => {
    const { dir, garden } = planted(t);
    bareRemote(dir);
    assert.equal(siteProcess(dir, ['sync']).summary.get('shared'), 'synced');
    const older = git(dir, ['rev-parse', 'HEAD']);
    writePendingCensus({ path: garden, checkout: dir }, older, censusText(older));
    const sha = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
    git(dir, ['push', '-q', 'origin', 'main']);
    writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

    return gitStarts(t, (env) => siteProcess(dir, ['sync', '--census', sha], env).status, strategy);
  },
);

startCounts('list', { spawn: 5, reader: 3 }, (t, strategy) => {
  const { dir } = planted(t);

  return gitStarts(t, (env) => cliProcess(dir, ['list'], env).status, strategy);
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
