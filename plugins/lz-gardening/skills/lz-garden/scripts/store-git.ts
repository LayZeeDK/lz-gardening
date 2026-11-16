// The git process layer of the garden store: every git process the scripts start runs here, in the run's environment
// without the variables that point git at another repository, and every write with no hook and no signing.
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { objectIdPattern } from './log.ts';
import { parseContents, readStrategyOf } from './store-git-objects.ts';
import { readerReads, workerPump } from './store-git-reader.ts';
import type { ObjectContents, ObjectReads, ReadAt, TreeEntry } from './store-git-objects.ts';
import type { Located } from './store-log.ts';

interface Run {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly gitEnv: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly configs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly reads: ObjectReads;
}

// One git process per read, the commands the reads have always run.
const spawnReads: ObjectReads = {
  tip: ({ cwd, overrides }, ref) =>
    optionalGit(cwd, ['rev-parse', '--verify', '--quiet', ref], { env: overrides, readsOnly: true }),
  ids: ({ cwd, overrides }, names) =>
    git(cwd, ['cat-file', '--batch-check=%(objectname)'], {
      env: overrides,
      input: names.map((name) => `${name}\n`).join(''),
      readsOnly: true,
    })
      .split('\n')
      .slice(0, names.length)
      .map((line) => (objectIdPattern.test(line) ? line : undefined)),
  contents: (at, items, nameOf) => spawnContents(at, items, nameOf),
  tree: ({ cwd, overrides }, commit) =>
    treeEntries(git(cwd, ['ls-tree', '-r', '-z', commit], { env: overrides, readsOnly: true })),
  close: () => undefined,
};

let current: Run = { env: process.env, gitEnv: undefined, configs: new Map(), reads: spawnReads };
const settingsInEnvironment = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const hookOffVariable = '_LZ_GARDENING_INTERNAL_HOOK_OFF';
// How long a reader's git may go quiet in the middle of an answer, and how long it gets to end at the end of a run.
// Stryker disable next-line LzJsNumericLiteral: a limit one millisecond off reads the same
const readerAnswerMs = 60_000;
// Stryker disable next-line LzJsNumericLiteral: a limit one millisecond off ends the same
const readerEndMs = 5000;

// A run on Windows, where a git start costs 40-100 ms against 2 ms on Linux, reads objects through one long-lived git
// per folder; _LZ_GARDENING_INTERNAL_GIT_READS=spawn|reader picks either anywhere. A run holds no git once it returns
// or throws.
export function inRun<T>(env: Readonly<NodeJS.ProcessEnv>, command: () => T): T {
  const outer = current;
  const reads =
    readStrategyOf(env, process.platform) === 'reader'
      ? readerReads({
          startPump: workerPump,
          envOf: ({ cwd, overrides }) => ({ ...gitEnv(cwd), ...overrides }),
          answerMs: readerAnswerMs,
          endMs: readerEndMs,
        })
      : spawnReads;
  current = { env, gitEnv: undefined, configs: new Map(), reads };

  try {
    return command();
  } finally {
    current = outer;
    reads.close();
  }
}

// Ends the run's gits in the folder, which a rename or delete of the folder needs on Windows; a later read starts anew.
export function closeReaders(cwd: string): void {
  current.reads.close(cwd);
}

// Variables that tell git how to deal with a person, never where a repository is; Claude Code sets both for every command.
const personVariables = ['GIT_EDITOR', 'GIT_OPTIONAL_LOCKS'];

export function mayPointAtARepository(variable: string): boolean {
  return variable.startsWith('GIT_') && !variable.startsWith('GIT_CONFIG_') && !personVariables.includes(variable);
}

function cleanedGitEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
  // Every variable git lists with --local-env-vars starts with GIT_; the only ones that start with GIT_CONFIG_ are the
  // settings kept below, so an environment whose other GIT_ variables all deal with a person has nothing to drop.
  const localVariables = Object.keys(current.env).some(mayPointAtARepository)
    ? spawnGit(cwd, ['rev-parse', '--local-env-vars'], current.env)
        .stdout.split('\n')
        .filter((name) => !settingsInEnvironment.includes(name))
    : // Stryker disable next-line ArrayDeclaration: no environment holds a variable named as the mutant's text, so it drops none either
      [];

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

