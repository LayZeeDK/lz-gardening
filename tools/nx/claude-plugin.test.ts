import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDependencies,
  createNodes,
  externalNodes,
  importedPackage,
  importTarget,
  lockfileDrift,
  parseLockfile,
} from './claude-plugin.ts';

function workspace(t: TestContext, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugin-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  });

  return root;
}

async function inferred(root: string, manifest: string) {
  const [first] = await createNodes[1]([manifest], undefined, { nxJsonConfiguration: {}, workspaceRoot: root });

  return first?.[1];
}

test('a lockfile with no installed packages gives no external nodes', () => {
  assert.deepEqual(externalNodes({ packages: { '': { dependencies: {} } } }), {});
});

test('an installed package becomes npm:<name>@<version>, its integrity the hash', () => {
  assert.deepEqual(externalNodes({ packages: { 'node_modules/zod': { version: '4.6.7', integrity: 'sha512-x' } } }), {
    'npm:zod@4.6.7': {
      type: 'npm',
      name: 'npm:zod@4.6.7',
      data: { packageName: 'zod', version: '4.6.7', hash: 'sha512-x' },
    },
  });
});

test('an installed package with no integrity hashes by its version', () => {
  assert.deepEqual(
    Object.values(externalNodes({ packages: { 'node_modules/ms': { version: '2.1.3' } } })).map(
      ({ data }) => data.hash,
    ),
    ['2.1.3'],
  );
});

test('a nested scoped package is named by its own path segment', () => {
  assert.deepEqual(
    Object.keys(externalNodes({ packages: { 'node_modules/a/node_modules/@s/b': { version: '1.0.0' } } })),
    ['npm:@s/b@1.0.0'],
  );
});

test('a linked entry gives no node', () => {
  assert.deepEqual(externalNodes({ packages: { 'node_modules/x': { version: '1.0.0', link: true } } }), {});
});

test('equal dependency lists drift nowhere', () => {
  assert.deepEqual(
    lockfileDrift({ dependencies: { zod: '4.6.7' } }, { packages: { '': { dependencies: { zod: '4.6.7' } } } }),
    [],
  );
});

test('a range the locked version satisfies still drifts, named with both lists', () => {
  assert.deepEqual(
    lockfileDrift({ dependencies: { zod: '^4.6.7' } }, { packages: { '': { dependencies: { zod: '4.6.7' } } } }),
    ['package.json dependencies {"zod":"^4.6.7"} but package-lock.json {"zod":"4.6.7"}'],
  );
});

test('an empty dependency list matches a lockfile root that lists none, as npm writes it', () => {
  assert.deepEqual(lockfileDrift({ dependencies: {} }, { packages: { '': { name: 'lz-gardening' } } }), []);
});

test('optional and peer dependencies drift each in their own section', () => {
  assert.deepEqual(
    lockfileDrift(
      { optionalDependencies: { a: '1.0.0' }, peerDependencies: { b: '2.0.0' } },
      { packages: { '': { optionalDependencies: { a: '1.0.1' } } } },
    ),
    [
      'package.json optionalDependencies {"a":"1.0.0"} but package-lock.json {"a":"1.0.1"}',
      'package.json peerDependencies {"b":"2.0.0"} but package-lock.json {}',
    ],
  );
});

test('an entry only the lockfile lists drifts', () => {
  assert.deepEqual(lockfileDrift({ dependencies: {} }, { packages: { '': { dependencies: { ms: '2.1.3' } } } }), [
    'package.json dependencies {} but package-lock.json {"ms":"2.1.3"}',
  ]);
});

test('an import names its package, scoped or not, from a deep import too', () => {
  assert.deepEqual(['zod', 'zod/v4', '@s/b', '@s/b/deep'].map(importedPackage), ['zod', 'zod', '@s/b', '@s/b']);
});

