// Which seed lines `weeds.ts decline` may leave out of the queue. A seed line of most classes is declined by its
// class and path; a duplicate-function copy is declined one file at a time, on words the repository wrote down.
import { offSeedList, seedLinesOf, seedPath } from './census.ts';
import { optionalGit, siteObjectsInput } from './store-git.ts';
import type { Census } from './store-census.ts';
import type { Site } from './store-log.ts';

export interface Decline {
  readonly weedClass: string;
  /** The one file declined; without it, every seed line of the class not yet queued or declined. */
  readonly where: string | undefined;
  /** The record `--in` names, which holds the words that keep a duplicate-function copy. */
  readonly record: string | undefined;
  readonly reason: string;
}

const strayIn = '--in goes with --class duplicate-function --where <path> only';

/** Why the decline's flags cannot go together, which needs no site, or null. */
export function declineUsageProblem({ weedClass, where, record }: Decline): string | null {
  if (weedClass !== 'duplicate-function') {
    return record === undefined ? null : strayIn;
  }

  if (where === undefined) {
    return record === undefined
      ? 'decline duplicate-function one file at a time, --where <path>, on the words that keep that copy'
      : strayIn;
  }

  return null;
}

/** Why `census` keeps the decline from being recorded, or null. */
export function declineRefusal(
  checkout: string,
  site: Site,
  census: Census | undefined,
  decline: Decline,
): string | null {
  const { weedClass, where, record, reason } = decline;
  const seeds = seedLinesOf(census, weedClass);

  if (where === undefined) {
    return seeds.length === 0 ? `no line of the seed list is ${weedClass}; census:seed is for those lines alone` : null;
  }

  const offList = offSeedList(seeds, weedClass, where);

  if (offList !== null || census === undefined || weedClass !== 'duplicate-function') {
    return offList;
  }

  return unquotedReason(checkout, site, census.sha, reason, record ?? seedPath(where));
}

// Text with each line's comment marker dropped and its whitespace run together, so a comment quoted on one line
// matches however it wraps.
function asProse(text: string): string {
  return text
    .replace(/^[ \t]*(?:\/\/+|\/\*+|\*+\/?|#+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A duplicate copy stays only on words the repository wrote down, so the reason must be those words.
function unquotedReason(checkout: string, site: Site, sha: string, reason: string, path: string): string | null {
  const text = optionalGit(checkout, ['show', `${sha}:${path}`], siteObjectsInput(site.path));
  const quote = asProse(reason);

  return text !== undefined && quote !== '' && asProse(text).includes(quote)
    ? null
    : `--reason must quote the words that keep this copy, as ${path} holds them at the census's commit`;
}