const writeSettings = [
  '-c',
  // Stryker disable next-line StringLiteral: the scripts folder itself holds no file named after a git hook either
  `core.hooksPath=${join(import.meta.dirname, 'no-hooks')}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'push.gpgSign=false',
  '-c',
  'core.filesRefLockTimeout=3000',
  // The auto maintenance a fetch, merge or commit may start packs refs, which a reader's git can miss for the rest of
  // the run on Windows (ADR 0007).
  '-c',
  'maintenance.auto=false',
];

function configOf(cwd: string): ReadonlyMap<string, string> {
  const cached = current.configs.get(cwd);

  if (cached !== undefined) {
    return cached;
  }

  const args = ['config', '--list', '-z'];
  const listed = spawnGit(cwd, args, gitEnv(cwd));

  if (listed.status !== 0) {
    throw gitFailed(args, listed.stderr);
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

export interface GitInput {
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

  // Stryker disable all: Windows only, so no Linux test tells these mutants apart; on Windows the timed-out push tests of store-sync and store-beds fail without them, and a mutant that ends processes after every git changes only how long a run takes
  if (timedOut(result) && process.platform === 'win32') {
    endProcessesLeftBy(result.pid);
  }

  return result;
}

// A timeout ends only the process spawnSync started. On Windows that is often Git's cmd\git.exe launcher, whose git
// then runs on in the folder until its connection ends; Windows keeps the ended launcher's id as that git's parent.
function endProcessesLeftBy(pid: number): void {
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${String(pid)}' | ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F }`,
    ],
    { stdio: 'ignore' },
  );
}
// Stryker restore all

interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// The async form of a read, for reads that run side by side. A run's state does not reach work that outlives inRun,
// so the caller takes gitEnv inside the run and passes it in.
export async function runGitAsync(
  cwd: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<GitRun> {
  const child = spawn('git', args, { cwd, env });
  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    new Promise<number | null>((resolvePromise, reject) => {
      child.on('error', reject);
      // Stryker disable next-line LzNodeEventName: both streams are read to their end beside it, so exit and close give the same result
      child.on('close', resolvePromise);
    }),
  ]);

  // Stryker disable next-line LzJsNumericLiteral: a code is null only when a signal ends git, which no input to the census causes
  return { code: code ?? 2, stdout, stderr };
}

export async function gitAsync(
  cwd: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  const result = await runGitAsync(cwd, args, env);

  if (result.code !== 0) {
    throw gitFailed(args, result.stderr);
  }

  return result.stdout.trim();
}

// The arguments go into the message, so no caller may pass an origin URL, which can hold a token; fetch and push name
// one only through networkGit, which never throws.
export function gitFailed(args: readonly string[], stderr: string): Error {
  return new Error(`git ${args.join(' ')}: ${stderr.trim()}`);
}

