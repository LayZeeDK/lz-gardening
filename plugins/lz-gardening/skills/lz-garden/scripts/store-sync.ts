// Sharing with origin: fetch origin's garden refs, merge its log into the site's, give back claims a sync lost, settle
// the census, and push the log, the census and the beds.
import { eventPathPattern, parseEvent, planGiveBack, releasesFor, replay } from './log.ts';
import type { LostClaim } from './log.ts';
import { pushBeds } from './store-beds.ts';
import { censusOffOrigin, censusRef, finishPendingCensus, leaseOnFetchedCensus, settleCensus } from './store-census.ts';
import type { CensusTips } from './store-census.ts';
import {
  catFileBatch,
  git,
  isAncestor,
  networkGit,
  networkTimeoutMs,
  objectIds,
  optionalGit,
  reasonOf,
  timedOut,
} from './store-git.ts';
import {
  append,
  formatOf,
  logFormat,
  logRef,
  moveLogIfStill,
  readLog,
  readReplica,
  writeLogIfStill,
} from './store-log.ts';
import type { Site } from './store-log.ts';

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

// Stryker disable next-line LzJsNumericLiteral: how many tries a merge spends is policy, as with appendTries
const mergeTries = 50;

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

// bed and close-class act on a class only under this writer's live claim, read after a sync that left the log local
// or shared, so another clone's newer claim is seen and this claim is on origin. The refusal may hold git's message,
// so a caller escapes it to print it.
export function claimRefusal(site: Site, weedClass: string, pre: SyncResult, now: Date): string | undefined {
  if (!isShared(pre)) {
    return `cannot check the claim of ${weedClass}: ${pre.state}${pre.reason === undefined ? '' : ` (${pre.reason})`}`;
  }

  const owner = replay(readLog(site).events, now).claims.get(weedClass);

  if (owner === undefined) {
    return `this site holds no claim of ${weedClass}; run weeds claim --class ${weedClass}`;
  }

  if (owner.writer !== site.writer) {
    return `${weedClass} is claimed by ${owner.holder} until ${owner.until}`;
  }

  return undefined;
}

export function sync(site: Site, options: SyncOptions, now = new Date()): SyncResult {
  const result = syncWithOrigin(site, options, now);

  if (options.census !== undefined) {
    finishPendingCensus(site, options.census);
  }

  return result;
}

function syncWithOrigin(
  site: Site,
  { attempts, wait = sleep, timeoutMs = networkTimeoutMs, census: pendingSha }: SyncOptions,
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
  let yielded: readonly LostClaim[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const result = syncOnce(site, { fetchUrl, pushUrl, timeoutMs, pendingSha, now });
    yielded = [...yielded, ...result.yielded];

    if (result.state !== 'behind' || attempt >= attempts) {
      return { ...result, yielded };
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

  const events = catFileBatch(site.path, leaving, ({ localOid }) => localOid).flatMap(([{ path }, { text }]) => {
    const event = parseEvent(path, text ?? '');

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

  const { drafts } = append(site, (replica) => ({ drafts: releasesFor(replica.events, lost) }), now);

  return { lost, released: drafts.length };
}

// A try lost to another writer ends behind, which the next try, if any, takes up.
function syncOnce(site: Site, attempt: Attempt): SyncResult {
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
    return {
      state: lostSharedRefLock.test(fetched.stderr) ? 'behind' : 'offline',
      reason: reasonOf(fetched.stderr),
      ...nothingShared,
    };
  }

  const { upToDate, census: censusTips, sharedTip, leaving, ...mergedLog } = mergeShared(site);
  const given = giveBackLosingClaims(site, sharedTip, leaving, attempt.now);
  const settled = settleCensus(site, censusTips, pendingSha);
  const pushedEvents = mergedLog.pushedEvents + given.released;
  const newerCensus = settled.local === censusTips.shared ? undefined : settled.local;
  const keptLocal = newerCensus === undefined ? undefined : censusOffOrigin(site, newerCensus);
  const censusAhead = newerCensus !== undefined && keptLocal === undefined;
  const merged = {
    ...mergedLog,
    pushedEvents,
    yielded: given.lost,
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
    return { state: 'offline', reason: 'timed out', ...nothingShared, yielded: given.lost };
  }

  if (pushed.status === 0) {
    return { state: 'synced', ...merged, divergedBeds: pushBeds(site, leaving, attempt) };
  }

  return rejected(pushed.stdout)
    ? { state: 'behind', ...nothingShared, yielded: given.lost }
    : { state: 'read-only', reason: reasonOf(pushed.stderr), ...merged, pushedEvents: 0, divergedBeds: [] };
}
