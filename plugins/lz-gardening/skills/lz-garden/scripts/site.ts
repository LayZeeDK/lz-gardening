// The garden site: a clone beside the repository. Its `garden` branch holds the census; its refs/garden/log holds the
// queue (see store.ts), shared with the checkout's origin under the same ref.
// Usage, from the repository:
//   node site.ts open [--base <branch>]     create the site if missing, plant the garden log and the writer id if
//                                           missing, resolve the base, sync the garden log once; prints
//                                           {site, created, base, seeded, shared}, shared being the share state:
//                                           local, synced, offline, read-only or behind
//   node site.ts sync                       sync the garden log with origin, up to 5 tries; prints {shared, events}
//                                           and reason and conflicts when there are any; exit 0 in every state
//   node site.ts commit --message <text>    commit the site's .garden folder; prints {committed}
//   node site.ts bed --class <kebab> --base <base>
//                                           fetch the base into the site and make the bed beds/<class> on
//                                           bed/<class>, or merge the base into the bed that exists; start is the
//                                           base commit fetched; prints {bed, branch, start, created, deps}, deps being
//                                           none, linked (to the checkout's node_modules), installed or install,
//                                           and with install the command that installs the bed's dependencies
// Exit 0 on success, 2 on a usage error, a git error or a site or census it cannot use.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord, readCensus } from './census.ts';
import { escapeUnprintable, isMainModule, processIo, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import { classPattern } from './log.ts';
import {
  configValue,
  git,
  gitSucceeds,
  logRef,
  objectIds,
  optionalGit,
  plantWriter,
  requireSite,
  siteOf,
  startLog,
  sync,
  writerKey,
} from './store.ts';

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
  const identity = ['user.name', 'user.email'].map((key) => [key, configValue(top, key) ?? ''] as const);
  const missing = identity.find(([, value]) => value === '');

  if (missing !== undefined) {
    throw new Error(`the repository has no ${missing[0]}; set it so the garden commits carry its owner's identity`);
  }

  return identity;
}

// The codes Windows gives a rename while another program, such as a virus scanner, holds a file in the folder.
const lockCodes: readonly unknown[] = ['EPERM', 'EBUSY', 'EACCES'];
const lockTries = 20;
// Stryker disable next-line LzJsNumericLiteral: how long a try waits is policy; no result depends on a millisecond more or less
const lockPauseMs = 250;

function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lockPauseMs);
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

      if (!locked || tries === lockTries) {
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
  git(top, [
    'clone',
    '-q',
    '--no-checkout',
    ...[...identity, [writerKey, randomUUID()] as const].flatMap(([key, value]) => ['-c', `${key}=${value}`]),
    top,
    planting,
  ]);
  git(planting, ['switch', '-q', '--orphan', 'garden']);
  writeFileSync(join(planting, '.gitignore'), '/beds/\n');
  git(planting, ['add', '.gitignore']);
  // A maintenance run the commit starts in the background would hold files in the folder the rename moves next.
  git(planting, ['-c', 'maintenance.auto=false', 'commit', '-q', '-m', 'garden: plant']);
  startLog(planting);
  renameRetrying(planting, site);
}

function baseFacts(top: string, site: string, base: string | undefined): BaseFacts {
  const originUrl = optionalGit(top, ['remote', 'get-url', 'origin'], { readsOnly: true });
  const targetOf = new Map(
    git(top, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes/origin'], {
      readsOnly: true,
    })
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('\0')), line.slice(line.indexOf('\0') + 1)] as const),
  );
  const under = (prefix: string): readonly string[] =>
    [...targetOf.keys()].filter((ref) => ref.startsWith(prefix)).map((ref) => ref.slice(prefix.length));
  const originPrefix = 'refs/remotes/origin/';
  const originHeadTarget = targetOf.get(`${originPrefix}HEAD`);

  return {
    originIsLocal: originUrl !== undefined && (originUrl.startsWith('file:') || existsSync(resolve(top, originUrl))),
    base,
    censusRev: base === undefined ? readCensus(join(site, '.garden', 'census.json'))?.census.rev : undefined,
    originHead: originHeadTarget?.startsWith(originPrefix) ? originHeadTarget.slice(originPrefix.length) : undefined,
    branches: under('refs/heads/'),
    originBranchNames: under(originPrefix).filter((name) => name !== 'HEAD'),
  };
}