export function git(cwd: string, args: readonly string[], options: GitInput = {}): string {
  const result = runGit(cwd, args, options);

  if (result.status !== 0) {
    throw gitFailed(args, result.stderr);
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
  return stderr.trim().replace(/\n.*/s, '').trim();
}

// Stryker disable next-line LzJsNumericLiteral: how long a fetch or push may take is policy; the limit is tested through timeoutMs
export const networkTimeoutMs = 60_000;

// git's tracing prints the command line, and a token in the origin URL with it, where the reason is read from.
const tracing = /^GIT_(?:TRACE|CURL_VERBOSE$)/;

// Messages are in English, as the porcelain classification reads them.
export function networkGit(
  { path, checkout }: Located,
  args: readonly string[],
  timeoutMs: number,
): SpawnSyncReturns<string> {
  const env = gitEnv(path);
  const tracingOff = Object.keys(env)
    .filter((name) => tracing.test(name))
    .map((name) => [name, undefined] as const);
  // git takes GIT_SSH_COMMAND, then core.sshCommand, then GIT_SSH; ssh asks for a passphrase or a new host key by
  // itself, which batch mode stops.
  const sshCommand =
    env['GIT_SSH_COMMAND'] === undefined
      ? (configValue(checkout, 'core.sshCommand') ??
        configValue(path, 'core.sshCommand') ??
        (env['GIT_SSH'] === undefined ? 'ssh -o BatchMode=yes' : undefined))
      : undefined;
  const ssh = sshCommand === undefined ? [] : ['-c', `core.sshCommand=${sshCommand}`];

  return runGit(path, ['-c', 'credential.interactive=false', ...ssh, ...args], {
    env: { ...Object.fromEntries(tracingOff), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
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

// git push --porcelain prints a line per ref, "<flag>\t<from>:<to>\t<summary>", the flag ! for a ref the push could not
// update; its other lines hold no tab.
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

export function refTip(cwd: string, ref: string): string | undefined {
  return current.reads.tip({ cwd, overrides: {} }, ref);
}

// Another sync of this site may have moved the ref first: to the same commit, which is as good as moving it here, or
// to another, which loses this move. With no from, the ref moves only while it does not exist.
export function moveRefIfStill(cwd: string, ref: string, to: string, from: string | undefined): boolean {
  const args = ['update-ref', ref, to, from ?? ''];
  const moved = runGit(cwd, args);

  if (moved.status === 0) {
    return true;
  }

  const now = refTip(cwd, ref);

  if (now === from) {
    throw gitFailed(args, moved.stderr);
  }

  return now === to;
}

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
  { env = {} }: Pick<GitInput, 'env'> = {},
): readonly (string | undefined)[] {
  return current.reads.ids({ cwd, overrides: env }, names);
}

// Every entry under the commit's tree that is not itself a tree, as `git ls-tree -r` lists them.
export function treeAt(cwd: string, commit: string): readonly TreeEntry[] {
  return current.reads.tree({ cwd, overrides: {} }, commit);
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

// A blob with its text, an object git does not have, or an object of another type.
export type BatchObject =
  | { readonly kind: 'blob'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'other'; readonly type: string };

// Reads each item's object, named by nameOf.
export function catFileBatch<T>(
  cwd: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): readonly (readonly [T, BatchObject])[] {
  return current.reads
    .contents({ cwd, overrides: {} }, items, nameOf)
    .map(([item, answer]) => [item, batchObjectOf(answer)]);
}

function batchObjectOf(answer: ObjectContents): BatchObject {
  if (answer.kind === 'missing') {
    return answer;
  }

  return answer.type === 'blob'
    ? { kind: 'blob', text: answer.bytes.toString() }
    : { kind: 'other', type: answer.type };
}

// cat-file sizes are in bytes, so the output is read as bytes and each object decoded on its own.
function spawnContents<T>(
  { cwd, overrides }: ReadAt,
  items: readonly T[],
  nameOf: (item: T) => string,
): readonly (readonly [T, ObjectContents])[] {
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    env: { ...gitEnv(cwd), ...overrides },
    input: items.map((item) => `${nameOf(item)}\n`).join(''),
    maxBuffer: Infinity,
  });

  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch: ${batch.error?.message ?? batch.stderr.toString().trim()}`);
  }

  const parsed = parseContents(batch.stdout, items, '\n');

  if (!parsed.done) {
    // Stryker disable StringLiteral: the slice holds one name at most, so nothing goes between two
    const waiting = items
      .slice(parsed.answers.length, parsed.answers.length + 1)
      .map(nameOf)
      .join('');
    // Stryker restore StringLiteral
    throw new Error(`git cat-file --batch: the output ends before the object of ${waiting}`);
  }

  return parsed.answers;
}

// merge-base says no with exit 1; any other failure, an unknown commit included, is an error, not a no.
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = runGit(cwd, args, { readsOnly: true });

  if (result.status !== 0 && result.status !== 1) {
    throw gitFailed(args, result.stderr);
  }

  return result.status === 0;
}

// Yes only for two commits cwd knows: a census's commit may be missing from the checkout, which reads as no, as does
// any other failure.
export function isKnownAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitSucceeds(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { readsOnly: true });
}
