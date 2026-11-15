// The shared beds: which bed branches a sync pushes to origin as refs/garden/beds/<class>, which stay local and why.
import { join } from 'node:path';
import { bedCommit, eventPath, latestTendedClose } from './log.ts';
import {
  git,
  gitReason,
  gitSucceeds,
  isKnownAncestor,
  networkGit,
  objectIds,
  pushReport,
  refsUnder,
  timedOut,
} from './store-git.ts';
import { logRef, machinePathTest, readReplica } from './store-log.ts';
import type { Site } from './store-log.ts';

const bedBranches = 'refs/heads/bed/';

const fetchedBeds = 'refs/garden-shared/beds/';

export function fetchedBedRef(weedClass: string): string {
  return `${fetchedBeds}${weedClass}`;
}

function sharedBedRef(weedClass: string): string {
  return `refs/garden/beds/${weedClass}`;
}

const unpushedBeds = 'refs/garden-unpushed/beds/';

function unpushedBedRef(weedClass: string): string {
  return `${unpushedBeds}${weedClass}`;
}

// A hunk's lines are counted from its header, so no line inside it is taken for a header by how its text starts. A
// merge's combined diff (--cc) marks each line once per parent; a line with no - is in the result, and one with a +
// is new to some parent. A commit starts with a NUL and its id, and its message ends at a NUL, which no message holds.
function readBedLog(log: string): { readonly commits: readonly string[]; readonly added: readonly string[] } {
  const commits: string[] = [];
  const added: string[] = [];
  let inMessage = false;
  let parents: number;
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

      if (hunk !== null) {
        // One @ per parent and one more: the header's first space follows them.
        parents = line.indexOf(' ') - 1;
        left = Number(hunk[2] ?? '1');
      }

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
        '--no-show-signature',
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
  const held = objectIds(site.checkout, commits, { env: { GIT_NO_LAZY_FETCH: '1' } });

  if (held.some((oid) => oid !== undefined)) {
    return 'stays local: its base is on no branch fetched from origin';
  }

  return added.some(machinePathTest(site)) ? 'stays local: it holds a path on this machine' : undefined;
}

function divergedFrom(site: Site, weedClass: string, shared: string): string {
  return objectIds(site.path, [`${shared}^{commit}`])[0] === undefined
    ? `stays local: origin's ${sharedBedRef(weedClass)} is not a commit`
    : `does not descend from origin's bed`;
}

interface Bed {
  readonly weedClass: string;
  readonly tip: string;
}

interface BedPlan {
  readonly pushing: readonly Bed[];
  readonly diverged: readonly string[];
  readonly landed: readonly Bed[];
}

const marked: unique symbol = Symbol('marked');

export interface MarkedBeds {
  readonly [marked]: BedPlan;
}

export function planBeds(site: Site, leaving: readonly { readonly path: string }[]): BedPlan {
  const tips = refsUnder(site.path, [bedBranches, fetchedBeds, unpushedBeds]);
  const candidates = [...tips].flatMap(([name, oid]) => {
    const weedClass = name.slice(bedBranches.length);

    return name.startsWith(bedBranches) && tips.get(fetchedBedRef(weedClass)) !== oid ? [{ weedClass, tip: oid }] : [];
  });
  const landed = [...tips].flatMap(([name, oid]) => {
    const weedClass = name.slice(unpushedBeds.length);

    return name.startsWith(unpushedBeds) && tips.get(fetchedBedRef(weedClass)) === oid ? [{ weedClass, tip: oid }] : [];
  });

  if (candidates.length === 0) {
    return { pushing: [], diverged: [], landed };
  }

  const { events } = readReplica(site.path, logRef);
  const leavingPaths = new Set(leaving.map(({ path }) => path));
  const judged = candidates.flatMap((bed) => {
    const close = latestTendedClose(events, bed.weedClass);
    const shared = tips.get(fetchedBedRef(bed.weedClass));

    if (close === undefined || !bed.tip.startsWith(bedCommit(close))) {
      return [];
    }

    if (shared === undefined) {
      return leavingPaths.has(eventPath(close.uuid)) || tips.get(unpushedBedRef(bed.weedClass)) === bed.tip
        ? [{ ...bed, why: bedStaysLocal(site, bed.tip, shared) }]
        : [];
    }

    const why = isKnownAncestor(site.path, shared, bed.tip)
      ? bedStaysLocal(site, bed.tip, shared)
      : divergedFrom(site, bed.weedClass, shared);

    return [{ ...bed, why }];
  });
  const pushing = judged.flatMap(({ weedClass, tip, why }) => (why === undefined ? [{ weedClass, tip }] : []));
  const diverged = judged.flatMap(({ weedClass, why }) =>
    why === undefined ? [] : [`${weedClass}: bed/${weedClass} ${why}`],
  );

  return { pushing, diverged, landed };
}

export function markUnpushed(site: Site, plan: BedPlan): MarkedBeds {
  plan.landed.forEach(({ weedClass, tip }) => {
    unmarkIfStillAt(site, weedClass, tip);
  });

  if (plan.pushing.length > 0) {
    git(site.path, ['update-ref', '--stdin'], {
      input: plan.pushing.map(({ weedClass, tip }) => `update ${unpushedBedRef(weedClass)} ${tip}\n`).join(''),
    });
  }

  return { [marked]: plan };
}

function unmarkIfStillAt(site: Site, weedClass: string, tip: string): void {
  gitSucceeds(site.path, ['update-ref', '-d', unpushedBedRef(weedClass), tip]);
}

export function pushBeds(
  site: Site,
  { [marked]: { pushing, diverged } }: MarkedBeds,
  { pushUrl, timeoutMs }: { readonly pushUrl: string; readonly timeoutMs: number },
): readonly string[] {
  if (pushing.length === 0) {
    return diverged;
  }

  const pushed = networkGit(
    site,
    [
      'push',
      '--porcelain',
      '--end-of-options',
      pushUrl,
      ...pushing.map(({ weedClass, tip }) => `${tip}:${sharedBedRef(weedClass)}`),
    ],
    timeoutMs,
  );
  // A push that failed before it reached the refs reports none of them.
  const reported = pushReport(pushed.stdout);
  const outcomes = pushing.map(({ weedClass, tip }) => {
    const line = reported.get(sharedBedRef(weedClass));

    if (line === undefined) {
      return { weedClass, tip, why: timedOut(pushed) ? 'timed out' : gitReason(pushed.stderr) };
    }

    return { weedClass, tip, why: line.flag === '!' ? line.summary : undefined };
  });

  outcomes
    .filter(({ why }) => why === undefined)
    .forEach(({ weedClass, tip }) => {
      unmarkIfStillAt(site, weedClass, tip);
    });

  return [
    ...diverged,
    ...outcomes.flatMap(({ weedClass, why }) => (why === undefined ? [] : [`${weedClass}: ${why}`])),
  ];
}
