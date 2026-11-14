// The git process layer of the garden store: every git process the scripts start runs here, in the run's environment
// without the variables that point git at another repository, and every write with no hook and no signing.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Run {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  gitEnv: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly configs: Map<string, ReadonlyMap<string, string>>;
}

let current: Run = { env: process.env, gitEnv: undefined, configs: new Map() };
const settingsInEnvironment = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const hookOffVariable = 'LZ_GARDEN_HOOK_OFF';

export function inRun<T>(env: Readonly<NodeJS.ProcessEnv>, command: () => T): T {
  const outer = current;
  current = { env, gitEnv: undefined, configs: new Map() };

  try {
    return command();
  } finally {
    current = outer;
  }
}

export function mayPointAtARepository(variable: string): boolean {
  return variable.startsWith('GIT_') && !variable.startsWith('GIT_CONFIG_');
}

export function gitEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
  // Stryker disable next-line ConditionalExpression: the cache only saves a git run within one command
  if (current.gitEnv === undefined) {
    // Every variable git lists with --local-env-vars starts with GIT_; the only ones that start with GIT_CONFIG_ are the
    // settings kept below, so an environment with no other GIT_ variable has nothing to drop.
    const localVariables = Object.keys(current.env).some(mayPointAtARepository)
      ? spawnGit(cwd, ['rev-parse', '--local-env-vars'], current.env)
          .stdout.split('\n')
          .filter((name) => !settingsInEnvironment.includes(name))
      : [];
    current.gitEnv = {
      ...Object.fromEntries(Object.entries(current.env).filter(([name]) => !localVariables.includes(name))),
      // Stryker disable next-line StringLiteral: git reads an empty boolean as false, so '' turns the hooks off too
      [hookOffVariable]: 'false',
    };
  }

  return current.gitEnv;
}

const withoutHooksOrSigning = [
  '-c',
  // Stryker disable next-line StringLiteral: the scripts folder itself holds no file named after a git hook either
  `core.hooksPath=${join(dirname(fileURLToPath(import.meta.url)), 'no-hooks')}`,
  '-c',
  'commit.gpgsign=false',
];

function configOf(cwd: string): ReadonlyMap<string, string> {
  const cached = current.configs.get(cwd);

  if (cached !== undefined) {
    return cached;
  }

  const listed = spawnGit(cwd, ['config', '--list', '-z'], gitEnv(cwd));

  if (listed.status !== 0) {
    throw new Error(`git config --list -z: ${listed.stderr.trim()}`);
  }

  const config = new Map(
    listed.stdout
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        const end = entry.indexOf('\n');

        return end === -1 ? ([entry, ''] as const) : ([entry.slice(0, end), entry.slice(end + 1)] as const);
      }),
  );
  current.configs.set(cwd, config);

  return config;
}

export function configValue(cwd: string, key: string): string | undefined {
  const section = key.indexOf('.');
  const name = key.lastIndexOf('.');

  return configOf(cwd).get(
    key.slice(0, section).toLowerCase() + key.slice(section, name) + key.slice(name).toLowerCase(),
  );
}

/** Reads cwd's git config again on its next use in this run, after a write to it. */
export function forgetConfig(cwd: string): void {
  current.configs.delete(cwd);
}

// A hook set up by name in the git config (hook.<name>.command) ignores core.hooksPath, so each is turned off by name.
// A name may hold any character but NUL: keys are read NUL-separated, and --config-env splits at the last '='.
export function namedHooksOff(cwd: string): readonly string[] {
  const keys = [...configOf(cwd).keys()];
  const names = new Set(keys.flatMap((key) => /^hook\.(.*)\.(?:command|event)$/s.exec(key)?.slice(1) ?? []));

  return [...names].map((name) => `--config-env=hook.${name}.enabled=${hookOffVariable}`);
}

interface GitInput {
  readonly input?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly readsOnly?: boolean;
  readonly timeout?: number;
}

export function runGit(
  cwd: string,
  args: readonly string[],
  { input, env = {}, readsOnly = false, timeout }: GitInput = {},
): SpawnSyncReturns<string> {
  const settings = readsOnly ? [] : [...withoutHooksOrSigning, ...namedHooksOff(cwd)];

  return spawnGit(cwd, [...settings, ...args], { ...gitEnv(cwd), ...env }, input, timeout);
}