test('a relative path, an absolute path, a node: built-in and a bare built-in name no package', () => {
  assert.deepEqual(['./log.ts', '../x', '/abs/y.ts', 'node:fs', 'fs'].map(importedPackage), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("an import reaches the version the project's own lockfile holds at its top level", () => {
  assert.equal(
    importTarget('zod', { packages: { 'node_modules/zod': { version: '4.6.7' } } }, { 'npm:zod': {} }),
    'npm:zod@4.6.7',
  );
});

test("an import the project's lockfile lacks reaches the workspace's hoisted node", () => {
  assert.equal(importTarget('semver', { packages: {} }, { 'npm:semver': {} }), 'npm:semver');
});

test('an import nothing holds reaches no node', () => {
  assert.equal(importTarget('left-pad', undefined, {}), undefined);
});

test('a lockfile of another version than 3 is refused, naming its path', () => {
  assert.throws(() => parseLockfile({ lockfileVersion: 2, packages: {} }, 'p/package-lock.json'), {
    message: 'p/package-lock.json is not an npm lockfile of version 3',
  });
});

test('a lockfile of version 3 gives its packages', () => {
  const packages = { '': { name: 'lz-gardening' } };

  assert.deepEqual(parseLockfile({ lockfileVersion: 3, requires: true, packages }, 'package-lock.json'), { packages });
});

test('a lockfile of version 3 with no packages object, or no object at all, is refused', () => {
  assert.throws(() => parseLockfile({ lockfileVersion: 3, packages: null }, 'a'), { message: /^a is not/ });
  assert.throws(() => parseLockfile(null, 'b'), { message: /^b is not/ });
});

test('a plugin folder is a project named in its manifest, with one mutate target per script', async (t) => {
  const scripts = 'plugins/p/skills/s/scripts';
  const root = workspace(t, {
    'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }',
    [`${scripts}/weeds.ts`]: '',
    [`${scripts}/weeds.test.ts`]: '',
    [`${scripts}/store-git.ts`]: '',
    [`${scripts}/store-log.ts`]: '',
    [`${scripts}/test-repo.ts`]: '',
    [`${scripts}/patterns.json`]: '',
    'plugins/p/skills/notes/SKILL.md': '',
    'plugins/p/skills/README.md': '',
  });

  const project = (await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.projects?.['plugins/p'];

  assert.equal(project?.name, 'p');
  assert.deepEqual(
    Object.keys(project.targets ?? {}).filter((name) => name.startsWith('mutate')),
    ['mutate', 'mutate-store', 'mutate-weeds'],
  );
});

test('a plugin with no skills folder gets the plugin-wide targets and no per-script mutate target', async (t) => {
  const root = workspace(t, { 'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }' });

  assert.deepEqual(
    Object.keys((await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.projects?.['plugins/p']?.targets ?? {}),
    ['test', 'lockfile', 'mutate'],
  );
});

test('a mutate target runs Stryker uncached and alone, on the scripts its MUTATE names', async (t) => {
  const root = workspace(t, {
    'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }',
    'plugins/p/skills/s/scripts/weeds.ts': '',
  });

  assert.deepEqual(
    (await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.projects?.['plugins/p']?.targets?.['mutate-weeds'],
    {
      command: 'node --conditions=@layzee/source node_modules/@stryker-mutator/core/bin/stryker.js run',
      options: { env: { MUTATE: 'weeds' } },
      cache: false,
      parallelism: false,
    },
  );
});

test("a plugin's lockfile packages are external nodes of the graph", async (t) => {
  const root = workspace(t, {
    'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }',
    'plugins/p/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { zod: '4.6.7' } }, 'node_modules/zod': { version: '4.6.7' } },
    }),
  });

  assert.deepEqual(Object.keys((await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.externalNodes ?? {}), [
    'npm:zod@4.6.7',
  ]);
});

test("a plugin's test target runs its specs from its root, cached per Node.js and git version", async (t) => {
  const root = workspace(t, {
    'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }',
  });

  assert.deepEqual(
    (await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.projects?.['plugins/p']?.targets?.['test'],
    {
      command: 'node --test "skills/*/scripts/*.test.ts"',
      options: { cwd: '{projectRoot}' },
      cache: true,
      inputs: ['default', '^default', { runtime: 'node --version' }, { runtime: 'git --version' }],
      outputs: [],
    },
  );
});

test("a plugin's lockfile target checks its package.json against its lockfile, cached on both and the check", async (t) => {
  const root = workspace(t, {
    'plugins/p/.claude-plugin/plugin.json': '{ "name": "p" }',
  });

  assert.deepEqual(
    (await inferred(root, 'plugins/p/.claude-plugin/plugin.json'))?.projects?.['plugins/p']?.targets?.['lockfile'],
    {
      command: 'node tools/nx/claude-plugin.ts lockfile plugins/p',
      cache: true,
      inputs: [
        '{projectRoot}/package.json',
        '{projectRoot}/package-lock.json',
        '{workspaceRoot}/tools/nx/claude-plugin.ts',
        '{workspaceRoot}/plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts',
        { runtime: 'npm --version' },
      ],
      outputs: [],
    },
  );
});

test('a manifest that names no plugin is refused, naming the manifest', async (t) => {
  const root = workspace(t, { 'plugins/p/.claude-plugin/plugin.json': '{}' });

  await assert.rejects(inferred(root, 'plugins/p/.claude-plugin/plugin.json'), {
    message: 'plugins/p/.claude-plugin/plugin.json names no plugin',
  });
});

const cli = fileURLToPath(new URL('claude-plugin.ts', import.meta.url));

function checkLockfile(root: string) {
  return spawnSync(process.execPath, [cli, 'lockfile', root], { encoding: 'utf8' });
}

test('a plugin with no lockfile fails the lockfile check, saying Claude Code installs nothing', (t) => {
  const root = workspace(t, { 'package.json': '{ "dependencies": {} }' });

  const { status, stderr } = checkLockfile(root);

  assert.equal(status, 1);
  assert.match(stderr, /has no package-lock\.json; Claude Code installs nothing without one/);
});

test('a package.json the lockfile disagrees with fails the lockfile check, naming the drift and the fix', (t) => {
  const root = workspace(t, {
    'package.json': '{ "dependencies": { "zod": "4.6.6" } }',
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { zod: '4.6.7' } } } }),
  });

  const { status, stderr } = checkLockfile(root);

  assert.equal(status, 1);
  assert.match(
    stderr,
    /: package\.json dependencies \{"zod":"4\.6\.6"\} but package-lock\.json \{"zod":"4\.6\.7"\}\. Run npm install --prefix /,
  );
});

test('a lockfile whose root agrees but that lacks a package fails the lockfile check through npm ci', (t) => {
  const dependencies = { ms: '2.1.3' };
  const root = workspace(t, {
    'package.json': JSON.stringify({ name: 'x', dependencies }),
    'package-lock.json': JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      packages: { '': { name: 'x', dependencies } },
    }),
  });

  const { status, stderr } = checkLockfile(root);

  assert.equal(status, 1);
  assert.match(stderr, /Missing: ms@2\.1\.3 from lock file/);
});

