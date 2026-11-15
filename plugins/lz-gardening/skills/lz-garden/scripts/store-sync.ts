// Sharing with origin: fetch origin's garden refs, merge its log into the site's, give back claims a sync lost, settle
// the census, and push the log, the census and the beds.
import { eventPathPattern, parseEvent, planGiveBack, releasesOfLostClaims } from './log.ts';
import type { LostClaim } from './log.ts';
import { markUnpushed, planBeds, pushBeds } from './store-beds.ts';
import { censusRef, finishPendingCensus, leaseOnFetchedCensus, localCensusOf, settleCensus } from './store-census.ts';
import type { CensusTips, Recorded } from './store-census.ts';
import {
  catFileBatch,
  git,
  gitReason,
  isAncestor,
  networkGit,
  networkTimeoutMs,
  objectIds,
  optionalGit,
  pushReport,
  timedOut,
} from './store-git.ts';
import {
  append,
  formatOf,
  logFormat,
  logRef,
  lostToAnotherWriter,
  moveLogIfStill,
  noLogAt,
  readReplica,
  writeLogIfStill,
} from './store-log.ts';
import type { Located, LostToAnotherWriter, Site } from './store-log.ts';

const shareKey = 'lzGardening.share';

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
  const fields = git(site, ['diff-tree', '-r', '--no-renames', '-z', shared, local], { readsOnly: true }).split('\0');

  return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => {
    // Stryker disable next-line StringLiteral: diff-tree prints five fields and a path for every change, so no default applies
    const [meta = '', path = ''] = fields.slice(index * 2, index * 2 + 2);
    // Stryker disable next-line StringLiteral: as above
    const [, , sharedOid = '', localOid = '', status = ''] = meta.split(' ');

    return { status, sharedOid, localOid, path };
  });
}

interface Outcome {
  readonly pushedEvents: number;
  readonly conflicts: readonly string[];
  readonly skipped: readonly string[];
  readonly yielded: readonly LostClaim[];
  readonly divergedBeds: readonly string[];
  readonly censusStillPending?: string;
}

interface WithoutCensusNotes extends Outcome {
  readonly sharedCensusIgnored?: undefined;
  readonly censusKeptLocal?: undefined;
  readonly localCensusUnreadable?: undefined;
}

interface WithCensusNotes extends Outcome {
  readonly sharedCensusIgnored?: boolean;
  readonly censusKeptLocal?: string;
  readonly localCensusUnreadable?: boolean;
}

export type SyncResult =
  | (WithoutCensusNotes & { readonly state: 'local'; readonly reason?: undefined })
  | (WithoutCensusNotes & { readonly state: 'behind'; readonly reason: string })
  | (WithoutCensusNotes & { readonly state: 'offline'; readonly reason: string })
  | (WithCensusNotes & { readonly state: 'read-only'; readonly reason: string })
  | (WithCensusNotes & { readonly state: 'synced'; readonly reason?: undefined });

export type ShareState = SyncResult['state'];

