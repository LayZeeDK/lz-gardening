// Run: node --test store-git.test.ts
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { isRecord } from './log-guard.ts';
import {
  catFileBatch,
  closeReaders,
  configValue,
  gitReason,
  gitSucceeds,
  inRun,
  isAncestor,
  isKnownAncestor,
  mainCheckout,
  mayPointAtARepository,
  moveRefIfStill,
  networkGit,
  objectIds,
  optionalGit,
  pushReport,
  refsUnder,
  refTip,
  runGit,
  siteObjectsInput,
  treeAt,
} from './store-git.ts';
import { readStrategies, readStrategyVariable } from './store-git-objects.ts';
import type { ReadStrategy } from './store-git-objects.ts';
import { commit, git, init, repo, startedCommands, startedGits } from './test-repo.ts';

function readThrough<T>(strategy: ReadStrategy, read: () => T): T {
  return inRun({ ...process.env, [readStrategyVariable]: strategy }, read);
}

// A commit whose tree holds a nested folder, an executable, a symbolic link and a submodule.
function mixedTree(dir: string): string {
  const blob = git(dir, ['rev-parse', `${commit(dir, { 'a.txt': 'a\n', 'src/deep/b.ts': 'b\n' })}:a.txt`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `100755,${blob},run.sh`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(dir, ['rev-parse', 'HEAD'])},sub`]);
  git(dir, ['commit', '-q', '-m', 'mixed']);

  return git(dir, ['rev-parse', 'HEAD']);
}

function sha256Repo(t: TestContext): string {
  const dir = join(dirname(repo(t)), 'sha256');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main', '--object-format=sha256']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);

  return dir;
}

test("a read with the site's objects input sees a commit only the site holds, with lazy fetching turned off", (t) => {
  const checkout = repo(t);
  commit(checkout, { 'a.txt': 'a\n' });
  const site = join(dirname(checkout), 'site');
  init(site);
  const onlyInSite = commit(site, { 'b.txt': 'b\n' });

  const [input, through, without] = inRun(process.env, () => {
    const objects = siteObjectsInput(site);

    return [
      objects,
      optionalGit(checkout, ['cat-file', '-t', onlyInSite], objects),
      optionalGit(checkout, ['cat-file', '-t', onlyInSite]),
    ] as const;
  });

  assert.deepEqual(
    [through, without, input.readsOnly, input.env?.['GIT_NO_LAZY_FETCH']],
    ['commit', undefined, true, '1'],
  );
});

test('a git that ends on a bad config before it reads its input fails with its own error, not as one that could not start', (t) => {
  const dir = repo(t);
  appendFileSync(join(dir, '.git', 'config'), '[core\n');

  const result = runGit(dir, ['cat-file', '--batch-check'], { input: 'HEAD\n'.repeat(4_000_000), readsOnly: true });

  assert.deepEqual([result.status, /fatal: bad config line \d+ in file /.test(result.stderr)], [128, true]);
});

test('a batch read by the spawn strategy from a git that ends on a bad config fails with the error git gives', (t) => {
  const dir = repo(t);
  appendFileSync(join(dir, '.git', 'config'), '[core\n');
  const names = Array.from({ length: 400_000 }, () => 'HEAD');

  assert.throws(
    () => inRun({ ...process.env, [readStrategyVariable]: 'spawn' }, () => catFileBatch(dir, names, (name) => name)),
    { message: /^git cat-file --batch: fatal: bad config line \d+ in file / },
  );
});

test('a batch read by the spawn strategy with no git on the PATH fails saying git could not be started', (t) => {
  const dir = repo(t);
  const empty = join(dirname(dir), 'empty');
  mkdirSync(empty);
  const otherVariables = Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH');
  const env = { ...Object.fromEntries(otherVariables), PATH: empty, [readStrategyVariable]: 'spawn' };

  assert.throws(() => inRun(env, () => catFileBatch(dir, ['HEAD'], (name) => name)), {
    message: /^git cat-file --batch: spawnSync git ENOENT$/,
  });
});

test('each read strategy answers an id read of no names with no ids', (t) => {
  const dir = repo(t);

  assert.deepEqual(
    readStrategies.map((strategy) => readThrough(strategy, () => objectIds(dir, []))),
    [[], []],
  );
});

test('each read strategy lists the tree of a commit as ls-tree does', (t) => {
  const dir = repo(t);
  const sha = mixedTree(dir);
  const listed = git(dir, ['ls-tree', '-r', '-z', sha])
    .split('\0')
    .filter((line) => line !== '')
    .map((line) => {
      const [info = '', path = ''] = line.split('\t');
      const [, type, oid] = info.split(' ');

      return { type, oid, path };
    });

  assert.deepEqual(
    readStrategies.map((strategy) => readThrough(strategy, () => treeAt(dir, sha))),
    readStrategies.map(() => listed),
  );
});

test('each read strategy reads a repository of SHA-256 object names', (t) => {
  const dir = sha256Repo(t);
  const sha = commit(dir, { 'src/a.ts': 'a\n' });
  const blob = git(dir, ['rev-parse', `${sha}:src/a.ts`]);

  assert.deepEqual(
    readStrategies.map((strategy) =>
      readThrough(strategy, () => [objectIds(dir, ['HEAD', 'HEAD:none']), treeAt(dir, sha)]),
    ),
    readStrategies.map(() => [[sha, undefined], [{ type: 'blob', oid: blob, path: 'src/a.ts' }]]),
  );
});

test('each read strategy leaves the folder free to rename once the run returns', (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });

  for (const strategy of readStrategies) {
    readThrough(strategy, () => treeAt(dir, sha));
    renameSync(dir, `${dir}-${strategy}`);
    renameSync(`${dir}-${strategy}`, dir);
  }
});

interface StartedGit {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, unknown>>;
}

// The arguments and the environment of each process this test starts with spawnSync from now on, in order.
function gitsStarted(t: TestContext): () => readonly StartedGit[] {
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  return () =>
    spawned.mock.calls.map(({ arguments: [, args, options] }) => ({
      args: Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [],
      env: isRecord(options) && isRecord(options['env']) ? options['env'] : {},
    }));
}

interface Read {
  readonly name: string;
  readonly commands: readonly string[];
  readonly read: (dir: string, sha: string) => unknown;
}

// The reads that ask git on its command line. A write's settings go before the command, and reading which hooks to
// turn off by name starts a git of its own.
const reads: readonly Read[] = [
  { name: "a spawn read of a ref's tip", commands: ['rev-parse'], read: (dir) => refTip(dir, 'refs/heads/main') },
  { name: 'a spawn read of object ids', commands: ['cat-file'], read: (dir) => objectIds(dir, ['HEAD']) },
  { name: "a spawn read of a commit's tree", commands: ['ls-tree'], read: (dir, sha) => treeAt(dir, sha) },
  { name: 'a read of the refs under a prefix', commands: ['for-each-ref'], read: (dir) => refsUnder(dir, ['refs']) },
  {
    name: 'an ancestry question that fails on a commit git does not know',
    commands: ['merge-base'],
    read: (dir, sha) => isAncestor(dir, sha, 'HEAD'),
  },
  {
    name: 'an ancestry question that reads a commit git does not know as a no',
    commands: ['merge-base'],
    read: (dir, sha) => isKnownAncestor(dir, sha, 'HEAD'),
  },
];

for (const { name, commands, read } of reads) {
  test(`${name} starts git with its command first, and with none of the settings a write takes`, (t) => {
    const dir = repo(t);
    const sha = commit(dir, { 'a.txt': 'a\n' });
    const gits = gitsStarted(t);

    readThrough('spawn', () => read(dir, sha));

    assert.deepEqual(
      gits().map(({ args }) => args[0]),
      commands,
    );
  });
}

test('each read strategy leaves the folder free to rename once the run throws', (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });

  for (const strategy of readStrategies) {
    assert.throws(
      () =>
        readThrough(strategy, () => {
          treeAt(dir, sha);
          throw new Error('the command failed');
        }),
      { message: 'the command failed' },
    );
    renameSync(dir, `${dir}-${strategy}`);
    renameSync(`${dir}-${strategy}`, dir);
  }
});

test("a read of a linked worktree's main checkout starts each git with its command first, and with none of the settings a write takes", (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });
  const worktree = join(dirname(dir), 'linked');
  git(dir, ['worktree', 'add', '-q', '-b', 'linked', worktree]);
  const gits = gitsStarted(t);

  readThrough('spawn', () => mainCheckout(worktree));

  assert.deepEqual(
    gits().map(({ args }) => args[0]),
    ['rev-parse', 'worktree'],
  );
});

test("the spawn strategy starts a git for each read, and the reader strategy one git for a folder's reads", (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });
  const started = startedCommands(t);

  const startedBy = readStrategies.map((strategy) => {
    const before = started.length;
    readThrough(strategy, () => [treeAt(dir, sha), treeAt(dir, sha)]);

    return started.slice(before);
  });

  assert.deepEqual(startedBy, [['ls-tree', 'ls-tree'], ['cat-file']]);
});

test("closing a folder's readers ends its git, so the run's next read in the folder starts a new one", (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });
  const started = startedCommands(t);

  readThrough('reader', () => {
    treeAt(dir, sha);
    closeReaders(dir);
    treeAt(dir, sha);
  });

  assert.deepEqual(started, ['cat-file', 'cat-file']);
});

test("each read strategy reads in the environment a read sets on top of the run's", (t) => {
  const dir = repo(t);
  const lender = join(dirname(dir), 'lender');
  init(lender);
  const sha = commit(lender, { 'a.txt': 'a\n' });
  const lent = { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(lender, '.git', 'objects') };

  assert.deepEqual(
    readStrategies.map((strategy) =>
      readThrough(strategy, () => [objectIds(dir, [sha]), objectIds(dir, [sha], { env: lent })]),
    ),
    readStrategies.map(() => [[undefined], [sha]]),
  );
});

test('a variable may point git at a repository when its name starts with GIT_ and not with GIT_CONFIG_', () => {
  assert.deepEqual(['GIT_DIR', 'GIT_CONFIG_COUNT', 'PATH'].map(mayPointAtARepository), [true, false, false]);
});

test('a git that writes runs with auto maintenance off, so no pack-refs it starts rewrites the refs of a run', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });
  const started = startedGits(t);

  inRun(process.env, () => gitSucceeds(dir, ['commit', '-q', '--allow-empty', '-m', 'b']));

  const commits = started().filter(({ args }) => args.includes('commit'));
  assert.match(commits.map(({ args }) => args.join(' ')).join('\n'), /^-c .*-c maintenance\.auto=false .*commit -q/);
});

test('a run whose environment sets GIT_EDITOR and GIT_OPTIONAL_LOCKS, as Claude Code does, starts no git to list the variables that point git at a repository', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });
  const env = { ...process.env, GIT_EDITOR: 'true', GIT_OPTIONAL_LOCKS: '0', [readStrategyVariable]: 'spawn' };
  const started = startedCommands(t);

  inRun(env, () => refTip(dir, 'HEAD'));

  assert.deepEqual(started, ['rev-parse']);
});

test('settings in GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT reach git in a run that drops the GIT_DIR beside them', (t) => {
  const dir = repo(t);
  const env = {
    ...process.env,
    GIT_DIR: join(dir, 'none'),
    GIT_CONFIG_PARAMETERS: "'garden.passed'='p'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'garden.counted',
    GIT_CONFIG_VALUE_0: 'c',
  };

  assert.deepEqual(
    inRun(env, () => [configValue(dir, 'garden.passed'), configValue(dir, 'garden.counted')]),
    ['p', 'c'],
  );
});

test('a key with no section and no name reads no setting', (t) => {
  const dir = repo(t);

  assert.equal(configValue(dir, ''), undefined);
});

test("the reason is the first line of git's message that holds text, without the lines after it", () => {
  assert.equal(gitReason('\n \nfatal: no route\nhint: try again\nhint: later\n'), 'fatal: no route');
});

// The git a fetch or push starts in a run with the env, here asked a question that needs no origin.
function networkGitStarted(t: TestContext, env: NodeJS.ProcessEnv): StartedGit {
  const dir = repo(t);
  const gits = gitsStarted(t);

  inRun(env, () => networkGit({ path: dir, checkout: dir }, ['rev-parse', '--git-dir'], 60_000));
  const started = gits().at(-1);
  assert.ok(started !== undefined, 'the run started a git');

  return started;
}

test("a fetch or push runs without git's tracing variables of the run, each by its whole name, and with the run's other variables", (t) => {
  const tracing = { GIT_TRACE: '0', GIT_TRACE2_EVENT: '0', GIT_CURL_VERBOSE: '0' };
  const others = { GIT_CURL_VERBOSER: '1', NO_GIT_TRACE: '1' };

  const { env } = networkGitStarted(t, { ...process.env, ...tracing, ...others });

  assert.deepEqual(
    Object.keys({ ...tracing, ...others }).filter((name) => env[name] !== undefined),
    Object.keys(others),
  );
});

test('a fetch or push for a user who set GIT_SSH_COMMAND takes no ssh command setting', (t) => {
  const { args } = networkGitStarted(t, { ...process.env, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/garden' });

  assert.deepEqual(args.slice(args.indexOf('credential.interactive=false') + 1), ['rev-parse', '--git-dir']);
});

test("a fetch or push runs in the C locale, with git's prompt and the credential manager's prompt off", (t) => {
  const { env } = networkGitStarted(t, process.env);

  assert.deepEqual([env['LC_ALL'], env['GIT_TERMINAL_PROMPT'], env['GCM_INTERACTIVE']], ['C', '0', 'never']);
});

test('a push report holds the refs whose lines give a summary, and no line of fewer fields', () => {
  const porcelain = 'To origin\n!\trefs/garden/log:refs/garden/log\t[rejected] (fetch first)\n=\tmain:main\nDone\n';

  assert.deepEqual(
    pushReport(porcelain),
    new Map([['refs/garden/log', { flag: '!', summary: '[rejected] (fetch first)' }]]),
  );
});

test('a move of a ref to the commit it is already at counts as moved', (t) => {
  const dir = repo(t);
  const sha = commit(dir, { 'a.txt': 'a\n' });

  assert.equal(moveRefIfStill(dir, 'refs/heads/main', sha, sha), true);
});

test('a prefix with no ref under it reads as no refs', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });

  assert.deepEqual(refsUnder(dir, ['refs/garden']), new Map());
});

test('a spawn batch read whose output ends after its first answer names the second object alone as the one it ends before', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });
  const firstAnswer = Buffer.byteLength('HEAD:none missing\n');
  const { spawnSync } = childProcess;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const result: unknown = Reflect.apply(spawnSync, childProcess, args);

    return isRecord(result) && Buffer.isBuffer(result['stdout'])
      ? { ...result, stdout: result['stdout'].subarray(0, firstAnswer) }
      : result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  assert.throws(
    () => readThrough('spawn', () => catFileBatch(dir, ['HEAD:none', 'HEAD:a.txt', 'HEAD:b.txt'], (name) => name)),
    { message: 'git cat-file --batch: the output ends before the object of HEAD:a.txt' },
  );
});

test("a spawn batch read starts its git in the run's environment", (t) => {
  const dir = repo(t);
  commit(dir, { 'a.txt': 'a\n' });
  const gits = gitsStarted(t);

  inRun({ ...process.env, [readStrategyVariable]: 'spawn', GARDEN_RUN: 'this one' }, () =>
    catFileBatch(dir, ['HEAD:a.txt'], (name) => name),
  );

  assert.deepEqual(
    gits().map(({ args, env }) => [args[0], env['GARDEN_RUN']]),
    [['cat-file', 'this one']],
  );
});
