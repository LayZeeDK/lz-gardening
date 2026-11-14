import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CreateDependencies, CreateNodes, ProjectGraphExternalNode, TargetConfiguration } from '@nx/devkit';
import { DependencyType } from '@nx/devkit';
import ts from 'typescript';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log.ts';

/** An npm lockfile of version 3; entries stay unparsed until a reader narrows the fields it uses. */
export interface Lockfile {
  readonly packages: Readonly<Record<string, unknown>>;
}

/** The lockfile in `value`, read from `path`; throws unless it is an npm lockfile of version 3. */
export function parseLockfile(value: unknown, path: string): Lockfile {
  if (!isRecord(value) || value['lockfileVersion'] !== 3 || !isRecord(value['packages'])) {
    throw new Error(`${path} is not an npm lockfile of version 3`);
  }

  return { packages: value['packages'] };
}

/** The package-lock.json in `folder`, or undefined when it has none. */
function readLockfile(folder: string): Lockfile | undefined {
  const path = join(folder, 'package-lock.json');

  return existsSync(path) ? parseLockfile(JSON.parse(readFileSync(path, 'utf8')), path) : undefined;
}

const installed = 'node_modules/';

/** Every installed package in a plugin lockfile as `npm:<name>@<version>`, its integrity as the hash. */
export function externalNodes(lockfile: Lockfile): Record<string, ProjectGraphExternalNode> {
  return Object.fromEntries(
    Object.entries(lockfile.packages).flatMap(([path, entry]) => {
      if (!path.startsWith(installed) || !isRecord(entry)) {
        return [];
      }

      const { version, integrity, link } = entry;

      if (typeof version !== 'string' || link === true) {
        return [];
      }

      const packageName = path.slice(path.lastIndexOf(installed) + installed.length);
      const name = `npm:${packageName}@${version}` as const;
      const hash = typeof integrity === 'string' ? integrity : version;

      return [[name, { type: 'npm', name, data: { packageName, version, hash } }]];
    }),
  );
}

/** The package an import names; undefined for a relative path, an absolute path or a Node.js built-in. */
export function importedPackage(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) {
    return undefined;
  }

  const [first = '', second = ''] = specifier.split('/');

  return first.startsWith('@') ? `${first}/${second}` : first;
}

/**
 * The external node an import of `packageName` reaches: the version the project's own lockfile holds at its top level,
 * else the workspace's hoisted `npm:<name>` node.
 */
export function importTarget(
  packageName: string,
  lockfile: Lockfile | undefined,
  workspaceNodes: Readonly<Record<string, unknown>>,
): string | undefined {
  const entry = lockfile?.packages[`${installed}${packageName}`];
  const version = isRecord(entry) ? entry['version'] : undefined;

  if (typeof version === 'string') {
    return `npm:${packageName}@${version}`;
  }

  const hoisted = `npm:${packageName}`;

  return hoisted in workspaceNodes ? hoisted : undefined;
}

/** Where package.json and the lockfile's root entry disagree, per dependency section. */
export function lockfileDrift(packageJson: unknown, lockfile: Lockfile): readonly string[] {
  const root = lockfile.packages[''];
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

  return sections.flatMap((section) => {
    const declared = (isRecord(packageJson) ? packageJson[section] : undefined) ?? {};
    const locked = (isRecord(root) ? root[section] : undefined) ?? {};

    return isDeepStrictEqual(declared, locked)
      ? []
      : [`package.json ${section} ${JSON.stringify(declared)} but package-lock.json ${JSON.stringify(locked)}`];
  });
}

/** The scripts under mutation: each name before its first hyphen, as stryker.config.mjs reads MUTATE. */
function scripts(pluginRoot: string): readonly string[] {
  const skills = join(pluginRoot, 'skills');
  const files = readdirSync(skills, { withFileTypes: true })
    .filter((skill) => skill.isDirectory() && existsSync(join(skills, skill.name, 'scripts')))
    .flatMap((skill) => readdirSync(join(skills, skill.name, 'scripts')))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.startsWith('test-'));

  return [...new Set(files.map((file) => basename(file, '.ts').split('-')[0] ?? file))].sort();
}

