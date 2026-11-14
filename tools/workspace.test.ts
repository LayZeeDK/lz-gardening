// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { createProjectGraphAsync } from '@nx/devkit';
import { isRecord } from '../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

const root = join(import.meta.dirname, '..');
const plugin = join(root, 'plugins/lz-gardening');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workspacePath(path: string): string {
  return relative(root, path).split(sep).join('/');
}

// node --test passes green on a glob that matches no file, so the globs are checked here.
async function testGlobs(): Promise<readonly { readonly glob: string; readonly specs: readonly string[] }[]> {
  const graph = await createProjectGraphAsync({ exitOnError: false });

  return Object.values(graph.nodes).flatMap(({ data }) => {
    const options: unknown = data.targets?.['test']?.options;
    const command = isRecord(options) ? options['command'] : undefined;
    const cwd = isRecord(options) ? options['cwd'] : undefined;

    assert.ok(typeof command === 'string' && typeof cwd === 'string', `${data.root} has no test command`);

    return command
      .split('"')
      .filter((_, index) => index % 2 === 1)
      .map((glob) => ({
        glob: `${cwd}/${glob}`,
        specs: globSync(glob, { cwd: join(root, cwd) }).map((spec) => workspacePath(join(root, cwd, spec))),
      }));
  });
}

test('every test glob matches a spec', async () => {
  assert.deepEqual(
    (await testGlobs()).filter(({ specs }) => specs.length === 0).map(({ glob }) => glob),
    [],
  );
});

test('every tracked spec falls under a test glob', async () => {
  const run = new Set((await testGlobs()).flatMap(({ specs }) => specs));
  const tracked = spawnSync('git', ['ls-files', '-z', '--', '*.test.ts'], { cwd: root, encoding: 'utf8' });

  assert.equal(tracked.status, 0, tracked.stderr);
  assert.deepEqual(
    tracked.stdout.split('\0').filter((spec) => spec !== '' && !run.has(spec)),
    [],
  );
});

// nx run-many skips a target a project lacks without a word, so a renamed target would drop out of the check.
test('the plugin project has every target npm run check runs', async () => {
  const manifest = readJson(join(root, 'package.json'));
  const scripts = isRecord(manifest) ? manifest['scripts'] : undefined;
  const check = isRecord(scripts) ? scripts['check'] : undefined;
  const checked = typeof check === 'string' ? /nx run-many -t ([\w ]+?) &&/.exec(check)?.[1]?.split(' ') : undefined;
  const graph = await createProjectGraphAsync({ exitOnError: false });
  const targets = graph.nodes['lz-gardening']?.data.targets ?? {};

  assert.ok(checked !== undefined, 'package.json scripts.check runs no nx run-many -t');
  assert.deepEqual(
    checked.filter((target) => !(target in targets)),
    [],
  );
});

// Node.js resolves a bare import by walking up the folders, so a missing plugin install falls back to the root's
// packages unseen.
test("each plugin package resolves from the plugin's own node_modules at its locked version", () => {
  const manifest = readJson(join(plugin, 'package.json'));
  const lockfile = readJson(join(plugin, 'package-lock.json'));
  const dependencies = isRecord(manifest) && isRecord(manifest['dependencies']) ? manifest['dependencies'] : {};
  const packages = isRecord(lockfile) && isRecord(lockfile['packages']) ? lockfile['packages'] : {};
  const require = createRequire(join(plugin, 'package.json'));
  const fix = 'run npm ci --prefix plugins/lz-gardening --ignore-scripts';

  Object.keys(dependencies).forEach((name) => {
    const locked = packages[`node_modules/${name}`];
    const installed = readJson(join(plugin, 'node_modules', name, 'package.json'));

    // realpath: in a git worktree the plugin's node_modules may be a link to another checkout's.
    assert.ok(
      require.resolve(name).startsWith(realpathSync(join(plugin, 'node_modules')) + sep),
      `${name} resolves outside the plugin: ${fix}`,
    );
    assert.equal(
      isRecord(installed) ? installed['version'] : undefined,
      isRecord(locked) ? locked['version'] : undefined,
      `${name} is not installed at its locked version: ${fix}`,
    );
  });
});
