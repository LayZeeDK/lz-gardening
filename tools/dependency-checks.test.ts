// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectGraphAsync } from '@nx/devkit';
import { ESLint } from 'eslint';
import { isRecord } from '../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

const root = join(import.meta.dirname, '..');
const pluginPackageJson = join(root, 'plugins/lz-gardening/package.json');
const unused = ['@nx/dependency-checks', 'The "lz-canary" package is not used by "lz-gardening" project.'];

async function lintWithCanary(version: string): Promise<readonly (readonly [string | null, string])[]> {
  // The rule reads only the cached project graph; building it here keeps a bare run from reading a stale one.
  await createProjectGraphAsync({ exitOnError: false });
  const manifest: unknown = JSON.parse(readFileSync(pluginPackageJson, 'utf8'));
  assert.ok(isRecord(manifest) && isRecord(manifest['dependencies']));
  const planted = { ...manifest, dependencies: { ...manifest['dependencies'], 'lz-canary': version } };

  const [result] = await new ESLint({ cwd: root }).lintText(`${JSON.stringify(planted, null, 2)}\n`, {
    filePath: pluginPackageJson,
  });

  return result?.messages.map(({ ruleId, message }) => [ruleId, message] as const) ?? [];
}

test('@nx/dependency-checks lints the plugin package.json and reports a dependency no script imports', async () => {
  assert.deepEqual(
    await lintWithCanary('1.0.0'),
    [unused],
    'an empty list means the rule found no cached project graph (NX_CACHE_PROJECT_GRAPH=false) and skipped',
  );
});

const pin = [
  'no-restricted-syntax',
  'Pin the exact version (npm install --save-exact): the plugin ships the version its lockfile holds.',
];

test('a version range in the plugin package.json is refused', async () => {
  assert.deepEqual(await lintWithCanary('^1.0.0'), [unused, pin]);
});

test('an exact prerelease version in the plugin package.json is a pin', async () => {
  assert.deepEqual(await lintWithCanary('1.0.0-beta.1'), [unused]);
});
