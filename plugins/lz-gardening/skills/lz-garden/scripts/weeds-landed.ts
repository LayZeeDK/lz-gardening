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

interface Ground {
  readonly base: string;
  readonly withSite: GitInput;
}

function groundOf(site: string, census: string | undefined): Ground | undefined {
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

function checkOffBase(cwd: string, ground: Ground | undefined, tended: TendedClose): BaseLabel {
  if (ground === undefined) {
    return 'base unknown';
  }

  const { base, withSite } = ground;
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

  return bedChangeOnBase({ cwd, withSite, where, fork, base, tip }) === false ? 'not on the base' : 'no label';
}

export function offBaseIn(cwd: string, site: string, census: string | undefined): (tended: TendedClose) => BaseLabel {
  // Keyed by what the label depends on: a retried append replays the log into new objects.
  const known = new Map<string, BaseLabel>();
  let ground: { readonly value: Ground | undefined } | undefined;

  return (tended) => {
    ground ??= { value: groundOf(site, census) };
    const key = `${tended.by}\0${tended.check}`;
    const offBase = known.get(key) ?? checkOffBase(cwd, ground.value, tended);
    known.set(key, offBase);

    return offBase;
  };
}