const shellSafeRef = /^[\w.+@][\w./+@-]*$/;

function openOrPlant(top: string, site: string, requested: string | undefined) {
  const base = resolveBase(baseFacts(top, site, requested));

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} has characters a shell would expand; pass --base <branch>`);
  }

  if (!gitSucceeds(top, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { readsOnly: true })) {
    throw new Error(`the base ${base} names no branch or commit in the repository; pass --base <branch>`);
  }

  if (!existsSync(join(site, '.git'))) {
    plant(top, site);

    return { site, created: true, base, seeded: false };
  }

  const [garden, seed, log] = objectIds(site, ['refs/heads/garden', 'refs/heads/garden~1', logRef]);

  if (garden === undefined) {
    throw new Error(`${site} has no garden branch, so it is not a garden site; move it away and run open again`);
  }

  if (log === undefined) {
    startLog(site);
  }

  plantWriter(site);

  return { site, created: false, base, seeded: seed !== undefined };
}

const installs: readonly (readonly [lockfile: string, command: (bed: string) => string])[] = [
  ['pnpm-lock.yaml', (bed) => `pnpm -C "${bed}" install --frozen-lockfile`],
  ['yarn.lock', (bed) => `yarn --cwd "${bed}" install --frozen-lockfile`],
  ['package-lock.json', (bed) => `npm --prefix "${bed}" ci`],
];
const lockfiles = installs.map(([lockfile]) => lockfile);

function installCommand(bed: string): string {
  const found = installs.find(([lockfile]) => existsSync(join(bed, lockfile)));

  return found === undefined ? `npm --prefix "${bed}" install` : found[1](bed);
}

// The bed's lockfile comes from the base, so only a plain file is read: a link can name any file, a FIFO hangs.
function sameBytes(checkout: string, bed: string): boolean {
  return (
    existsSync(checkout) &&
    lstatSync(bed, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(checkout).equals(readFileSync(bed))
  );
}

function declaresWorkspaces(dir: string): boolean {
  const file = join(dir, 'package.json');
  let manifest: unknown;

  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }

  return (isRecord(manifest) && 'workspaces' in manifest) || existsSync(join(dir, 'pnpm-workspace.yaml'));
}

function commitSite(site: string, message: string) {
  requireSite(site);

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

function makeBed(top: string, site: string, bedClass: string, base: string) {
  if (!classPattern.test(bedClass)) {
    throw new Error(`--class must be a kebab-case class id, got ${bedClass}`);
  }

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} is not a branch name; pass the base site.ts open reported`);
  }

  requireSite(site);
  git(site, ['fetch', '-q', 'origin', base]);
  const branch = `bed/${bedClass}`;
  const branchRef = `refs/heads/${branch}`;
  // Stryker disable next-line StringLiteral: a fetch that succeeded always leaves FETCH_HEAD, so the default never applies
  const [start = '', branchTip] = objectIds(site, ['FETCH_HEAD', branchRef]);
  const bed = join(site, 'beds', bedClass);
  const hasBranch = branchTip !== undefined;
  const entry = lstatSync(bed, { throwIfNoEntry: false });

  if (
    entry !== undefined &&
    (!hasBranch || !entry.isDirectory() || optionalGit(bed, ['symbolic-ref', '-q', 'HEAD']) !== branchRef)
  ) {
    throw new Error(`${bed} is not the worktree of ${branch}; move it aside, then run bed again`);
  }

  if (hasBranch) {
    if (entry === undefined) {
      git(site, ['worktree', 'prune']);
      git(site, ['worktree', 'add', '-q', bed, branch]);
    }

    if (gitSucceeds(bed, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      throw new Error(`a merge is in progress in ${bed}; finish or abort it, then run bed again`);
    }

    if (!gitSucceeds(bed, ['merge', '-q', '--no-edit', start])) {
      gitSucceeds(bed, ['merge', '--abort']);
      throw new Error(`${base} does not merge into ${bed} cleanly; merge it there by hand, then run bed again`);
    }
  } else {
    git(site, ['worktree', 'add', '-q', '-b', branch, bed, start]);
  }

  const deps = plantDeps(top, bed);

  return {
    bed,
    branch,
    start,
    created: !hasBranch,
    deps,
    install: deps === 'install' ? installCommand(bed) : undefined,
  };
}

