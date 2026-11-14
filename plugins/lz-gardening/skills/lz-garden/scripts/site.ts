// The garden site: a clone beside the repository. Its refs/garden/log holds the queue and its refs/garden/census the
// census (see store.ts), both shared with the checkout's origin under the same refs, as are the beds of tended closes
// under refs/garden/beds/<class>; its `garden` branch holds only the .gitignore for the beds.
// Usage, from the repository:
//   node site.ts open [--base <branch>]     create the site if missing, plant the garden log and the writer id if
//                                           missing, resolve the base (--base, else the census's base, else
//                                           origin's default), sync once; prints {site, created, base, seeded,
//                                           shared}, seeded once the log holds a seed event, shared being the share
//                                           state: local, synced, offline, read-only or behind
//   node site.ts sync [--census <sha> [--seeded]]
//                                           sync with origin, up to 5 tries; with --census, record the census
//                                           census.ts took of <sha> unless the garden's census is of that commit or
//                                           a later one, and with --seeded add the seed event; prints {shared,
//                                           events} and reason and conflicts when there are any; exit 0 in every state
//   node site.ts bed --class <kebab> --base <base>
//                                           sync once, then, while this site holds the claim of the class, fetch
//                                           the base into the site and make the bed beds/<class> on bed/<class>
//                                           from origin's bed of the class when there is one, else from the base,
//                                           or merge origin's bed and the base into the bed that exists; start is
//                                           the base commit fetched; prints {bed, branch, start, created, deps}, deps
//                                           being none, linked (to the checkout's node_modules), installed or
//                                           install, and with install the command that installs the bed's
//                                           dependencies
// Exit 0 on success, 1 when bed cannot check the claim or this site does not hold it, 2 on a usage error, a git error
// or a site or census it cannot use.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claimRefusal, escapeUnprintable, isMainModule, processIo, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import type { Site, SyncResult } from './store.ts';
import { classPattern, isRecord, replay } from './log.ts';
import {
  append,
  censusRef,
  configValue,
  fetchedBedRef,
  git,
  gitSucceeds,
  logRef,
  objectIdPattern,
  objectIds,
  openSite,
  optionalGit,
  plantWriter,
  readCensusAt,
  readLog,
  requireSite,
  siteOf,
  startLog,
  sync,
  withWriter,
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
    return ref(facts.censusRev);
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
  startLog({ path: planting, checkout: top });
  renameRetrying(planting, site);
}

function readableCensusRev(site: string): string | undefined {
  if (!existsSync(join(site, '.git'))) {
    return undefined;
  }

  const recorded = readCensusAt(site, censusRef);

  return typeof recorded === 'object' ? recorded?.census.rev : undefined;
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
    censusRev: base === undefined ? readableCensusRev(site) : undefined,
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

    return { site, created: true, base };
  }

  const [garden, log] = objectIds(site, ['refs/heads/garden', logRef]);

  if (garden === undefined) {
    throw new Error(`${site} has no garden branch, so it is not a garden site; move it away and run open again`);
  }

  if (log === undefined) {
    startLog({ path: site, checkout: top });
  }

  plantWriter(site);

  return { site, created: false, base };
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