export function timedOut(result: SpawnSyncReturns<string>): boolean {
  return result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT';
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  input?: string,
  timeout?: number,
): SpawnSyncReturns<string> {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, input, maxBuffer: Infinity, timeout });

  if (result.error !== undefined && !timedOut(result)) {
    throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  }

  return result;
}

export function git(cwd: string, args: readonly string[], options: GitInput = {}): string {
  const result = runGit(cwd, args, options);

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export function optionalGit(cwd: string, args: readonly string[], options: GitInput = {}): string | undefined {
  const result = runGit(cwd, args, options);

  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function gitSucceeds(cwd: string, args: readonly string[], options: GitInput = {}): boolean {
  return runGit(cwd, args, options).status === 0;
}

/** The first line of git's message, as a reason to print. */
export function reasonOf(stderr: string): string {
  return stderr.trim().split('\n')[0]?.trim() ?? '';
}

// Another run of this site may hold a ref's lock for a moment; a writer waits for it instead of failing.
export const waitForRefLocks = ['-c', 'core.filesRefLockTimeout=3000'];

// Stryker disable next-line LzJsNumericLiteral: how long a fetch or push may take is policy; the limit is tested through timeoutMs
export const networkTimeoutMs = 60_000;

// Messages are in English, as the porcelain classification reads them.
export function networkGit(site: string, args: readonly string[], timeoutMs: number): SpawnSyncReturns<string> {
  return runGit(site, ['-c', 'credential.interactive=false', ...waitForRefLocks, ...args], {
    env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    timeout: timeoutMs,
  });
}

export function mainCheckout(cwd: string): string {
  // Stryker disable next-line StringLiteral: a rev-parse that succeeds prints all three paths, so the default never applies
  const [gitDir, sharedGitDir, top = ''] = git(
    cwd,
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'],
    { readsOnly: true },
  ).split('\n');

  // The worktree list names a checkout made with --separate-git-dir by its git folder, so only a linked worktree reads it.
  if (gitDir === sharedGitDir) {
    return top;
  }

  const list = git(cwd, ['worktree', 'list', '--porcelain'], { readsOnly: true });

  return list.slice('worktree '.length, list.indexOf('\n'));
}

export const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function objectIds(cwd: string, names: readonly string[]): readonly (string | undefined)[] {
  return git(cwd, ['cat-file', '--batch-check=%(objectname)'], {
    input: names.map((name) => `${name}\n`).join(''),
    readsOnly: true,
  })
    .split('\n')
    .map((line) => (objectIdPattern.test(line) ? line : undefined));
}

interface TreeEntry {
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

export function treeEntries(listed: string): readonly TreeEntry[] {
  return listed
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const tab = entry.indexOf('\t');
      // Stryker disable next-line LzJsNumericLiteral: nothing reads the mode, the field the slice's start cuts into
      const fields = entry.slice(0, tab).split(' ');
      // Stryker disable next-line StringLiteral: git prints a type and an object before every tab, so neither default applies
      const [, type = '', oid = ''] = fields;

      return { type, oid, path: entry.slice(tab + 1) };
    });
}

export function blobTexts(site: string, names: readonly string[]): readonly (string | undefined)[] {
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: site,
    env: gitEnv(site),
    input: names.map((name) => `${name}\n`).join(''),
    maxBuffer: Infinity,
  });
  const output = batch.stdout;
  let at = 0;

  return names.map(() => {
    const headerEnd = output.indexOf('\n', at);
    const [, type, size] = output.subarray(at, headerEnd).toString().split(' ');

    if (type !== 'blob') {
      at = headerEnd + 1;

      return undefined;
    }

    const start = headerEnd + 1;
    const end = start + Number(size);
    at = end + 1;

    return output.subarray(start, end).toString();
  });
}

// merge-base says no with exit 1; any other failure is an error, not a no.
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = runGit(cwd, args, { readsOnly: true });

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.status === 0;
}

// A census's commit may be missing from the checkout, which reads as no, as does any other failure.
export function isAncestorInCheckout(checkout: string, ancestor: string, descendant: string): boolean {
  return gitSucceeds(checkout, ['merge-base', '--is-ancestor', ancestor, descendant], { readsOnly: true });
}
