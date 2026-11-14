import { spawnSync } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CreateDependencies, CreateNodes, ProjectGraphExternalNode, TargetConfiguration } from '@nx/devkit';
import { DependencyType } from '@nx/devkit';
import ts from 'typescript';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

interface InstalledPackage {
  readonly version: string;
  readonly hash: string;
}

export interface Lockfile {
  readonly root: unknown;
  readonly installed: Readonly<Record<string, InstalledPackage>>;
}

const installed = 'node_modules/';

export function parseLockfile(value: unknown, path: string): Lockfile {
  if (!isRecord(value) || value['lockfileVersion'] !== 3 || !isRecord(value['packages'])) {
    throw new Error(`${path} is not an npm lockfile of version 3`);
  }

  const { packages } = value;

  return {
    root: packages[''],
    installed: Object.fromEntries(
      Object.entries(packages).flatMap(([key, entry]) => {
        const version = isRecord(entry) ? entry['version'] : undefined;
        const integrity = isRecord(entry) ? entry['integrity'] : undefined;

        return key.startsWith(installed) && typeof version === 'string'
          ? [[key, { version, hash: typeof integrity === 'string' ? integrity : version }]]
          : [];
      }),
    ),
  };
}

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8');

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error });
  }
}

function readLockfile(folder: string): Lockfile | undefined {
  const path = join(folder, 'package-lock.json');

  return existsSync(path) ? parseLockfile(readJson(path), path) : undefined;
}

export function externalNodes(lockfile: Lockfile): Record<string, ProjectGraphExternalNode> {
  return Object.fromEntries(
    Object.entries(lockfile.installed).map(([key, { version, hash }]) => {
      const packageName = key.slice(key.lastIndexOf(installed) + installed.length);
      const name = `npm:${packageName}@${version}` as const;

      return [name, { type: 'npm', name, data: { packageName, version, hash } }];
    }),
  );
}

export function importedPackage(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) {
    return undefined;
  }

  const [first = '', second = ''] = specifier.split('/');

  return first.startsWith('@') ? `${first}/${second}` : first;
}

export function importTarget(
  packageName: string,
  lockfile: Lockfile | undefined,
  workspaceNodes: Readonly<Record<string, unknown>>,
): string | undefined {
  const version = lockfile?.installed[`${installed}${packageName}`]?.version;

  if (version !== undefined) {
    return `npm:${packageName}@${version}`;
  }

  const hoisted = `npm:${packageName}`;

  return hoisted in workspaceNodes ? hoisted : undefined;
}

export function lockfileDrift(packageJson: unknown, lockfile: Lockfile): readonly string[] {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

  return sections.flatMap((section) => {
    const sectionOf = (record: unknown): unknown => (isRecord(record) ? record[section] : undefined) ?? {};
    const declared = sectionOf(packageJson);
    const locked = sectionOf(lockfile.root);

    return isDeepStrictEqual(declared, locked)
      ? []
      : [`package.json ${section} ${JSON.stringify(declared)} but package-lock.json ${JSON.stringify(locked)}`];
  });
}

function scripts(pluginRoot: string): readonly string[] {
  const files = globSync('skills/*/scripts/*.ts', { cwd: pluginRoot })
    .map((path) => basename(path))
    .filter((file) => !file.endsWith('.test.ts') && !file.startsWith('test-'));

  return [...new Set(files.map((file) => basename(file, '.ts').split('-')[0] ?? file))].sort();
}

function mutate(script: string): TargetConfiguration {
  return {
    command: 'node --conditions=@layzee/source node_modules/@stryker-mutator/core/bin/stryker.js run',
    options: { env: { MUTATE: script } },
    cache: false,
    parallelism: false,
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
        '{workspaceRoot}/plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts',
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
      const plugin = readJson(join(context.workspaceRoot, manifest));
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

  const drift = lockfileDrift(readJson(join(root, 'package.json')), lockfile);

  if (drift.length > 0) {
    console.error(`${root}: ${drift.join('; ')}. Run npm install --prefix ${root}.`);

    return 1;
  }

  // One constant command string: Node.js deprecates an argument array with shell, which Windows needs for npm.cmd.
  const npm = spawnSync('npm ci --dry-run --ignore-scripts --no-audit --no-fund', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
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