function sharesLockfile(top: string, bed: string): boolean {
  return lockfiles.some((name) => sameBytes(join(top, name), join(bed, name)));
}

function plantDeps(top: string, bed: string): 'none' | 'linked' | 'installed' | 'install' {
  const entry = lstatSync(join(bed, 'node_modules'), { throwIfNoEntry: false });

  if (entry !== undefined) {
    if (!entry.isSymbolicLink()) {
      return 'installed';
    }

    if (sharesLockfile(top, bed)) {
      return 'linked';
    }

    rmSync(join(bed, 'node_modules'));

    return 'install';
  }

  if (existsSync(join(bed, '.pnp.cjs'))) {
    return 'installed';
  }

  if (!existsSync(join(bed, 'package.json'))) {
    return 'none';
  }

  const linkable = existsSync(join(top, 'node_modules')) && sharesLockfile(top, bed) && !declaresWorkspaces(bed);

  if (!linkable) {
    return 'install';
  }

  symlinkSync(join(top, 'node_modules'), join(bed, 'node_modules'), 'junction');

  return 'linked';
}

type Command =
  | { command: 'open'; base: string | undefined }
  | { command: 'commit'; message: string }
  | { command: 'sync' }
  | { command: 'bed'; bedClass: string; base: string };

function parseCommand(
  positionals: readonly string[],
  values: { base?: string | undefined; class?: string | undefined; message: string },
): Command | undefined {
  const [command] = positionals;

  if (positionals.length !== 1) {
    return undefined;
  }

  if (command === 'open' && values.message === '' && values.class === undefined) {
    return { command, base: values.base };
  }

  if (command === 'commit' && values.message !== '' && values.base === undefined && values.class === undefined) {
    return { command, message: values.message };
  }

  if (command === 'sync' && values.message === '' && values.base === undefined && values.class === undefined) {
    return { command };
  }

  if (command === 'bed' && values.class !== undefined && values.base !== undefined && values.message === '') {
    return { command, bedClass: values.class, base: values.base };
  }

  return undefined;
}

function main(argv: readonly string[], io: Io): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: { base: { type: 'string' }, class: { type: 'string' }, message: { type: 'string', default: '' } },
  });
  const parsed = parseCommand(positionals, values);

  if (parsed === undefined) {
    io.err(
      'usage: site.ts open [--base <branch>] | site.ts sync | site.ts commit --message <text> | site.ts bed --class <kebab> --base <base>\n',
    );

    return 2;
  }

  const { checkout: top, path: site } = siteOf(io.cwd);
  let summary: object;

  switch (parsed.command) {
    case 'open': {
      const opened = openOrPlant(top, site, parsed.base);
      summary = { ...opened, shared: sync({ checkout: top, path: site }, { attempts: 1 }).state };
      break;
    }
    case 'commit': {
      summary = commitSite(site, parsed.message);
      break;
    }
    case 'sync': {
      const shared = sync({ checkout: top, path: site }, { attempts: 5 });
      shared.skipped.forEach((path) => {
        io.err(`site: skipped ${escapeUnprintable(path)}: not an event file\n`);
      });
      summary = {
        shared: shared.state,
        events: shared.pushedEvents,
        reason: shared.reason === undefined ? undefined : escapeUnprintable(shared.reason),
        conflicts: shared.conflicts.length === 0 ? undefined : shared.conflicts,
      };
      break;
    }
    case 'bed': {
      summary = makeBed(top, site, parsed.bedClass, parsed.base);
      break;
    }
  }

  io.out(`${JSON.stringify(summary)}\n`);

  return 0;
}

export function run(argv: readonly string[], io: Io): number {
  return runCommand('site', io, () => main(argv, io));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), processIo());
}
