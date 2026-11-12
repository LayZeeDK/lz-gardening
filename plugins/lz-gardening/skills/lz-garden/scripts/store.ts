import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './census.ts';
import { eventPath, parseEvent, stamp } from './log.ts';
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
}

function runGit(
  cwd: string,
  args: readonly string[],
  { input, env = {}, readsOnly = false }: GitInput = {},
): SpawnSyncReturns<string> {
  const settings = readsOnly ? [] : [...withoutHooksOrSigning, ...namedHooksOff(cwd)];

  return spawnGit(cwd, [...settings, ...args], { ...gitEnv(cwd), ...env }, input);
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>,
  input?: string,
): SpawnSyncReturns<string> {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env, input, maxBuffer: Infinity });

  if (result.error !== undefined) {
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

function commitFiles(
  site: string,
  parent: Pick<Replica, 'tip' | 'lsTreeOutput'> | null,
  files: readonly (readonly [path: string, text: string])[],
): string {
  // Stryker disable next-line StringLiteral: the prefix only names the folder for whoever reads the temp directory
  // Absolute, as git runs in the site: a relative TMPDIR would name a folder beside the checkout.
  const scratch = mkdtempSync(join(resolve(tmpdir()), 'garden-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };

  try {
    const blobFiles = files.map(([, text], index) => {
      const file = join(scratch, `blob-${String(index)}`);
      writeFileSync(file, text);

      return file;
    });
    const oids = git(site, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      input: blobFiles.map((file) => `${file}\n`).join(''),
    }).split('\n');
    const entries = files.map(([path], index) => `100644 ${oids[index] ?? ''}\t${path}\0`);
    git(site, ['update-index', '-z', '--index-info'], { env, input: (parent?.lsTreeOutput ?? '') + entries.join('') });
    const tree = git(site, ['write-tree', '--missing-ok'], { env });

    return git(site, ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent.tip]), '-m', 'garden: log']);
  } finally {
    rmSync(scratch, { recursive: true });
  }
}

export const writerKey = 'lzGardening.writer';

export function startLog(site: string): void {
  const planted = commitFiles(site, null, [['garden.json', JSON.stringify({ format: logFormat })]]);
  git(site, ['update-ref', logRef, planted, '']);
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
  readonly lsTreeOutput: string;
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
  readonly lsTreeOutput: string;
  readonly texts: ReadonlyMap<string, string>;
  readonly skipped: readonly Skipped[];
} {
  const lsTreeOutput = git(site, ['ls-tree', '-r', '-z', commit]);
  const listed = treeEntries(lsTreeOutput);
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

  return { lsTreeOutput, texts, skipped };
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
  const { lsTreeOutput, texts: blobs, skipped } = blobsAt(site, tip);
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
    lsTreeOutput,
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

// Stryker disable next-line LzJsNumericLiteral: how many tries a writer spends is policy; the bound is tested through append's tries
const appendTries = 50;

function moveLogIfStill(site: Site, expected: string, next: string): boolean {
  const moved = runGit(site.path, [
    '-c',
    `core.filesRefLockTimeout=${String(refLockWaitMs)}`,
    'update-ref',
    logRef,
    next,
    expected,
  ]);

  if (moved.status === 0) {
    return true;
  }

  if (git(site.path, ['rev-parse', '--verify', logRef]) === expected) {
    throw new Error(`git update-ref ${logRef}: ${moved.stderr.trim()}`);
  }

  return false;
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

    const maxClock = replica.events.reduce((max, event) => Math.max(max, event.clock), 0);

    if (!Number.isSafeInteger(maxClock + drafts.length)) {
      throw new Error(`${logRef} holds clock ${String(maxClock)}; the next clock would pass the largest whole number`);
    }

    const events = stamp(drafts, maxClock, now);
    const next = commitFiles(
      site.path,
      replica,
      events.map((event) => [eventPath(event.uuid), JSON.stringify(event)]),
    );

    if (moveLogIfStill(site, replica.tip, next)) {
      return result;
    }

    if (attempt >= tries) {
      throw new Error(`${logRef} kept moving; ${String(tries)} tries to append failed`);
    }
  }
}