function checkBed(site: string, bedClass: string, base: string): void {
  if (!classPattern.test(bedClass)) {
    throw new Error(`--class must be a kebab-case class id, got ${bedClass}`);
  }

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} is not a branch name; pass the base site.ts open reported`);
  }

  requireSite(site);
}

function bedRefusal(site: Site, bedClass: string): string | undefined {
  const now = new Date();

  return claimRefusal(site, bedClass, sync(site, { attempts: 1 }, now), now);
}

function mergeInto(bed: string, commitId: string, name: string): void {
  if (!gitSucceeds(bed, ['merge', '-q', '--no-edit', commitId])) {
    gitSucceeds(bed, ['merge', '--abort']);
    throw new Error(`${name} does not merge into ${bed} cleanly; merge it there by hand, then run bed again`);
  }
}

function makeBed(top: string, site: string, bedClass: string, base: string) {
  git(site, ['fetch', '-q', 'origin', base]);
  const branch = `bed/${bedClass}`;
  const branchRef = `refs/heads/${branch}`;
  // Stryker disable next-line StringLiteral: a fetch that succeeded always leaves FETCH_HEAD, so the default never applies
  const [start = '', branchTip, shared] = objectIds(site, ['FETCH_HEAD', branchRef, fetchedBedRef(bedClass)]);
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

    if (shared !== undefined) {
      mergeInto(bed, shared, `origin's ${branch}`);
    }

    mergeInto(bed, start, base);
  } else {
    git(site, ['worktree', 'add', '-q', '-b', branch, bed, shared ?? start]);

    if (shared !== undefined) {
      mergeInto(bed, start, base);
    }
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

function recordSeed(cwd: string, sha: string): void {
  const now = new Date();
  append(
    openSite(cwd),
    (replica) => ({ drafts: replay(replica.events, now).seeded ? [] : [{ op: 'seed', sha }] }),
    now,
  );
}

type Command =
  | { command: 'open'; base: string | undefined }
  | { command: 'sync'; census: string | undefined; seeded: boolean }
  | { command: 'bed'; bedClass: string; base: string };

function parseCommand(
  positionals: readonly string[],
  values: {
    base?: string | undefined;
    class?: string | undefined;
    census?: string | undefined;
    seeded: boolean;
  },
): Command | undefined {
  const [command] = positionals;
  const noCensus = values.census === undefined && !values.seeded;

  if (positionals.length !== 1) {
    return undefined;
  }

  if (command === 'open' && values.class === undefined && noCensus) {
    return { command, base: values.base };
  }

  if (
    command === 'sync' &&
    values.base === undefined &&
    values.class === undefined &&
    (values.census === undefined ? !values.seeded : objectIdPattern.test(values.census))
  ) {
    return { command, census: values.census, seeded: values.seeded };
  }

  if (command === 'bed' && values.class !== undefined && values.base !== undefined && noCensus) {
    return { command, bedClass: values.class, base: values.base };
  }

  return undefined;
}

function reportSync(io: Io, result: SyncResult): void {
  if (result.sharedCensusIgnored === true) {
    io.err(
      `site: the shared ${censusRef} on origin is not a census; it was left out, and the next census replaces it\n`,
    );
  }

  if (result.censusKeptLocal !== undefined) {
    io.err(
      `site: the census of ${escapeUnprintable(result.censusKeptLocal)} stays local: no branch fetched from origin holds that commit\n`,
    );
  }

  result.yielded.forEach(({ claim, owner }) => {
    io.err(`site: gave back the claim of ${claim.class}; ${escapeUnprintable(owner.holder)} holds it\n`);
  });
  result.divergedBeds.forEach((bed) => {
    io.err(`site: ${escapeUnprintable(bed)}\n`);
  });
}

function main(argv: readonly string[], io: Io): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: 'string' },
      class: { type: 'string' },
      census: { type: 'string' },
      seeded: { type: 'boolean', default: false },
    },
  });
  const parsed = parseCommand(positionals, values);

  if (parsed === undefined) {
    io.err(
      'usage: site.ts open [--base <branch>] | site.ts sync [--census <sha> [--seeded]] | site.ts bed --class <kebab> --base <base>\n',
    );

    return 2;
  }

  const { checkout: top, path: site } = siteOf(io.cwd);
  let summary: object;

  switch (parsed.command) {
    case 'open': {
      const opened = openOrPlant(top, site, parsed.base);
      const shared = sync(withWriter({ checkout: top, path: site }), { attempts: 1 });
      reportSync(io, shared);
      const seeded = replay(readLog({ path: site }).events, new Date()).seeded;
      summary = { ...opened, seeded, shared: shared.state };
      break;
    }
    case 'sync': {
      if (parsed.seeded && parsed.census !== undefined) {
        recordSeed(io.cwd, parsed.census);
      }

      const shared = sync(withWriter({ checkout: top, path: site }), { attempts: 5, census: parsed.census });
      reportSync(io, shared);
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
      checkBed(site, parsed.bedClass, parsed.base);
      const refusal = bedRefusal(withWriter({ checkout: top, path: site }), parsed.bedClass);

      if (refusal !== undefined) {
        io.err(`site: bed: ${refusal}\n`);

        return 1;
      }

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
