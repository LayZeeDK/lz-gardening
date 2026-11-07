// The garden site: a clone beside the repository whose `garden` branch holds the queue and the census.
// Usage, from the repository:
//   node site.ts open [--base <branch>]     create the site if missing, resolve the base;
//                                           prints {site, created, base, seeded}
//   node site.ts commit --message <text>    commit the site's .garden folder; prints {committed}
// Exit 0 on success, 2 on a usage error, a git error or a site or census it cannot use.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCensus } from './census.ts';

let gitEnvironment: NodeJS.ProcessEnv | undefined;
const settingsInEnvironment = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

// Without the variables that point git at a repository (GIT_DIR from a hook, say), each command acts on its cwd.
// Settings passed in the environment stay.
function gitEnv(): NodeJS.ProcessEnv {
  if (gitEnvironment === undefined) {
    const localVariables = spawnGit(process.cwd(), ['rev-parse', '--local-env-vars'], process.env)
      .stdout.split('\n')
      .filter((name) => !settingsInEnvironment.includes(name));
    gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !localVariables.includes(name)));
  }

  return gitEnvironment;
}

// site.ts runs git only for the garden's own bookkeeping. The user's hooks and commit signing are for their own work,
// and a hook or a signing passphrase would stop a tick that runs unattended. The hooks folder named here does not exist.
const bookkeeping = [
  '-c',
  `core.hooksPath=${join(dirname(fileURLToPath(import.meta.url)), 'no-hooks')}`,
  '-c',
  'commit.gpgsign=false',
];

function runGit(cwd: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnGit(cwd, [...bookkeeping, ...args], gitEnv());
}

function spawnGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });

  if (result.error !== undefined) {
    throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  }

  return result;
}