test('a lockfile npm wrote for an empty dependency list passes the lockfile check', (t) => {
  const root = workspace(t, {
    'package.json': JSON.stringify({ name: 'x', private: true, dependencies: {} }),
    'package-lock.json': JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'x' } },
    }),
  });

  assert.equal(checkLockfile(root).status, 0);
});

test('the lockfile check runs npm without a deprecation warning', (t) => {
  const root = workspace(t, {
    'package.json': JSON.stringify({ name: 'x', private: true }),
    'package-lock.json': JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'x' } },
    }),
  });

  assert.doesNotMatch(checkLockfile(root).stderr, /DeprecationWarning/);
});

test('the lockfile check names its usage when it gets no plugin root', () => {
  const { status, stderr } = spawnSync(process.execPath, [cli, 'lockfile'], { encoding: 'utf8' });

  assert.equal(status, 2);
  assert.match(stderr, /^usage: node tools\/nx\/claude-plugin\.ts lockfile <plugin root>/);
});

function dependencyContext(root: string, files: readonly string[]) {
  return {
    externalNodes: {},
    projects: { p: { root: 'plugins/p' } },
    nxJsonConfiguration: {},
    fileMap: { projectFileMap: {}, nonProjectFiles: [] },
    filesToProcess: { projectFileMap: { p: files.map((file) => ({ file, hash: '' })) }, nonProjectFiles: [] },
    workspaceRoot: root,
  };
}

test("a changed file's package import is a static edge to the version its project's lockfile holds", async (t) => {
  const root = workspace(t, {
    'plugins/p/a.ts':
      "import { z } from 'zod';\nimport { log } from './log.ts';\nimport { readFileSync } from 'node:fs';\n",
    'plugins/p/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/zod': { version: '4.6.7' } },
    }),
  });

  assert.deepEqual(await createDependencies(undefined, dependencyContext(root, ['plugins/p/a.ts'])), [
    { source: 'p', target: 'npm:zod@4.6.7', sourceFile: 'plugins/p/a.ts', type: 'static' },
  ]);
});

test('an import written in a file that is not source, such as a skill document, is no edge', async (t) => {
  const root = workspace(t, {
    'plugins/p/SKILL.md': "Parse it first:\n\nimport { z } from 'zod';\n",
    'plugins/p/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/zod': { version: '4.6.7' } },
    }),
  });

  assert.deepEqual(await createDependencies(undefined, dependencyContext(root, ['plugins/p/SKILL.md'])), []);
});
