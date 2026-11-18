// The garden site: a clone beside the repository. Its refs/garden/log holds the queue and its refs/garden/census the
// census (see store-log.ts and store-census.ts), both shared with the checkout's origin under the same refs, as are
// the beds of tended closes under refs/garden/beds/<class>; its `garden` branch holds only the .gitignore for the beds.
// Usage, from the repository:
//   node site.ts open [--base <branch>]     create the site if missing, plant the garden log and the writer id if
//                                           missing, sync once, and resolve the base: --base, else the base of the
//                                           census after the sync, else origin's default branch (not asked of an
//                                           origin on a local path), else main, else master; prints {site, created,
//                                           base, seeded, shared} and reason when there is one, seeded once the log
//                                           holds a seed event, shared being the share state: local, synced,
//                                           offline, read-only or behind
//   node site.ts sync [--census <sha> [--seeded]]
//                                           sync with origin, up to 5 tries; with --census, record the census
//                                           census.ts took of <sha> unless the garden's census is of that commit or
//                                           a later one, and with --seeded add the seed event once every seed line
//                                           of that census is queued or declined (else exit 1, naming each line
//                                           left on stderr, and record nothing); prints {shared,
//                                           events} and reason and conflicts when there are any; exit 0 in every
//                                           share state; a census another sync beat to the move stays pending, said
//                                           on stderr
//   node site.ts bed --class <kebab> --base <base>
//                                           sync once, then, while this site holds the claim of the class, fetch
//                                           the base into the site and make the bed beds/<class> on bed/<class>
//                                           from origin's bed of the class when there is one, else from the base,
//                                           or merge origin's bed and the base into the bed that exists; start is
//                                           the base commit fetched; prints {bed, branch, start, created, deps}, deps
//                                           being none, linked (to the checkout's node_modules), installed or
//                                           install, and with install the command that installs the bed's
//                                           dependencies
// Exit 0 on success, 1 when bed cannot check the claim or this site does not hold it, or when sync --census has no
// census of <sha> to record and the garden's census is not of <sha> or a later commit (nothing is synced or seeded
// then), 2 on a usage error, no site, a git error or a site or census it cannot use.
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { escapeUnprintable, isMainModule, printableReason, processIo, runCommand } from './cli.ts';
import { syncNotes } from './sync-notes.ts';
import type { Io } from './cli.ts';
import { claimRefusalLine } from './weeds-claim.ts';
import { closeReaders, configValue, git, objectIds, optionalGit, refTip } from './store-git.ts';
import {
  append,
  logRef,
  plantWriter,
  readLog,
  requireSite,
  siteOf,
  startLog,
  withWriter,
  writerKey,
} from './store-log.ts';
import type { Located, Site } from './store-log.ts';
import { censusRef, holdsCensusCovering, readableCensus } from './store-census.ts';
import { seedLinesIn, seedLinesLeft } from './census.ts';
import { makeBed } from './site-bed.ts';
import type { BedSummary } from './site-bed.ts';
import { sleep, sync, syncTries } from './store-sync.ts';
import type { ShareState, SyncResult } from './store-sync.ts';
import { classPattern, objectIdPattern, replay } from './log.ts';

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

  // A census taken with --base HEAD or a commit id records it too, and that is no base for another clone.
  const recordedBranch = [...facts.branches, ...facts.originBranchNames].find((name) => name === facts.censusRev);

  if (recordedBranch !== undefined) {
    return ref(recordedBranch);
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

export function renameRetrying(
  from: string,
  to: string,
  {
    rename = renameSync,
    wait = sleep,
    platform = process.platform,
  }: {
    readonly rename?: (from: string, to: string) => void;
    readonly wait?: (ms: number) => void;
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

      wait(lockPauseMs);
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
  // Stryker disable next-line CallExpression: equivalent off Windows, which alone keeps a folder a git runs in from moving; a site test fails without it there
  closeReaders(planting);
  renameRetrying(planting, site);
}

function readableCensusRev(site: string): string | undefined {
  if (!existsSync(join(site, '.git'))) {
    return undefined;
  }

  return readableCensus(site, censusRef)?.rev;
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

interface Opened {
  readonly site: string;
  readonly created: boolean;
  readonly base: string;
}

interface OpenSummary extends Opened {
  readonly seeded: boolean;
  readonly shared: ShareState;
  readonly reason: string | undefined;
}

interface SyncSummary {
  readonly shared: ShareState;
  readonly events: number;
  readonly reason: string | undefined;
  readonly conflicts: readonly string[] | undefined;
}

function checkedBase(top: string, site: string, requested: string | undefined): string {
  const base = resolveBase(baseFacts(top, site, requested));

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} has characters a shell would expand; pass --base <branch>`);
  }

  if (refTip(top, `${base}^{commit}`) === undefined) {
    throw new Error(`the base ${base} names no branch or commit in the repository; pass --base <branch>`);
  }

  return base;
}

function openOrPlant(top: string, site: string, requested: string | undefined): Opened {
  const base = checkedBase(top, site, requested);

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

function checkBed(site: string, bedClass: string, base: string): void {
  if (!classPattern.test(bedClass)) {
    throw new Error(`--class must be a kebab-case class id, got ${bedClass}`);
  }

  if (!shellSafeRef.test(base)) {
    throw new Error(`the base ${base} is not a branch name; pass the base site.ts open reported`);
  }

  requireSite(site);
}

function bedRefusal(io: Io, site: Site, bedClass: string, now: Date): string | undefined {
  const shared = sync(site, { attempts: syncTries.quick }, now);
  reportSync(io, shared);

  return claimRefusalLine(site, bedClass, shared, now);
}

/** Appends the seed event once every line of the seed list is queued or declined; returns the lines left. */
function recordSeed(site: Site, sha: string, now: Date): readonly string[] {
  return append(
    site,
    (replica) => {
      if (replay(replica.events, now).seeded) {
        return { drafts: [], left: [] };
      }

      const left = seedLinesLeft(seedLinesIn(site.path, sha), replica.events).map((seed) => seed.line);

      return { drafts: left.length > 0 ? [] : [{ op: 'seed', sha }], left };
    },
    now,
  ).left;
}

type Command =
  | { readonly command: 'open'; readonly base: string | undefined }
  | { readonly command: 'sync'; readonly census: string | undefined; readonly seeded: boolean }
  | { readonly command: 'bed'; readonly bedClass: string; readonly base: string };

function parseCommand(
  positionals: readonly string[],
  values: {
    readonly base?: string | undefined;
    readonly class?: string | undefined;
    readonly census?: string | undefined;
    readonly seeded: boolean;
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
  syncNotes(result).forEach((note) => {
    io.err(`site: ${note}\n`);
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

  const located = siteOf(io.cwd);
  const now = new Date();

  switch (parsed.command) {
    case 'open': {
      return printSummary(io, openCommand(io, located, parsed.base, now));
    }
    case 'sync': {
      requireSite(located.path);

      if (parsed.census !== undefined && !holdsCensusCovering(located, parsed.census)) {
        io.err(`site: no census of ${parsed.census} to record: run census.ts --rev ${parsed.census} first\n`);

        return 1;
      }

      const left =
        parsed.seeded && parsed.census !== undefined ? recordSeed(withWriter(located), parsed.census, now) : [];

      if (left.length > 0) {
        left.forEach((line) => {
          io.err(`site: seed line neither queued nor declined: ${escapeUnprintable(line)}\n`);
        });

        return 1;
      }

      return printSummary(io, syncCommand(io, located, parsed.census, now));
    }
    case 'bed': {
      return bedCommand(io, located, parsed.bedClass, parsed.base, now);
    }
  }
}

function printSummary(io: Io, summary: OpenSummary | SyncSummary | BedSummary): number {
  io.out(`${JSON.stringify(summary)}\n`);

  return 0;
}

function openCommand(io: Io, located: Located, requested: string | undefined, now: Date): OpenSummary {
  const opened = openOrPlant(located.checkout, located.path, requested);
  const shared = sync(withWriter(located), { attempts: syncTries.quick }, now);
  reportSync(io, shared);
  const seeded = replay(readLog(located).events, now).seeded;
  // Without --base, the base can come from the census this sync just fetched.
  const base = requested === undefined ? checkedBase(located.checkout, located.path, undefined) : opened.base;

  return { ...opened, base, seeded, shared: shared.state, reason: printableReason(shared) };
}

function syncCommand(io: Io, located: Located, census: string | undefined, now: Date): SyncSummary {
  const site = withWriter(located);
  const shared = sync(site, { attempts: syncTries.sharing, census }, now);
  reportSync(io, shared);
  shared.skipped.forEach((path) => {
    io.err(`site: skipped ${escapeUnprintable(path)}: not an event file\n`);
  });

  return {
    shared: shared.state,
    events: shared.pushedEvents,
    reason: printableReason(shared),
    conflicts: shared.conflicts.length === 0 ? undefined : shared.conflicts,
  };
}

function bedCommand(io: Io, located: Located, bedClass: string, base: string, now: Date): number {
  checkBed(located.path, bedClass, base);
  const refusal = bedRefusal(io, withWriter(located), bedClass, now);

  if (refusal !== undefined) {
    io.err(`site: bed: ${refusal}\n`);

    return 1;
  }

  return printSummary(io, makeBed(located.checkout, located.path, bedClass, base));
}

export function run(argv: readonly string[], io: Io): number {
  return runCommand('site', io, () => main(argv, io));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), processIo());
}
