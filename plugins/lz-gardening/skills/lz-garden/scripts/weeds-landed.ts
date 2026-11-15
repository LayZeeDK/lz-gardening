// Whether a tended close's bed has landed its check on the base, judged by patch ids in the checkout (ADR 0003).
import { bedCommit } from './log.ts';
import type { TendedClose } from './log.ts';
import { git, gitSucceeds, optionalGit } from './store-git.ts';
import type { GitInput } from './store-git.ts';
import { censusRef, readableCensus } from './store-census.ts';

export type BaseLabel = 'no label' | 'not on the base' | 'base unknown';

interface Landing {
  readonly cwd: string;
  readonly withSite: GitInput;
  readonly where: string;
  readonly fork: string;
  readonly base: string;
  readonly tip: string;
}

function bedChangeMissingFromBase({ cwd, withSite, where, fork, base, tip }: Landing): boolean {
  const diffOptions = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
  const checkPath = ['--', `:(top,literal)${where}`];
  // patch-id prints `<patch id> <commit>` for each commit's diff it reads, and nothing for no diff.
  const patchIdsOf = (diffs: string): readonly string[] =>
    git(cwd, ['patch-id'], { ...withSite, input: diffs }).match(/^\S+(?= )/gm) ?? [];
  const [bedChange] = patchIdsOf(git(cwd, ['diff-tree', '-p', ...diffOptions, fork, tip, ...checkPath], withSite));

  if (bedChange === undefined) {
    return false;
  }

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

  return !onBase.has(bedChange) && !patchIdsIn(`${fork}..${tip}`).every((id) => onBase.has(id));
}

interface BaseInSite {
  readonly base: string;
  readonly withSite: GitInput;
}

function baseInSiteOf(site: string, census: string | undefined): BaseInSite | undefined {
  const base = census ?? readableCensus(site, censusRef)?.sha;

  if (base === undefined) {
    return undefined;
  }

  const withSite = {
    readsOnly: true,
    env: {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: git(site, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {
        readsOnly: true,
      }),
      GIT_NO_LAZY_FETCH: '1',
    },
  };

  return { base, withSite };
}

function checkOffBase(cwd: string, judged: BaseInSite | undefined, tended: TendedClose): BaseLabel {
  if (judged === undefined) {
    return 'base unknown';
  }

  const { base, withSite } = judged;
  const tip = bedCommit(tended);
  const where = tended.check;
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

  return bedChangeMissingFromBase({ cwd, withSite, where, fork, base, tip }) ? 'not on the base' : 'no label';
}

export function offBaseIn(cwd: string, site: string, census: string | undefined): (tended: TendedClose) => BaseLabel {
  const labelByBedAndCheck = new Map<string, BaseLabel>();
  let baseInSite: { readonly value: BaseInSite | undefined } | undefined;

  return (tended) => {
    baseInSite ??= { value: baseInSiteOf(site, census) };
    const key = `${tended.by}\0${tended.check}`;
    const offBase = labelByBedAndCheck.get(key) ?? checkOffBase(cwd, baseInSite.value, tended);
    labelByBedAndCheck.set(key, offBase);

    return offBase;
  };
}
