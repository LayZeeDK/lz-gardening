import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './census.ts';
import { eventPath, eventPathPattern, parseEvent, stamp } from './log.ts';
import type { EventDraft, GardenEvent } from './log.ts';

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

function gitEnv(cwd: string): Readonly<NodeJS.ProcessEnv> {
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

function runGit(
  cwd: string,
  args: readonly string[],
  { input, env = {}, readsOnly = false, timeout }: GitInput = {},
): SpawnSyncReturns<string> {
  const settings = readsOnly ? [] : [...withoutHooksOrSigning, ...namedHooksOff(cwd)];

  return spawnGit(cwd, [...settings, ...args], { ...gitEnv(cwd), ...env }, input, timeout);
}

function timedOut(result: SpawnSyncReturns<string>): boolean {
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

function mainCheckout(cwd: string): string {
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

export const logRef = 'refs/garden/log';

const logFormat = 1;

const refLockWaitMs = 3000;

function data(text: string): string {
  return `data ${String(Buffer.byteLength(text))}\n${text}\n`;
}

function identity(site: string, whose: 'author' | 'committer', now: string): string {
  const env = gitEnv(site);
  const variable = `GIT_${whose.toUpperCase()}`;
  const name = env[`${variable}_NAME`] ?? configValue(site, `${whose}.name`) ?? configValue(site, 'user.name');
  const email = env[`${variable}_EMAIL`] ?? configValue(site, `${whose}.email`) ?? configValue(site, 'user.email');

  // Without a configured name or address, git makes one up or refuses; one more git process asks it which.
  if (name === undefined || email === undefined) {
    return `${whose} ${git(site, ['var', `${variable}_IDENT`])}\n`;
  }

  return `${whose} ${name} <${email}> ${env[`${variable}_DATE`] ?? now}\n`;
}

type LogFile = { readonly path: string; readonly text: string } | { readonly path: string; readonly oid: string };

// fast-import moves the ref only by fast-forward, so a commit planned on the tip lands only while the ref names it,
// and a first commit lands only where there is no log. A merge parent adds history, not files: the tree is the tip's
// plus the files given.
function writeLogIfStill(site: string, tip: string | null, files: readonly LogFile[], merge?: string): boolean {
  const now = `@${String(Math.floor(Date.now() / 1000))}`;
  const stream = [
    `commit ${logRef}\n`,
    identity(site, 'author', now),
    identity(site, 'committer', now),
    data('garden: log\n'),
    ...(tip === null ? [] : [`from ${tip}\n`]),
    ...(merge === undefined ? [] : [`merge ${merge}\n`]),
    ...files.map((file) =>
      'oid' in file ? `M 100644 ${file.oid} ${file.path}\n` : `M 100644 inline ${file.path}\n${data(file.text)}`,
    ),
    'done\n',
  ].join('');
  const imported = runGit(
    site,
    [
      '-c',
      `core.filesRefLockTimeout=${String(refLockWaitMs)}`,
      'fast-import',
      '--quiet',
      '--done',
      '--date-format=rfc2822',
    ],
    { input: stream },
  );

  if (imported.status === 0) {
    return true;
  }

  if (tip === null || git(site, ['rev-parse', '--verify', logRef]) === tip) {
    throw new Error(`git fast-import ${logRef}: ${imported.stderr.trim()}`);
  }

  return false;
}

export const writerKey = 'lzGardening.writer';

export function startLog(site: string): void {
  writeLogIfStill(site, null, [{ path: 'garden.json', text: JSON.stringify({ format: logFormat }) }]);
}

export function plantWriter(site: string): void {
  if (configValue(site, writerKey) === undefined) {
    git(site, ['config', writerKey, randomUUID()]);
    current.configs.delete(site);
  }
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

export function siteOf(cwd: string): { readonly checkout: string; readonly path: string } {
  const checkout = resolve(mainCheckout(cwd));

  if (basename(checkout).endsWith('.garden')) {
    throw new Error(`${cwd} is in a garden site or bed; run the garden scripts from the repository's checkout`);
  }

  return { checkout, path: join(dirname(checkout), `${basename(checkout)}.garden`) };
}

export interface Site {
  readonly checkout: string;
  readonly path: string;
  readonly writer: string;
}

export function requireSite(path: string): void {
  if (!existsSync(join(path, '.git'))) {
    throw new Error(`no garden site at ${path}; run site.ts open first`);
  }
}

export function openSite(cwd: string): Site {
  const { checkout, path } = siteOf(cwd);
  requireSite(path);
  const writer = configValue(path, writerKey);

  if (writer === undefined) {
    throw new Error(`no writer id (${writerKey}) at ${path}; run site.ts open first`);
  }

  return { checkout, path, writer };
}

interface Skipped {
  readonly path: string;
  readonly why: string;
}

export interface Replica {
  readonly tip: string;
  readonly events: readonly GardenEvent[];
  readonly skipped: readonly Skipped[];
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

function blobsAt(
  site: string,
  commit: string,
): {
  readonly texts: ReadonlyMap<string, string>;
  readonly skipped: readonly Skipped[];
} {
  const listed = treeEntries(git(site, ['ls-tree', '-r', '-z', commit]));
  const entries = listed.filter(({ type }) => type === 'blob').map(({ oid, path }) => [oid, path] as const);
  const skipped: Skipped[] = listed
    .filter(({ type }) => type !== 'blob')
    .map(({ type, path }) => ({ path, why: `a ${type}, not a file` }));
  // cat-file sizes are in bytes, so the output is read as bytes and each blob decoded on its own.
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: site,
    env: gitEnv(site),
    input: entries.map(([oid]) => `${oid}\n`).join(''),
    maxBuffer: Infinity,
  });

  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch: ${batch.error?.message ?? batch.stderr.toString().trim()}`);
  }

  const output = batch.stdout;
  const texts = new Map<string, string>();
  let at = 0;

  for (const [oid, path] of entries) {
    const headerEnd = output.indexOf('\n', at);
    const header = output.subarray(at, headerEnd).toString();
    const [, type, size] = header.split(' ');

    if (type === 'missing') {
      skipped.push({ path, why: 'missing from the site' });
      at = headerEnd + 1;
      continue;
    }

    if (type !== 'blob') {
      throw new Error(`git cat-file --batch: read ${JSON.stringify(header)} for ${path}, not ${oid} blob <size>`);
    }

    const start = headerEnd + 1;
    const end = start + Number(size);
    texts.set(path, output.subarray(start, end).toString());
    at = end + 1;
  }

  return { texts, skipped };
}

function formatOf(gardenJson: string | undefined): number {
  if (gardenJson === undefined) {
    throw new Error(`${logRef} has no garden.json`);
  }

  let garden: unknown;

  try {
    garden = JSON.parse(gardenJson);
  } catch {
    throw new Error(`${logRef}:garden.json is not JSON`);
  }

  const format = isRecord(garden) ? garden['format'] : undefined;

  if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 1) {
    throw new Error(`${logRef}:garden.json names no log format`);
  }

  return format;
}

function readReplica(site: string, tip: string): Replica {
  const { texts: blobs, skipped } = blobsAt(site, tip);
  const format = formatOf(blobs.get('garden.json'));

  if (format !== logFormat) {
    throw new Error(
      `${logRef} is in format ${JSON.stringify(format)}, which this version cannot read; update lz-gardening`,
    );
  }

  const parsed = [...blobs]
    .filter(([path]) => path !== 'garden.json')
    .map(([path, text]) => ({ path, event: parseEvent(path, text) }));

  return {
    tip,
    events: parsed.flatMap(({ event }) => (typeof event === 'string' ? [] : [event])),
    skipped: [
      ...skipped,
      ...parsed.flatMap(({ path, event }) => (typeof event === 'string' ? [{ path, why: event }] : [])),
    ],
  };
}

export function readLog(site: Site): Replica {
  const tip = optionalGit(site.path, ['rev-parse', '--verify', '--quiet', logRef]);

  if (tip === undefined) {
    throw new Error(`no garden log at ${site.path}; run site.ts open first`);
  }

  return readReplica(site.path, tip);
}

export const shareKey = 'lzGardening.share';

const sharedLogRef = 'refs/garden-shared/log';

// git knows the empty tree of either object format without holding it.
function emptyTreeLike(oid: string): string {
  return oid.length === 64
    ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

interface Change {
  readonly status: string;
  readonly sharedOid: string;
  readonly path: string;
}

// diff-tree -z prints each change as ":<mode> <mode> <oid> <oid> <status>" and its path, NUL after each.
function diffTree(site: string, shared: string, local: string): readonly Change[] {
  const fields = git(site, ['diff-tree', '-r', '--no-renames', '-z', shared, local]).split('\0');

  return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => {
    // Stryker disable next-line StringLiteral: diff-tree prints five fields and a path for every change, so no default applies
    const [meta = '', path = ''] = fields.slice(index * 2, index * 2 + 2);
    // Stryker disable next-line StringLiteral: as above
    const [, , sharedOid = '', , status = ''] = meta.split(' ');

    return { status, sharedOid, path };
  });
}

export type ShareState = 'local' | 'synced' | 'offline' | 'read-only' | 'behind';

export interface SyncResult {
  readonly state: ShareState;
  readonly reason?: string;
  readonly pushedEvents: number;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
}

export interface SyncOptions {
  readonly attempts: number;
  readonly wait?: (ms: number) => void;
  readonly timeoutMs?: number;
}

function reasonOf(stderr: string): string {
  return stderr.trim().split('\n')[0]?.trim() ?? '';
}

// merge-base says no with exit 1; any other failure is an error, not a no.
function isAncestor(site: string, ancestor: string, descendant: string): boolean {
  const args = ['merge-base', '--is-ancestor', ancestor, descendant];
  const result = runGit(site, args, { readsOnly: true });

  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.status === 0;
}

const nothingShared = { pushedEvents: 0, conflicts: [], skipped: [] } as const;

interface Merged {
  readonly upToDate: boolean;
  readonly pushedEvents: number;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
}

function mergeOnce(site: string): Merged | 'lost to another writer' {
  const [shared, local = '', sharedFormatFile, localFormatFile] = objectIds(site, [
    sharedLogRef,
    logRef,
    `${sharedLogRef}^{commit}:garden.json`,
    `${logRef}:garden.json`,
  ]);

  if (shared !== undefined) {
    if (sharedFormatFile === undefined) {
      throw new Error(
        `the shared ${logRef} on origin is not a garden log (a commit holding garden.json); delete or fix it on origin`,
      );
    }

    if (sharedFormatFile !== localFormatFile) {
      const format = formatOf(git(site, ['cat-file', 'blob', sharedFormatFile], { readsOnly: true }));

      if (format !== logFormat) {
        throw new Error(
          `the shared ${logRef} is in format ${String(format)} and this version reads format ${String(logFormat)}; update lz-gardening`,
        );
      }
    }
  }

  if (shared === local) {
    return { upToDate: true, ...nothingShared };
  }

  const changes = diffTree(site, shared ?? emptyTreeLike(local), local);
  const pushedEvents = changes.filter(({ status, path }) => status === 'A' && eventPathPattern.test(path)).length;

  if (shared === undefined || isAncestor(site, shared, local)) {
    return { upToDate: false, ...nothingShared, pushedEvents };
  }

  const fromShared = changes.filter(({ status }) => status !== 'A');
  const copied = fromShared.filter(({ path }) => path === 'garden.json' || eventPathPattern.test(path));
  const conflicts = copied.filter(({ status }) => status === 'M').map(({ path }) => path);
  const skipped = fromShared.filter((change) => !copied.includes(change)).map(({ path }) => path);

  if (copied.length === fromShared.length && !changes.some(({ status }) => status === 'A')) {
    return moveLogIfStill(site, shared, local)
      ? { upToDate: true, pushedEvents: 0, conflicts, skipped }
      : 'lost to another writer';
  }

  return writeLogIfStill(
    site,
    local,
    copied.map(({ path, sharedOid }) => ({ path, oid: sharedOid })),
    shared,
  )
    ? { upToDate: false, pushedEvents, conflicts, skipped }
    : 'lost to another writer';
}

function moveLogIfStill(site: string, to: string, from: string): boolean {
  const args = ['update-ref', logRef, to, from];
  const moved = runGit(site, args);

  if (moved.status !== 0 && git(site, ['rev-parse', '--verify', logRef]) === from) {
    throw new Error(`git ${args.join(' ')}: ${moved.stderr.trim()}`);
  }

  return moved.status === 0;
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a merge spends is policy, as with appendTries
const mergeTries = 50;

function mergeShared(site: string): Merged {
  for (let attempt = 1; ; attempt += 1) {
    const merged = mergeOnce(site);

    if (merged !== 'lost to another writer') {
      return merged;
    }

    if (attempt >= mergeTries) {
      throw new Error(`${logRef} kept moving; ${String(mergeTries)} tries to merge the shared log failed`);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A push lost to another writer: a fast-forward refused by this git, or the remote's ref moved or locked under it.
const lostRace = /\t(?:\[rejected\]|\[remote rejected\] \(.*(?:lock|old value|failed to update))/;

function rejected(porcelain: string): boolean {
  return porcelain.split('\n').some((line) => line.startsWith('!\t') && lostRace.test(line));
}

// A fetch lost to another sync of this site, which held or moved the shared ref first.
const lostSharedRefLock = /cannot lock ref 'refs\/garden-shared\//;

// Stryker disable next-line LzJsNumericLiteral: how long a fetch or push may take is policy; the limit is tested through timeoutMs
const networkTimeoutMs = 60_000;

// Messages are in English, as the porcelain classification reads them.
function networkGit(site: string, args: readonly string[], timeoutMs: number): SpawnSyncReturns<string> {
  return runGit(
    site,
    ['-c', 'credential.interactive=false', '-c', `core.filesRefLockTimeout=${String(refLockWaitMs)}`, ...args],
    { env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, timeout: timeoutMs },
  );
}

export function sync(
  site: Pick<Site, 'checkout' | 'path'>,
  { attempts, wait = sleep, timeoutMs = networkTimeoutMs }: SyncOptions,
): SyncResult {
  const fetchUrl = optionalGit(site.checkout, ['remote', 'get-url', 'origin'], { readsOnly: true });

  if (
    fetchUrl === undefined ||
    git(site.checkout, ['config', '--type=bool', '--default=true', shareKey], { readsOnly: true }) === 'false'
  ) {
    return { state: 'local', ...nothingShared };
  }

  const pushUrl = git(site.checkout, ['remote', 'get-url', '--push', 'origin'], { readsOnly: true });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = syncOnce(site.path, fetchUrl, pushUrl, timeoutMs);

    if (result !== 'lost to another writer') {
      return result;
    }

    if (attempt < attempts) {
      wait(2 ** (attempt - 1) * 1000 * (0.5 + Math.random()));
    }
  }

  return { state: 'behind', ...nothingShared };
}

function syncOnce(
  site: string,
  fetchUrl: string,
  pushUrl: string,
  timeoutMs: number,
): SyncResult | 'lost to another writer' {
  const fetched = networkGit(
    site,
    ['fetch', '--prune', '--no-tags', '--end-of-options', fetchUrl, '+refs/garden/*:refs/garden-shared/*'],
    timeoutMs,
  );

  if (timedOut(fetched)) {
    return { state: 'offline', reason: 'timed out', ...nothingShared };
  }

  if (fetched.status !== 0) {
    return lostSharedRefLock.test(fetched.stderr)
      ? 'lost to another writer'
      : { state: 'offline', reason: reasonOf(fetched.stderr), ...nothingShared };
  }

  const { upToDate, ...merged } = mergeShared(site);

  if (upToDate) {
    return { state: 'synced', ...merged };
  }

  const pushed = networkGit(
    site,
    ['push', '--porcelain', '--end-of-options', pushUrl, `${logRef}:${logRef}`],
    timeoutMs,
  );

  if (timedOut(pushed)) {
    return { state: 'offline', reason: 'timed out', ...nothingShared };
  }

  if (pushed.status === 0) {
    return { state: 'synced', ...merged };
  }

  return rejected(pushed.stdout)
    ? 'lost to another writer'
    : { state: 'read-only', reason: reasonOf(pushed.stderr), ...merged, pushedEvents: 0 };
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a writer spends is policy; the bound is tested through append's tries
const appendTries = 50;

export function append<T>(
  site: Site,
  plan: (replica: Replica) => { readonly drafts: readonly EventDraft[]; readonly result: T },
  now: Date,
  tries = appendTries,
): T {
  for (let attempt = 1; ; attempt += 1) {
    const replica = readLog(site);
    const { drafts, result } = plan(replica);

    if (drafts.length === 0) {
      return result;
    }

    const maxClock = replica.events.reduce((max, event) => Math.max(max, event.clock), 0);

    if (!Number.isSafeInteger(maxClock + drafts.length)) {
      throw new Error(`${logRef} holds clock ${String(maxClock)}; the next clock would pass the largest whole number`);
    }

    const events = stamp(drafts, maxClock, now);

    if (
      writeLogIfStill(
        site.path,
        replica.tip,
        events.map((event) => ({ path: eventPath(event.uuid), text: JSON.stringify(event) })),
      )
    ) {
      return result;
    }

    if (attempt >= tries) {
      throw new Error(`${logRef} kept moving; ${String(tries)} tries to append failed`);
    }
  }
}
