import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bedCommit,
  eventPath,
  eventPathPattern,
  isRecord,
  latestTendedClose,
  losingClaims,
  parseEvent,
  stamp,
} from './log.ts';
import type { ClaimEvent, EventDraft, GardenEvent, LostClaim } from './log.ts';

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

function identity(checkout: string, whose: 'author' | 'committer', now: string): string {
  const variable = `GIT_${whose.toUpperCase()}`;
  const name = configValue(checkout, 'lzGardening.name');
  const email = configValue(checkout, 'lzGardening.email');
  const signer = name === undefined || email === undefined ? 'lz-gardening <>' : `${name} <${email}>`;

  return `${whose} ${signer} ${gitEnv(checkout)[`${variable}_DATE`] ?? now}\n`;
}

type LogFile = { readonly path: string; readonly text: string } | { readonly path: string; readonly oid: string };

// fast-import moves the ref only by fast-forward, so a commit planned on the tip lands only while the ref names it,
// and a first commit lands only where there is no log. A merge parent adds history, not files: the tree is the tip's
// plus the files given.
function writeLogIfStill(
  { path: site, checkout }: Pick<Site, 'path' | 'checkout'>,
  tip: string | null,
  files: readonly LogFile[],
  merge?: string,
): boolean {
  const now = `@${String(Math.floor(Date.now() / 1000))} +0000`;
  const stream = [
    `commit ${logRef}\n`,
    identity(checkout, 'author', now),
    identity(checkout, 'committer', now),
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

export function startLog(site: Pick<Site, 'path' | 'checkout'>): void {
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

  return withWriter({ checkout, path });
}

export function withWriter({ checkout, path }: Pick<Site, 'checkout' | 'path'>): Site {
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
  const listed = treeEntries(git(site, ['ls-tree', '-r', '-z', commit], { readsOnly: true }));
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

export function readLog(site: Pick<Site, 'path'>): Replica {
  const tip = optionalGit(site.path, ['rev-parse', '--verify', '--quiet', logRef], { readsOnly: true });

  if (tip === undefined) {
    throw new Error(`no garden log at ${site.path}; run site.ts open first`);
  }

  return readReplica(site.path, tip);
}

export const shareKey = 'lzGardening.share';

const sharedLogRef = 'refs/garden-shared/log';

const sharedCensusRef = 'refs/garden-shared/census';

// git knows the empty tree of either object format without holding it.
function emptyTreeLike(oid: string): string {
  return oid.length === 64
    ? '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
    : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

interface Change {
  readonly status: string;
  readonly sharedOid: string;
  readonly localOid: string;
  readonly path: string;
}

// diff-tree -z prints each change as ":<mode> <mode> <oid> <oid> <status>" and its path, NUL after each.
function diffTree(site: string, shared: string, local: string): readonly Change[] {
  const fields = git(site, ['diff-tree', '-r', '--no-renames', '-z', shared, local]).split('\0');

  return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => {
    // Stryker disable next-line StringLiteral: diff-tree prints five fields and a path for every change, so no default applies
    const [meta = '', path = ''] = fields.slice(index * 2, index * 2 + 2);
    // Stryker disable next-line StringLiteral: as above
    const [, , sharedOid = '', localOid = '', status = ''] = meta.split(' ');

    return { status, sharedOid, localOid, path };
  });
}

export type ShareState = 'local' | 'synced' | 'offline' | 'read-only' | 'behind';

export interface SyncResult {
  readonly state: ShareState;
  readonly reason?: string;
  readonly pushedEvents: number;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
  readonly sharedCensusIgnored?: boolean;
  readonly yielded: readonly LostClaim[];
  readonly divergedBeds: readonly string[];
  readonly censusKeptLocal?: string;
}

export interface SyncOptions {
  readonly attempts: number;
  readonly wait?: ((ms: number) => void) | undefined;
  readonly timeoutMs?: number;
  readonly census?: string | undefined;
  readonly look?: typeof losingClaims;
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

const nothingShared = { pushedEvents: 0, conflicts: [], skipped: [], yielded: [], divergedBeds: [] } as const;

interface Leaving {
  readonly path: string;
  readonly localOid: string;
}

interface Merged {
  readonly upToDate: boolean;
  readonly pushedEvents: number;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
  readonly leaving: readonly Leaving[];
}

interface Tips {
  readonly shared: string | undefined;
  readonly local: string;
  readonly sharedFormatFile: string | undefined;
  readonly localFormatFile: string | undefined;
}

function mergeOnce(
  { path: site, checkout }: Pick<Site, 'path' | 'checkout'>,
  { shared, local, sharedFormatFile, localFormatFile }: Tips,
): Merged | 'lost to another writer' {
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
    return { upToDate: true, ...nothingShared, leaving: [] };
  }

  const changes = diffTree(site, shared ?? emptyTreeLike(local), local);
  const leaving = changes
    .filter(({ status, path }) => status === 'A' && eventPathPattern.test(path))
    .map(({ path, localOid }) => ({ path, localOid }));
  const pushedEvents = leaving.length;

  if (shared === undefined || isAncestor(site, shared, local)) {
    return { upToDate: false, ...nothingShared, pushedEvents, leaving };
  }

  const fromShared = changes.filter(({ status }) => status !== 'A');
  const copied = fromShared.filter(({ path }) => path === 'garden.json' || eventPathPattern.test(path));
  const conflicts = copied.filter(({ status }) => status === 'M').map(({ path }) => path);
  const skipped = fromShared.filter((change) => !copied.includes(change)).map(({ path }) => path);

  if (copied.length === fromShared.length && !changes.some(({ status }) => status === 'A')) {
    return moveLogIfStill(site, shared, local)
      ? { upToDate: true, pushedEvents: 0, conflicts, skipped, leaving: [] }
      : 'lost to another writer';
  }

  return writeLogIfStill(
    { path: site, checkout },
    local,
    copied.map(({ path, sharedOid }) => ({ path, oid: sharedOid })),
    shared,
  )
    ? { upToDate: false, pushedEvents, conflicts, skipped, leaving }
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

interface CensusTips {
  readonly local: string | undefined;
  readonly shared: string | undefined;
}

function mergeShared(
  site: Pick<Site, 'path' | 'checkout'>,
): Merged & { readonly census: CensusTips; readonly sharedTip: string | undefined } {
  for (let attempt = 1; ; attempt += 1) {
    const [shared, local = '', sharedFormatFile, localFormatFile, localCensus, sharedCensus] = objectIds(site.path, [
      sharedLogRef,
      logRef,
      `${sharedLogRef}^{commit}:garden.json`,
      `${logRef}:garden.json`,
      censusRef,
      sharedCensusRef,
    ]);
    const merged = mergeOnce(site, { shared, local, sharedFormatFile, localFormatFile });

    if (merged !== 'lost to another writer') {
      return { ...merged, census: { local: localCensus, shared: sharedCensus }, sharedTip: shared };
    }

    if (attempt >= mergeTries) {
      throw new Error(`${logRef} kept moving; ${String(mergeTries)} tries to merge the shared log failed`);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A push lost to another writer: a fast-forward or lease refused by this git, or the remote's ref moved or locked
// under it, which an atomic push reports as a failed transaction.
const lostRace =
  /\t(?:\[rejected\]|\[remote rejected\] \(.*(?:lock|old value|failed to update|atomic transaction failed))/;

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

export function isShared(result: SyncResult): boolean {
  return result.state === 'synced' || result.state === 'local';
}

export function sync(site: Site, options: SyncOptions, now = new Date()): SyncResult {
  const result = syncWithOrigin(site, options, now);

  if (options.census !== undefined) {
    finishPendingCensus(site, options.census);
  }

  return result;
}

function finishPendingCensus(site: Site, pendingSha: string): void {
  const recorded = recordPendingCensus(site, pendingSha);
  const pendingPrefix = pendingCensusRef('');
  const leftovers = git(site.path, ['for-each-ref', '--format=%(refname) %(objectname)', pendingPrefix], {
    readsOnly: true,
  })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(' '));
  const deletes = leftovers.filter(([name = '']) => {
    const sha = name.slice(pendingPrefix.length);

    return sha === pendingSha || (recorded.sha !== undefined && isAncestorInCheckout(site, sha, recorded.sha));
  });
  git(site.path, ['update-ref', '--stdin'], {
    input: deletes.map(([name = '', oid = '']) => `delete ${name} ${oid}\n`).join(''),
  });
}

function syncWithOrigin(
  site: Site,
  { attempts, wait = sleep, timeoutMs = networkTimeoutMs, census: pendingSha, look = losingClaims }: SyncOptions,
  now: Date,
): SyncResult {
  const fetchUrl = optionalGit(site.checkout, ['remote', 'get-url', 'origin'], { readsOnly: true });

  if (
    fetchUrl === undefined ||
    git(site.checkout, ['config', '--type=bool', '--default=true', shareKey], { readsOnly: true }) === 'false'
  ) {
    return { state: 'local', ...nothingShared };
  }

  const pushUrl = git(site.checkout, ['remote', 'get-url', '--push', 'origin'], { readsOnly: true });
  const yielded: LostClaim[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = syncOnce(site, { fetchUrl, pushUrl, timeoutMs, pendingSha, look, now, yielded });

    if (result !== 'lost to another writer') {
      return { ...result, yielded };
    }

    if (attempt < attempts) {
      wait(2 ** (attempt - 1) * 1000 * (0.5 + Math.random()));
    }
  }

  return { state: 'behind', ...nothingShared, yielded };
}

interface Attempt {
  readonly fetchUrl: string;
  readonly pushUrl: string;
  readonly timeoutMs: number;
  readonly pendingSha: string | undefined;
  readonly look: typeof losingClaims;
  readonly now: Date;
  readonly yielded: LostClaim[];
}

function giveBackLosingClaims(
  site: Site,
  sharedTip: string | undefined,
  leaving: readonly Leaving[],
  { look, now, yielded }: Attempt,
): number {
  if (leaving.length === 0) {
    return 0;
  }

  const events = blobTexts(
    site.path,
    leaving.map(({ localOid }) => localOid),
  ).flatMap((text, index) => {
    const event = parseEvent(leaving[index]?.path ?? '', text ?? '');

    return typeof event === 'string' ? [] : [event];
  });
  const released = new Set(events.flatMap((event) => (event.op === 'release' ? [event.claim] : [])));
  const mine = events.filter(
    (event): event is ClaimEvent =>
      event.op === 'claim' &&
      event.writer === site.writer &&
      !released.has(event.uuid) &&
      Date.parse(event.until) > now.getTime(),
  );

  if (mine.length === 0) {
    return 0;
  }

  const lost = look(sharedTip === undefined ? [] : readReplica(site.path, sharedTip).events, mine, site.writer, now);

  if (lost.length === 0) {
    return 0;
  }

  yielded.push(...lost);

  return append(
    site,
    (replica) => {
      const releasedHere = new Set(replica.events.flatMap((event) => (event.op === 'release' ? [event.claim] : [])));
      const drafts = lost
        .filter(({ claim }) => !releasedHere.has(claim.uuid))
        .map(({ claim }): EventDraft => ({ op: 'release', class: claim.class, claim: claim.uuid }));

      return { drafts, result: drafts.length };
    },
    now,
  );
}

function censusOffOrigin(site: Site, ref: string): string | undefined {
  const sha = censusIn(site.path, ref)?.sha;

  if (sha === undefined) {
    return undefined;
  }

  const holders = optionalGit(
    site.checkout,
    ['for-each-ref', '--count=1', '--format=%(refname)', `--contains=${sha}`, 'refs/remotes/origin/'],
    { readsOnly: true },
  );

  return holders === undefined || holders === '' ? sha : undefined;
}

function syncOnce(site: Site, attempt: Attempt): Omit<SyncResult, 'yielded'> | 'lost to another writer' {
  const { path } = site;
  const { fetchUrl, pushUrl, timeoutMs, pendingSha } = attempt;
  const fetched = networkGit(
    path,
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

  const { upToDate, census: censusTips, sharedTip, leaving, ...mergedLog } = mergeShared(site);
  const releases = giveBackLosingClaims(site, sharedTip, leaving, attempt);
  const settled = settleCensus(site, censusTips, pendingSha);
  const pushedEvents = mergedLog.pushedEvents + releases;
  const newerCensus = settled.local === censusTips.shared ? undefined : settled.local;
  const keptLocal = newerCensus === undefined ? undefined : censusOffOrigin(site, newerCensus);
  const censusAhead = newerCensus !== undefined && keptLocal === undefined;
  const merged = {
    ...mergedLog,
    pushedEvents,
    ...(settled.ignored ? { sharedCensusIgnored: true } : {}),
    ...(keptLocal === undefined ? {} : { censusKeptLocal: keptLocal }),
  };

  if (upToDate && !censusAhead) {
    return { state: 'synced', ...merged, divergedBeds: pushBeds(site, leaving, attempt) };
  }

  const pushed = networkGit(
    path,
    [
      'push',
      '--porcelain',
      '--atomic',
      ...(censusAhead ? [leaseOnFetchedCensus(censusTips.shared)] : []),
      '--end-of-options',
      pushUrl,
      ...(upToDate ? [] : [`${logRef}:${logRef}`]),
      ...(censusAhead ? [`${censusRef}:${censusRef}`] : []),
    ],
    timeoutMs,
  );

  if (timedOut(pushed)) {
    return { state: 'offline', reason: 'timed out', ...nothingShared };
  }

  if (pushed.status === 0) {
    return { state: 'synced', ...merged, divergedBeds: pushBeds(site, leaving, attempt) };
  }

  return rejected(pushed.stdout)
    ? 'lost to another writer'
    : { state: 'read-only', reason: reasonOf(pushed.stderr), ...merged, pushedEvents: 0, divergedBeds: [] };
}

const bedBranches = 'refs/heads/bed/';

const sharedBeds = 'refs/garden-shared/beds/';

export function fetchedBedRef(weedClass: string): string {
  return `${sharedBeds}${weedClass}`;
}

function sharedBedRef(weedClass: string): string {
  return `refs/garden/beds/${weedClass}`;
}

// A hunk's lines are counted from its header, so no line inside it is taken for a header by how its text starts. A
// merge's combined diff (--cc) marks each line once per parent; a line with no - is in the result, and one with a +
// is new to some parent. A commit starts with a NUL and its id, and its message ends at a NUL, which no message holds.
function readBedLog(log: string): { readonly commits: readonly string[]; readonly added: readonly string[] } {
  const commits: string[] = [];
  const added: string[] = [];
  let inMessage = false;
  let parents = 1;
  let left = 0;

  log.split('\n').forEach((line) => {
    if (inMessage) {
      const end = line.indexOf('\0');
      added.push(end === -1 ? line : line.slice(0, end));
      inMessage = end === -1;

      return;
    }

    if (left === 0 && line.startsWith('\0')) {
      commits.push(line.slice(1));
      inMessage = true;

      return;
    }

    if (left === 0) {
      const hunk = /^(@@+) (?:-\d+(?:,\d+)? )+\+\d+(?:,(\d+))? \1/.exec(line);
      parents = (hunk?.[1]?.length ?? 2) - 1;
      left = hunk === null ? 0 : Number(hunk[2] ?? '1');

      return;
    }

    const marks = line.slice(0, parents);

    if (!marks.includes('-') && !line.startsWith('\\')) {
      left -= 1;

      if (marks.includes('+')) {
        added.push(line.slice(parents));
      }
    }
  });

  return { commits, added };
}

function bedStaysLocal(site: Site, tip: string, shared: string | undefined): string | undefined {
  const lent = { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(site.path, '.git', 'objects'), GIT_NO_LAZY_FETCH: '1' };
  const { commits, added } = readBedLog(
    git(
      site.checkout,
      [
        'log',
        '-p',
        '--cc',
        '--text',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%x00%H%n%B%x00',
        tip,
        '--not',
        '--remotes=origin',
        ...(shared === undefined ? [] : [shared]),
      ],
      { readsOnly: true, env: lent },
    ),
  );
  // The bed's own commits were made in the site, so the checkout lacks them; one it holds came from somewhere else.
  const held = git(site.checkout, ['cat-file', '--batch-check=%(objectname)'], {
    input: commits.map((commit) => `${commit}\n`).join(''),
    readsOnly: true,
    env: { GIT_NO_LAZY_FETCH: '1' },
  });

  if (held.split('\n').some((line) => objectIdPattern.test(line))) {
    return 'stays local: its base is on no branch fetched from origin';
  }

  return added.some(machinePathTest(site)) ? 'stays local: it holds a path on this machine' : undefined;
}

function pushBeds(site: Site, leaving: readonly Leaving[], { pushUrl, timeoutMs }: Attempt): readonly string[] {
  const tips = git(site.path, ['for-each-ref', '--format=%(refname) %(objectname)', bedBranches, sharedBeds], {
    readsOnly: true,
  })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(' '));
  const tipOf = (prefix: string, weedClass: string): string | undefined =>
    tips.find(([name]) => name === `${prefix}${weedClass}`)?.[1];
  const candidates = tips.flatMap(([name = '', oid = '']) => {
    const weedClass = name.slice(bedBranches.length);

    return name.startsWith(bedBranches) && tipOf(sharedBeds, weedClass) !== oid ? [{ weedClass, tip: oid }] : [];
  });

  if (candidates.length === 0) {
    return [];
  }

  const { events } = readReplica(site.path, logRef);
  const leavingPaths = new Set(leaving.map(({ path }) => path));
  const judged = candidates.flatMap((bed) => {
    const close = latestTendedClose(events, bed.weedClass);
    const shared = tipOf(sharedBeds, bed.weedClass);

    if (close === undefined || !bed.tip.startsWith(bedCommit(close))) {
      return [];
    }

    if (shared === undefined) {
      return leavingPaths.has(eventPath(close.uuid)) ? [{ ...bed, descends: true }] : [];
    }

    return [{ ...bed, descends: isAncestor(site.path, shared, bed.tip) }];
  });
  const kept = judged.flatMap((bed) => {
    const why = bed.descends
      ? bedStaysLocal(site, bed.tip, tipOf(sharedBeds, bed.weedClass))
      : `does not descend from origin's bed`;

    return why === undefined ? [] : [{ ...bed, why }];
  });
  const pushing = judged.filter((bed) => !kept.some(({ weedClass }) => weedClass === bed.weedClass));
  const diverged = kept.map(({ weedClass, why }) => `${weedClass}: bed/${weedClass} ${why}`);

  if (pushing.length === 0) {
    return diverged;
  }

  const pushed = networkGit(
    site.path,
    [
      'push',
      '--porcelain',
      '--end-of-options',
      pushUrl,
      ...pushing.map(({ weedClass, tip }) => `${tip}:${sharedBedRef(weedClass)}`),
    ],
    timeoutMs,
  );
  // A porcelain line per ref: "<flag>\t<from>:<to>\t<summary>", the flag ! for a ref the push left as it was.
  const refused = pushed.stdout.split('\n').flatMap((line) => {
    const [flag, refs = '', summary = ''] = line.split('\t');
    const weedClass = refs.slice(refs.indexOf(':') + 1).slice(sharedBedRef('').length);

    return flag === '!' ? [`${weedClass}: ${summary}`] : [];
  });

  return [...diverged, ...refused];
}

export const censusRef = 'refs/garden/census';

function leaseOnFetchedCensus(fetched: string | undefined): string {
  return `--force-with-lease=${censusRef}:${fetched ?? ''}`;
}

export function pendingCensusRef(sha: string): string {
  return `refs/garden/pending/${sha}`;
}

export interface Census {
  readonly rev: string;
  readonly sha: string;
  readonly takenAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly hits: Readonly<Record<string, readonly string[]>>;
  readonly duplicates: Readonly<Record<string, readonly string[]>>;
}

export function parseCensus(json: unknown): Census | null {
  if (!isRecord(json) || !isRecord(json['counts']) || !isRecord(json['hits'])) {
    return null;
  }

  const { rev, sha, takenAt } = json;

  if (typeof rev !== 'string' || typeof sha !== 'string' || typeof takenAt !== 'string') {
    return null;
  }

  const counts: Record<string, number> = {};

  for (const [id, count] of Object.entries(json['counts'])) {
    if (typeof count === 'number') {
      counts[id] = count;
    }
  }

  return {
    rev,
    sha,
    takenAt,
    counts,
    hits: stringLists(json['hits']),
    duplicates: stringLists(json['duplicates']),
  };
}

function stringLists(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, list]) =>
      Array.isArray(list) ? [[key, list.filter((item): item is string => typeof item === 'string')] as const] : [],
    ),
  );
}

export interface StoredCensus {
  readonly census: Census;
  readonly text: string;
  readonly patterns: string | undefined;
}

export function writePendingCensus(site: string, sha: string, text: string, patterns?: string): void {
  const now = `@${String(Math.floor(Date.now() / 1000))} +0000`;
  const checkout = site.slice(0, -'.garden'.length);
  const stream = [
    `commit ${pendingCensusRef(sha)}\n`,
    identity(checkout, 'author', now),
    identity(checkout, 'committer', now),
    data('garden: census\n'),
    `M 100644 inline census.json\n${data(text)}`,
    ...(patterns === undefined ? [] : [`M 100644 inline patterns.json\n${data(patterns)}`]),
    'done\n',
  ].join('');
  git(site, ['fast-import', '--quiet', '--done', '--force', '--date-format=rfc2822'], { input: stream });
}

function blobTexts(site: string, names: readonly string[]): readonly (string | undefined)[] {
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

export function readCensusAt(site: string, ref: string): StoredCensus | null | 'not a census' {
  const [text, patterns] = blobTexts(site, [`${ref}:census.json`, `${ref}:patterns.json`]);

  if (text === undefined) {
    return null;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return 'not a census';
  }

  const census = parseCensus(json);

  return census === null ? 'not a census' : { census, text, patterns };
}

function isAncestorInCheckout(site: Pick<Site, 'checkout'>, ancestor: string, descendant: string): boolean {
  return gitSucceeds(site.checkout, ['merge-base', '--is-ancestor', ancestor, descendant], { readsOnly: true });
}

interface Recorded {
  readonly local: string | undefined;
  readonly sha: string | undefined;
}

function recordPendingCensus(site: Pick<Site, 'checkout' | 'path'>, pendingSha: string): Recorded {
  const [pending, local] = objectIds(site.path, [pendingCensusRef(pendingSha), censusRef]);
  const current = local === undefined ? undefined : censusIn(site.path, local);

  if (pending === undefined || (current !== undefined && isAncestorInCheckout(site, pendingSha, current.sha))) {
    return { local, sha: current?.sha };
  }

  git(site.path, ['update-ref', censusRef, pending, local ?? '']);

  return { local: pending, sha: pendingSha };
}

function localCensusIsNewer(site: Pick<Site, 'checkout' | 'path'>, local: string | undefined, theirs: Census): boolean {
  const mine = local === undefined ? undefined : censusIn(site.path, local);

  return mine !== undefined && mine.sha !== theirs.sha && isAncestorInCheckout(site, theirs.sha, mine.sha);
}

function censusIn(site: string, ref: string): Census | undefined {
  const read = readCensusAt(site, ref);

  return typeof read === 'object' && read !== null ? read.census : undefined;
}

function settleCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  tips: CensusTips,
  pendingSha: string | undefined,
): Settled {
  const adopted = adoptSharedCensus(site, tips);

  if (pendingSha === undefined) {
    return adopted;
  }

  return { ...adopted, local: recordPendingCensus(site, pendingSha).local };
}

interface Settled {
  readonly local: string | undefined;
  readonly ignored: boolean;
}

function adoptSharedCensus(site: Pick<Site, 'checkout' | 'path'>, { local, shared }: CensusTips): Settled {
  if (shared === undefined || shared === local) {
    return { local, ignored: false };
  }

  const theirs = censusIn(site.path, shared);

  if (theirs === undefined) {
    return { local, ignored: true };
  }

  if (localCensusIsNewer(site, local, theirs)) {
    return { local, ignored: false };
  }

  git(site.path, ['update-ref', censusRef, shared, local ?? '']);

  return { local: shared, ignored: false };
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a writer spends is policy; the bound is tested through append's tries
const appendTries = 50;

function machinePathTest(site: Pick<Site, 'checkout' | 'path'>): (text: string) => boolean {
  const fold = (text: string): string => text.replaceAll(/[\\/]+/g, '/').toLowerCase();
  const paths = [homedir(), site.checkout, site.path]
    .map((path) => fold(path).replace(/\/+$/, ''))
    .filter((path) => !/^(?:[a-z]:)?$/.test(path))
    // Git Bash writes d:/x as /d/x, and WSL's /mnt/d/x and Cygwin's /cygdrive/d/x hold that too.
    .flatMap((path) => [path, path.replace(/^([a-z]):\//, '/$1/')]);
  const holds = (text: string, path: string): boolean => {
    for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
      if (!/[\w.-]/.test(text.charAt(at - 1)) && !/[\w.-]/.test(text.charAt(at + path.length))) {
        return true;
      }
    }

    return false;
  };

  return (text) => paths.some((path) => holds(fold(text), path));
}

function refuseMachinePaths(site: Site, drafts: readonly EventDraft[]): void {
  const holdsMachinePath = machinePathTest(site);

  for (const draft of drafts) {
    for (const [field, value] of Object.entries(draft)) {
      if (typeof value === 'string' && holdsMachinePath(value)) {
        throw new Error(
          `the ${field} holds a path on this machine; the queue is shared with the repository, so write paths repository-relative`,
        );
      }
    }
  }
}

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

    refuseMachinePaths(site, drafts);

    const maxClock = replica.events.reduce((max, event) => Math.max(max, event.clock), 0);

    if (!Number.isSafeInteger(maxClock + drafts.length)) {
      throw new Error(`${logRef} holds clock ${String(maxClock)}; the next clock would pass the largest whole number`);
    }

    const events = stamp(drafts, maxClock, now);

    if (
      writeLogIfStill(
        site,
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
