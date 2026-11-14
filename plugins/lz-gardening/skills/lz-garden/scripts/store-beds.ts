// The shared beds: which bed branches a sync pushes to origin as refs/garden/beds/<class>, which stay local and why.
import { join } from 'node:path';
import { bedCommit, eventPath, latestTendedClose } from './log.ts';
import { git, isAncestor, networkGit, objectIdPattern, reasonOf, refsUnder, timedOut } from './store-git.ts';
import { logRef, machinePathTest, readReplica } from './store-log.ts';
import type { Site } from './store-log.ts';

const bedBranches = 'refs/heads/bed/';

const sharedBeds = 'refs/garden-shared/beds/';

export function fetchedBedRef(weedClass: string): string {
  return `${sharedBeds}${weedClass}`;
}

function sharedBedRef(weedClass: string): string {
  return `refs/garden/beds/${weedClass}`;
}

// A bed whose push failed, kept in the site so a later sync pushes it again once its close is on origin.
const unpushedBeds = 'refs/garden-unpushed/beds/';

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

export function pushBeds(
  site: Site,
  leaving: readonly { readonly path: string }[],
  { pushUrl, timeoutMs }: { readonly pushUrl: string; readonly timeoutMs: number },
): readonly string[] {
  const tips = refsUnder(site.path, [bedBranches, sharedBeds, unpushedBeds]);
  const tipOf = (prefix: string, weedClass: string): string | undefined => tips.get(`${prefix}${weedClass}`);
  const candidates = [...tips].flatMap(([name, oid]) => {
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
      return leavingPaths.has(eventPath(close.uuid)) || tipOf(unpushedBeds, bed.weedClass) === bed.tip
        ? [{ ...bed, why: bedStaysLocal(site, bed.tip, shared) }]
        : [];
    }

    const why = isAncestor(site.path, shared, bed.tip)
      ? bedStaysLocal(site, bed.tip, shared)
      : `does not descend from origin's bed`;

    return [{ ...bed, why }];
  });
  const pushing = judged.filter(({ why }) => why === undefined);
  const diverged = judged.flatMap(({ weedClass, why }) =>
    why === undefined ? [] : [`${weedClass}: bed/${weedClass} ${why}`],
  );

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
  // A porcelain line per ref: "<flag>\t<from>:<to>\t<summary>", the flag ! for a ref the push left as it was. A push
  // that failed before it reached the refs prints no line for them.
  const reported = new Map(
    pushed.stdout.split('\n').flatMap((line) => {
      const [flag, refs, summary] = line.split('\t');

      return refs === undefined ? [] : [[refs.slice(refs.indexOf(':') + 1), { flag, summary }] as const];
    }),
  );
  const outcomes = pushing.map(({ weedClass, tip }) => {
    const line = reported.get(sharedBedRef(weedClass));

    if (line === undefined) {
      return { weedClass, tip, why: timedOut(pushed) ? 'timed out' : reasonOf(pushed.stderr) };
    }

    return { weedClass, tip, why: line.flag === '!' ? (line.summary ?? '') : undefined };
  });
  const refused = outcomes.flatMap(({ weedClass, why }) => (why === undefined ? [] : [{ weedClass, why }]));
  const marks = outcomes.flatMap(({ weedClass, tip, why }) => {
    if (why !== undefined) {
      return [`update ${unpushedBeds}${weedClass} ${tip}\n`];
    }

    return tipOf(unpushedBeds, weedClass) === undefined ? [] : [`delete ${unpushedBeds}${weedClass}\n`];
  });

  // Stryker disable next-line ConditionalExpression: an update-ref with nothing to do changes no ref; this saves a git run
  if (marks.length > 0) {
    git(site.path, ['update-ref', '--stdin'], { input: marks.join('') });
  }

  return [...diverged, ...refused.map(({ weedClass, why }) => `${weedClass}: ${why}`)];
}