export interface SyncOptions {
  readonly attempts: number;
  readonly wait?: ((ms: number) => void) | undefined;
  readonly timeoutMs?: number;
  readonly census?: string | undefined;
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

function refuseUnreadableSharedLog(site: string, { shared, sharedFormatFile, localFormatFile }: Tips): void {
  if (shared === undefined) {
    return;
  }

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

const nothingMerged = { pushedEvents: 0, conflicts: [], skipped: [] } as const;

function mergeOnce(site: Located, tips: Tips): Merged | LostToAnotherWriter {
  refuseUnreadableSharedLog(site.path, tips);
  const { shared, local } = tips;

  if (shared === local) {
    return { upToDate: true, ...nothingMerged, leaving: [] };
  }

  const changes = diffTree(site.path, shared ?? emptyTreeLike(local), local);
  const leaving = changes
    .filter(({ status, path }) => status === 'A' && eventPathPattern.test(path))
    .map(({ path, localOid }) => ({ path, localOid }));
  const pushedEvents = leaving.length;

  if (shared === undefined || isAncestor(site.path, shared, local)) {
    return { upToDate: false, ...nothingMerged, pushedEvents, leaving };
  }

  const fromShared = changes.filter(({ status }) => status !== 'A');
  const copied = fromShared.filter(({ path }) => path === 'garden.json' || eventPathPattern.test(path));
  const conflicts = copied.filter(({ status }) => status === 'M').map(({ path }) => path);
  const skipped = fromShared.filter((change) => !copied.includes(change)).map(({ path }) => path);
  const localAddsNothing = !changes.some(({ status }) => status === 'A');

  if (copied.length === fromShared.length && localAddsNothing) {
    return moveLogIfStill(site.path, shared, local)
      ? { upToDate: true, pushedEvents: 0, conflicts, skipped, leaving: [] }
      : lostToAnotherWriter;
  }

  return writeLogIfStill(
    site,
    local,
    copied.map(({ path, sharedOid }) => ({ path, oid: sharedOid })),
    shared,
  )
    ? { upToDate: false, pushedEvents, conflicts, skipped, leaving }
    : lostToAnotherWriter;
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a merge spends is policy; the bound is tested through mergeShared's tries
const mergeTries = 50;

export function mergeShared(
  site: Located,
  tries = mergeTries,
): Merged & { readonly census: CensusTips; readonly sharedTip: string | undefined } {
  for (let attempt = 1; ; attempt += 1) {
    const [shared, local, sharedFormatFile, localFormatFile, localCensus, sharedCensus] = objectIds(site.path, [
      sharedLogRef,
      logRef,
      `${sharedLogRef}^{commit}:garden.json`,
      `${logRef}:garden.json`,
      censusRef,
      sharedCensusRef,
    ]);

    if (local === undefined) {
      throw noLogAt(site.path);
    }

    const merged = mergeOnce(site, { shared, local, sharedFormatFile, localFormatFile });

    if (merged !== lostToAnotherWriter) {
      return { ...merged, census: { local: localCensus, shared: sharedCensus }, sharedTip: shared };
    }

    if (attempt >= tries) {
      throw new Error(`${logRef} kept moving; ${String(tries)} tries to merge the shared log failed`);
    }
  }
}

export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A push lost to another writer: a fast-forward or lease refused by this git, or the remote's ref moved or locked
// under it, which an atomic push reports as a failed transaction. Only a ref the push left as it was has such a summary.
const lostRace =
  /\[rejected\]|\[remote rejected\] \(.*(?:cannot lock ref|old value|failed to update|atomic transaction failed)/;

export function lostRaceOf(porcelain: string): string | undefined {
  const lost = [...pushReport(porcelain)].find(([, { summary }]) => lostRace.test(summary));

  return lost === undefined ? undefined : `${lost[0]}: ${lost[1].summary}`;
}

function declined(porcelain: string): boolean {
  return [...pushReport(porcelain).values()].some(({ flag }) => flag === '!');
}

// A fetch lost to another sync of this site, which held or moved the shared ref first.
const lostSharedRefLock = /cannot lock ref 'refs\/garden-shared\//;

// How many tries a command's sync spends: one for a quick look at origin, before planning or after a share already
// failed, and more, each after a longer wait, to share what the command wrote.
export const syncTries = {
  // Stryker disable next-line LzJsNumericLiteral: how many tries a sync spends is policy; the bound is tested through attempts
  quick: 1,
  // Stryker disable next-line LzJsNumericLiteral: as above
  sharing: 5,
} as const;

export function isShared(result: SyncResult): boolean {
  return result.state === 'synced' || result.state === 'local';
}

export function sync(site: Site, options: SyncOptions, now = new Date()): SyncResult {
  const { result, recorded } = syncWithOrigin(site, options, now);

  const lost =
    options.census !== undefined && finishPendingCensus(site, options.census, recorded) === lostToAnotherWriter;

  return lost ? { ...result, censusStillPending: options.census } : result;
}

// What a try that settled the census recorded of the pending one.
type Tried = SyncResult & { readonly recorded?: Recorded | undefined };

function syncWithOrigin(
  site: Site,
  { attempts, wait = sleep, timeoutMs = networkTimeoutMs, census: pendingSha }: SyncOptions,
  now: Date,
): { readonly result: SyncResult; readonly recorded: Recorded | undefined } {
  const fetchUrl = optionalGit(site.checkout, ['remote', 'get-url', 'origin'], { readsOnly: true });

  if (
    fetchUrl === undefined ||
    git(site.checkout, ['config', '--type=bool', '--default=true', shareKey], { readsOnly: true }) === 'false'
  ) {
    return { result: { state: 'local', ...nothingShared }, recorded: undefined };
  }

  const pushUrl = git(site.checkout, ['remote', 'get-url', '--push', 'origin'], { readsOnly: true });
  let yielded: readonly LostClaim[] = [];
  let conflicts: readonly string[] = [];
  let skipped: readonly string[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const { recorded, ...result } = syncOnce(site, { fetchUrl, pushUrl, timeoutMs, pendingSha, now });
    yielded = [...yielded, ...result.yielded];
    conflicts = [...conflicts, ...result.conflicts];
    skipped = [...new Set([...skipped, ...result.skipped])];

    if (result.state !== 'behind' || attempt >= attempts) {
      return { result: { ...result, yielded, conflicts, skipped }, recorded };
    }

    wait(2 ** (attempt - 1) * 1000 * (0.5 + Math.random()));
  }
}

interface Attempt {
  readonly fetchUrl: string;
  readonly pushUrl: string;
  readonly timeoutMs: number;
  readonly pendingSha: string | undefined;
  readonly now: Date;
}

interface GivenBack {
  readonly lost: readonly LostClaim[];
  readonly released: number;
}

function giveBackLosingClaims(
  site: Site,
  sharedTip: string | undefined,
  leaving: readonly Leaving[],
  now: Date,
): GivenBack {
  if (leaving.length === 0) {
    return { lost: [], released: 0 };
  }

  const events = catFileBatch(site.path, leaving, ({ localOid }) => localOid).flatMap(([{ path }, object]) => {
    if (object.kind !== 'blob') {
      return [];
    }

    const event = parseEvent(path, object.text);

    return typeof event === 'string' ? [] : [event];
  });
  const lost = planGiveBack(
    events,
    () => (sharedTip === undefined ? [] : readReplica(site.path, sharedTip).events),
    site.writer,
    now,
  );

  if (lost.length === 0) {
    return { lost, released: 0 };
  }

  const { drafts } = append(site, (replica) => ({ drafts: releasesOfLostClaims(replica.events, lost) }), now);

  return { lost, released: drafts.length };
}

// A try lost to another writer ends behind, which the next try, if any, takes up.
function syncOnce(site: Site, attempt: Attempt): Tried {
  const { fetchUrl, pushUrl, timeoutMs, pendingSha } = attempt;
  const fetched = networkGit(
    site,
    ['fetch', '--prune', '--no-tags', '--end-of-options', fetchUrl, '+refs/garden/*:refs/garden-shared/*'],
    timeoutMs,
  );

  if (timedOut(fetched)) {
    return { state: 'offline', reason: 'timed out', ...nothingShared };
  }

  if (fetched.status !== 0) {
    return {
      state: lostSharedRefLock.test(fetched.stderr) ? 'behind' : 'offline',
      reason: gitReason(fetched.stderr),
      ...nothingShared,
    };
  }

  const { upToDate, census: censusTips, sharedTip, leaving, ...mergedLog } = mergeShared(site);
  const given = giveBackLosingClaims(site, sharedTip, leaving, attempt.now);
  const found = { conflicts: mergedLog.conflicts, skipped: mergedLog.skipped, yielded: given.lost };
  const settledCensus = settleCensus(site, censusTips, pendingSha);

  if (settledCensus === lostToAnotherWriter) {
    return { state: 'behind', reason: 'another sync of the site moved the census first', ...nothingShared, ...found };
  }

  const { recorded, ...settled } = settledCensus;
  const pushedEvents = mergedLog.pushedEvents + given.released;
  const newerCensus = settled.local === censusTips.shared ? undefined : settled.local;
  const localCensus = newerCensus === undefined ? undefined : localCensusOf(site, newerCensus);
  const censusAhead = localCensus === 'to push';
  const merged = {
    ...mergedLog,
    ...found,
    pushedEvents,
    ...(settled.ignored ? { sharedCensusIgnored: true } : {}),
    ...(typeof localCensus === 'object' ? { censusKeptLocal: localCensus.keptLocal } : {}),
    ...(localCensus === 'unreadable' ? { localCensusUnreadable: true } : {}),
  };

  const plan = planBeds(site, leaving);

  if (upToDate && !censusAhead) {
    return { state: 'synced', ...merged, divergedBeds: pushBeds(site, markUnpushed(site, plan), attempt), recorded };
  }

  const beds = markUnpushed(site, plan);
  const pushed = networkGit(
    site,
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

  const unshared = { ...nothingShared, ...found, recorded };

  if (timedOut(pushed)) {
    return { state: 'offline', reason: 'timed out', ...unshared };
  }

  if (pushed.status === 0) {
    return { state: 'synced', ...merged, divergedBeds: pushBeds(site, beds, attempt), recorded };
  }

  const lost = lostRaceOf(pushed.stdout);

  if (lost !== undefined) {
    return { state: 'behind', reason: lost, ...unshared };
  }

  return declined(pushed.stdout)
    ? { state: 'read-only', reason: gitReason(pushed.stderr), ...merged, pushedEvents: 0, divergedBeds: [], recorded }
    : { state: 'offline', reason: gitReason(pushed.stderr), ...unshared };
}