function git(cwd: string, args: readonly string[]): string {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

function optionalGit(cwd: string, args: readonly string[]): string | undefined {
  const result = runGit(cwd, args);

  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitSucceeds(cwd: string, args: readonly string[]): boolean {
  return runGit(cwd, args).status === 0;
}

export interface BaseFacts {
  readonly base: string | undefined;
  readonly censusRev: string | undefined;
  readonly originHead: string | undefined;
  readonly originIsLocal: boolean;
  readonly branches: readonly string[];
  readonly originBranchNames: readonly string[];
}

export function resolveBase(facts: BaseFacts): string {
  const originOnly = (name: string): boolean =>
    !facts.branches.includes(name) && facts.originBranchNames.includes(name);
  const ref = (name: string): string => (originOnly(name) ? `origin/${name}` : name);

  if (facts.base !== undefined) {
    return ref(facts.base);
  }

  if (facts.censusRev !== undefined) {
    return facts.censusRev;
  }

  // A clone of a local path takes its origin/HEAD from whatever the source had checked out.
  if (facts.originHead !== undefined && !facts.originIsLocal) {
    return ref(facts.originHead);
  }

  return ref(facts.branches.includes('main') || originOnly('main') ? 'main' : 'master');
}

function repositoryIdentity(top: string): readonly (readonly [string, string])[] {
  const identity = ['user.name', 'user.email'].map((key) => [key, optionalGit(top, ['config', key]) ?? ''] as const);
  const missing = identity.find(([, value]) => value === '');

  if (missing !== undefined) {
    throw new Error(`the repository has no ${missing[0]}; set it so the garden commits carry its owner's identity`);
  }

  return identity;
}

// The codes Windows gives a rename while another program, such as a virus scanner, holds a file in the folder.
const lockCodes: readonly unknown[] = ['EPERM', 'EBUSY', 'EACCES'];

function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
}

export function renameRetrying(
  from: string,
  to: string,
  {
    rename = renameSync,
    wait = pause,
    platform = process.platform,
  }: {
    readonly rename?: (from: string, to: string) => void;
    readonly wait?: () => void;
    readonly platform?: NodeJS.Platform;
  } = {},
): void {
  for (let tries = 1; ; tries += 1) {
    try {
      rename(from, to);

      return;
    } catch (error: unknown) {
      const locked =
        platform === 'win32' && error instanceof Error && 'code' in error && lockCodes.includes(error.code);

      if (!locked || tries === 20) {
        throw error;
      }

      wait();
    }
  }
}

function plant(top: string, site: string): void {
  if (existsSync(site)) {
    throw new Error(`${site} is not a garden site; move it away, and the next tick plants the site there`);
  }

  const identity = repositoryIdentity(top);
  const planting = `${site}.planting`;
  rmSync(planting, { recursive: true, force: true });
  git(dirname(top), ['clone', '-q', '--no-checkout', top, planting]);

  for (const [key, value] of identity) {
    git(planting, ['config', key, value]);
  }

  git(planting, ['switch', '-q', '--orphan', 'garden']);
  writeFileSync(join(planting, '.gitignore'), '/beds/\n');
  git(planting, ['add', '.gitignore']);
  git(planting, ['commit', '-q', '-m', 'garden: plant']);
  renameRetrying(planting, site);
}

function baseFacts(top: string, site: string, base: string | undefined): BaseFacts {
  const originUrl = optionalGit(top, ['remote', 'get-url', 'origin']);

  return {
    originIsLocal: originUrl !== undefined && (originUrl.startsWith('file:') || existsSync(resolve(top, originUrl))),
    base,
    censusRev: base === undefined ? readCensus(join(site, '.garden', 'census.json'))?.census.rev : undefined,
    originHead: optionalGit(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(
      /^origin\//,
      '',
    ),
    branches: git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
    originBranchNames: git(top, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
      .split('\n')
      .map((ref) => ref.replace('refs/remotes/origin/', ''))
      .filter((name) => name !== '' && name !== 'HEAD'),
  };
}

const shellSafeRef = /^[\w.+@][\w./+@-]*$/;

function openSite(top: string, site: string, requested: string | undefined): object {
  const base = resolveBase(baseFacts(top, site, requested));

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} has characters a shell would expand; pass --base <branch>`);
  }

  if (!gitSucceeds(top, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) {
    throw new Error(`the base ${base} names no branch or commit in the repository; pass --base <branch>`);
  }

  const created = !existsSync(join(site, '.git'));

  if (created) {
    plant(top, site);
  }

  const seeded = git(site, ['rev-list', '--count', 'garden']) !== '1';

  return { site, created, base, seeded };
}

function commitSite(site: string, message: string): object {
  if (!existsSync(join(site, '.git'))) {
    throw new Error(`no garden site at ${site}; run site.ts open first`);
  }

  if (git(site, ['branch', '--show-current']) !== 'garden') {
    throw new Error(
      `the site at ${site} is not on the garden branch; it was not planted fully, so remove it and run site.ts open`,
    );
  }

  git(site, ['add', '.garden']);
  const nothingStaged = gitSucceeds(site, ['diff', '--cached', '--quiet']);

  if (nothingStaged) {
    return { committed: false };
  }

  git(site, ['commit', '-q', '-m', message]);

  return { committed: true };
}

function mainCheckout(cwd: string): string {
  const [gitDir, sharedGitDir] = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--absolute-git-dir',
    '--git-common-dir',
  ]).split('\n');

  if (gitDir === sharedGitDir) {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  }

  // A linked worktree finds the main checkout first in the worktree list.
  const [first = ''] = git(cwd, ['worktree', 'list', '--porcelain']).split('\n', 1);

  return first.replace(/^worktree /, '');
}

function main(argv: readonly string[], cwd: string): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: { base: { type: 'string' }, message: { type: 'string', default: '' } },
  });
  const [command] = positionals;

  const wellFormed =
    positionals.length === 1 &&
    ((command === 'open' && values.message === '') ||
      (command === 'commit' && values.message !== '' && values.base === undefined));

  if (!wellFormed) {
    process.stderr.write('usage: site.ts open [--base <branch>] | site.ts commit --message <text>\n');

    return 2;
  }

  const top = resolve(mainCheckout(cwd));

  if (basename(top).endsWith('.garden')) {
    throw new Error(`${cwd} is in a garden site or bed; run site.ts from the repository's checkout`);
  }

  const site = join(dirname(top), `${basename(top)}.garden`);
  const summary = command === 'commit' ? commitSite(site, values.message) : openSite(top, site, values.base);
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  return 0;
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
if (
  process.argv[1] &&
  realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main(process.argv.slice(2), process.cwd());
  } catch (error: unknown) {
    process.stderr.write(`site: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
