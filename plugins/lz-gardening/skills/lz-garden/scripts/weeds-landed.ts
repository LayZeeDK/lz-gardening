// Whether a tended close's bed has landed its check on the base, judged by patch ids in the checkout (ADR 0003).
import { bedCommit } from './log.ts';
import type { TendedClose } from './log.ts';
import { git, gitSucceeds, optionalGit } from './store-git.ts';
import { censusRef, readCensusAt } from './store-census.ts';

type GitOptions = NonNullable<Parameters<typeof git>[2]>;

/** What add and list can say of a regrown weed's check and the base; 'no label' when it landed or cannot be judged. */
export type BaseLabel = 'no label' | 'not on the base' | 'base unknown';

function shaOfReadableCensus(site: string): string | undefined {
  const recorded = readCensusAt(site, censusRef);

  return typeof recorded === 'object' ? recorded?.census.sha : undefined;
}

interface Landing {
  readonly cwd: string;
  readonly withSite: GitOptions;
  readonly where: string;
  readonly fork: string;
  readonly base: string;
  readonly tip: string;
}

// Whether the bed's change to the check since the fork is on the base: as one base commit (a squash), or as base
// commits with the patch ids of every bed commit that touched it (a rebase or a cherry-pick).
function bedChangeOnBase({ cwd, withSite, where, fork, base, tip }: Landing): boolean | undefined {
  const diffOptions = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
  const checkPath = ['--', `:(top,literal)${where}`];
  // patch-id prints `<patch id> <commit>` for each commit's diff it reads, and nothing for no diff.
  const patchIdsOf = (diffs: string): readonly string[] =>
    git(cwd, ['patch-id'], { ...withSite, input: diffs }).match(/^\S+(?= )/gm) ?? [];
  const [bedChange] = patchIdsOf(git(cwd, ['diff-tree', '-p', ...diffOptions, fork, tip, ...checkPath], withSite));

  if (bedChange === undefined) {
    return undefined;
  }

  // One diff-tree reads every commit of the range, so a range costs three git processes however long it is.
  const patchIdsIn = (range: string): readonly string[] => {
    const commits = git(cwd, ['rev-list', '--no-merges', range, ...checkPath], withSite);

    return patchIdsOf(
      git(cwd, ['diff-tree', '--stdin', '-p', '--root', ...diffOptions, ...checkPath], {
        ...withSite,
        input: `${commits}\n`,
      }),
    );
  };
  const onBase = new Set(patchIdsIn(`${fork}..${base}`));

  return onBase.has(bedChange) || patchIdsIn(`${fork}..${tip}`).every((id) => onBase.has(id));
}

function checkOffBase(cwd: string, site: string, census: string | undefined, tended: TendedClose): BaseLabel {
  const tip = bedCommit(tended);
  const base = census ?? shaOfReadableCensus(site);
  const where = tended.check;

  if (base === undefined) {
    return 'base unknown';
  }

  // The bed's commits are in the site, so the checkout reads them through the site's objects, fetching nothing.
  const withSite = {
    readsOnly: true,
    env: {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: git(site, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
        readsOnly: true,
      }),
      GIT_NO_LAZY_FETCH: '1',
    },
  };
  const hasCheck = (commit: string): boolean => gitSucceeds(cwd, ['cat-file', '-e', `${commit}:${where}`], withSite);
  const fork = optionalGit(cwd, ['merge-base', tip, base], withSite);

  if (fork === undefined) {
    return 'base unknown';
  }

  if (!hasCheck(tip)) {
    return 'no label';
  }

  if (!hasCheck(base)) {
    return 'not on the base';
  }

  if (!hasCheck(fork)) {
    return 'no label';
  }

  // undefined: the bed left the check as it was.
  return bedChangeOnBase({ cwd, withSite, where, fork, base, tip }) === false ? 'not on the base' : 'no label';
}

/** The label of each tended close, worked out once per close. */
export function offBaseIn(cwd: string, site: string, census: string | undefined): (tended: TendedClose) => BaseLabel {
  const known = new Map<TendedClose, BaseLabel>();

  return (tended) => {
    const offBase = known.get(tended) ?? checkOffBase(cwd, site, census, tended);
    // Stryker disable next-line CallExpression: without the cache, each weed works out the same label again
    known.set(tended, offBase);

    return offBase;
  };
}