function mutate(script: string): TargetConfiguration {
  return {
    command: 'node --conditions=@layzee/source node_modules/@stryker-mutator/core/bin/stryker.js run',
    options: { env: { MUTATE: script } },
    cache: false,
  };
}

function pluginTargets(root: string, scriptNames: readonly string[]): Record<string, TargetConfiguration> {
  return {
    test: {
      command: 'node --test "skills/*/scripts/*.test.ts"',
      options: { cwd: '{projectRoot}' },
      cache: true,
      inputs: ['default', '^default', { runtime: 'node --version' }, { runtime: 'git --version' }],
      outputs: [],
    },
    lockfile: {
      command: `node tools/nx/claude-plugin.ts lockfile ${root}`,
      cache: true,
      inputs: [
        '{projectRoot}/package.json',
        '{projectRoot}/package-lock.json',
        '{workspaceRoot}/tools/nx/claude-plugin.ts',
        '{workspaceRoot}/plugins/lz-gardening/skills/lz-garden/scripts/log.ts',
        '{workspaceRoot}/plugins/lz-gardening/skills/lz-garden/scripts/store-git.ts',
        { runtime: 'npm --version' },
      ],
      outputs: [],
    },
    mutate: mutate('*'),
    ...Object.fromEntries(scriptNames.map((script) => [`mutate-${script}`, mutate(script)])),
  };
}

export const createNodes: CreateNodes = [
  'plugins/*/.claude-plugin/plugin.json',
  (manifests, _options, context) =>
    manifests.map((manifest) => {
      const root = dirname(dirname(manifest));
      const plugin: unknown = JSON.parse(readFileSync(join(context.workspaceRoot, manifest), 'utf8'));
      const name = isRecord(plugin) ? plugin['name'] : undefined;

      if (typeof name !== 'string') {
        throw new Error(`${manifest} names no plugin`);
      }

      const targets = pluginTargets(root, scripts(join(context.workspaceRoot, root)));
      const lockfile = readLockfile(join(context.workspaceRoot, root));

      return [
        manifest,
        {
          projects: { [root]: { name, targets } },
          externalNodes: lockfile === undefined ? {} : externalNodes(lockfile),
        },
      ] as const;
    }),
];

const sourceFile = /\.[cm]?[jt]sx?$/;

// Edges come from the project's lockfile, never node_modules: Nx caches a resolved import until the root lockfile
// changes, and installing or bumping a plugin's packages changes no root file.
export const createDependencies: CreateDependencies = (_options, context) =>
  Object.entries(context.filesToProcess.projectFileMap).flatMap(([project, files]) => {
    const root = context.projects[project]?.root ?? '';
    const lockfile = readLockfile(join(context.workspaceRoot, root));

    return files
      .filter(({ file }) => sourceFile.test(file))
      .flatMap(({ file }) => {
        const text = readFileSync(join(context.workspaceRoot, file), 'utf8');
        const targets = ts.preProcessFile(text, true, true).importedFiles.flatMap(({ fileName }) => {
          const packageName = importedPackage(fileName);
          const target =
            packageName === undefined ? undefined : importTarget(packageName, lockfile, context.externalNodes ?? {});

          return target === undefined ? [] : [target];
        });

        return targets.map((target) => ({
          source: project,
          target,
          sourceFile: file,
          type: DependencyType.static,
        }));
      });
  });

function checkLockfile(root: string): number {
  const lockfile = readLockfile(root);

  if (lockfile === undefined) {
    console.error(
      `${root} has no package-lock.json; Claude Code installs nothing without one. Run npm install --prefix ${root}.`,
    );

    return 1;
  }

  const drift = lockfileDrift(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), lockfile);

  if (drift.length > 0) {
    console.error(`${root}: ${drift.join('; ')}. Run npm install --prefix ${root}.`);

    return 1;
  }

  const npm = spawnSync('npm', ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  return npm.status ?? 1;
}

if (import.meta.main) {
  const [command, root] = process.argv.slice(2);

  if (command !== 'lockfile' || root === undefined) {
    console.error('usage: node tools/nx/claude-plugin.ts lockfile <plugin root>');
    process.exitCode = 2;
  } else {
    process.exitCode = checkLockfile(root);
  }
}
