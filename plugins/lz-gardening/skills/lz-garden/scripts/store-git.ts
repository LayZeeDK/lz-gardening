// The git process layer of the garden store: every git process the scripts start runs here, in the run's environment
// without the variables that point git at another repository, and every write with no hook and no signing.
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Run {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly gitEnv: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly configs: ReadonlyMap<string, ReadonlyMap<string, string>>;
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

function cleanedGitEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
  // Every variable git lists with --local-env-vars starts with GIT_; the only ones that start with GIT_CONFIG_ are the
  // settings kept below, so an environment with no other GIT_ variable has nothing to drop.
  const localVariables = Object.keys(current.env).some(mayPointAtARepository)
    ? spawnGit(cwd, ['rev-parse', '--local-env-vars'], current.env)
        .stdout.split('\n')
        .filter((name) => !settingsInEnvironment.includes(name))
    : [];

  return {
    ...Object.fromEntries(Object.entries(current.env).filter(([name]) => !localVariables.includes(name))),
    // Stryker disable next-line StringLiteral: git reads an empty boolean as false, so '' turns the hooks off too
    [hookOffVariable]: 'false',
  };
}

export function gitEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
  const env = current.gitEnv ?? cleanedGitEnv(cwd);
  current = { ...current, gitEnv: env };

  return env;
}

// Every write runs no hook, signs nothing, and waits for a ref lock another run of this site may hold for a moment.
const writeSettings = [
  '-c',
  // Stryker disable next-line StringLiteral: the scripts folder itself holds no file named after a git hook either
  `core.hooksPath=${join(dirname(fileURLToPath(import.meta.url)), 'no-hooks')}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.filesRefLockTimeout=3000',
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
  const configs = new Map(current.configs);
  configs.set(cwd, config);
  current = { ...current, configs };

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
  const configs = new Map(current.configs);
  configs.delete(cwd);
  current = { ...current, configs };
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
  const settings = readsOnly ? [] : [...writeSettings, ...namedHooksOff(cwd)];

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
    // The arguments stay out: a fetch or push carries the origin URL, and a token in it.
    throw new Error(`git could not start: ${result.error.message}`);
  }

  return result;
}

interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// The async form of a read, for reads that run side by side. A run's state does not reach work that outlives inRun,
// so the caller takes gitEnv inside the run and passes it in.
export function runGitAsync(cwd: string, args: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    // Stryker disable next-line LzNodeEventName: exit differs from close only when it fires before stdout is fully read, which no test can force
    child.on('close', (code) => {
      resolvePromise({
        // Stryker disable next-line LzJsNumericLiteral: a code is null only when a signal ends git, which no input to the census causes
        code: code ?? 2,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

export async function gitAsync(
  cwd: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  const result = await runGitAsync(cwd, args, env);

  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
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
export function gitReason(stderr: string): string {
  return stderr.trim().split('\n')[0]?.trim() ?? '';
}

// Stryker disable next-line LzJsNumericLiteral: how long a fetch or push may take is policy; the limit is tested through timeoutMs
export const networkTimeoutMs = 60_000;

// Messages are in English, as the porcelain classification reads them.
export function networkGit(site: string, args: readonly string[], timeoutMs: number): SpawnSyncReturns<string> {
  return runGit(site, ['-c', 'credential.interactive=false', ...args], {
    env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    timeout: timeoutMs,
  });
}

interface PushedRef {
  readonly flag: string;
  readonly summary: string;
}

// The tab-separated fields of a porcelain line, split from git's output, reach the summary only on a ref's line.
function holdsSummary(fields: string[]): fields is [string, string, string, ...string[]] {
  return fields[2] !== undefined;
}

// git push --porcelain prints a line per ref, "<flag>\t<from>:<to>\t<summary>", the flag ! for a ref the push left as
// it was; its other lines hold no tab. Each ref's flag and summary, by the ref it pushed to.
export function pushReport(porcelain: string): ReadonlyMap<string, PushedRef> {
  return new Map(
    porcelain
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(holdsSummary)
      .map(([flag, refs, summary]) => [refs.slice(refs.indexOf(':') + 1), { flag, summary }] as const),
  );
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

// The refs under the prefixes given, each name with the object it names. A ref name holds no space.
export function refsUnder(cwd: string, prefixes: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', ...prefixes], { readsOnly: true })
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)] as const),
  );
}

export function objectIds(
  cwd: string,
  names: readonly string[],
  options: Pick<GitInput, 'env'> = {},
): readonly (string | undefined)[] {
  return git(cwd, ['cat-file', '--batch-check=%(objectname)'], {
    ...options,
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

// A blob with its text, an object git does not have, or an object of another type with the header git printed for it.
export type BatchObject =
  | { readonly kind: 'blob'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'other'; readonly header: string };

// Reads each item's object, named by nameOf. An object git does not have prints its header alone ("<name> missing");
// any other prints its size and content. cat-file sizes are in bytes, so the output is read as bytes, a cursor at the
// next header, and each blob decoded on its own.
export function catFileBatch<T>(
  cwd: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): readonly (readonly [T, BatchObject])[] {
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    env: gitEnv(cwd),
    input: items.map((item) => `${nameOf(item)}\n`).join(''),
    maxBuffer: Infinity,
  });

  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch: ${batch.error?.message ?? batch.stderr.toString().trim()}`);
  }

  const output = batch.stdout;

  return items.reduce<{ readonly at: number; readonly read: (readonly [T, BatchObject])[] }>(
    ({ at, read }, item) => {
      const headerEnd = output.indexOf('\n', at);
      const header = output.subarray(at, headerEnd).toString();
      const [, type, size] = header.split(' ');
      const start = headerEnd + 1;

      if (size === undefined) {
        read.push([item, { kind: 'missing' }]);

        return { at: start, read };
      }

      const end = start + Number(size);
      read.push([
        item,
        type === 'blob' ? { kind: 'blob', text: output.subarray(start, end).toString() } : { kind: 'other', header },
      ]);

      return { at: end + 1, read };
    },
    { at: 0, read: [] },
  ).read;
}

// merge-base says no with exit 1; any other failure, an unknown commit included, is an error, not a no.
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = runGit(cwd, args, { readsOnly: true });

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.status === 0;
}

// Yes only for two commits cwd knows: a census's commit may be missing from the checkout, which reads as no, as does
// any other failure.
export function isKnownAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitSucceeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { readsOnly: true });
}
