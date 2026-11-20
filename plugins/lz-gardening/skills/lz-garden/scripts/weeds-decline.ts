// Which seed lines `weeds.ts decline` may leave out of the queue. A seed line of a census pattern is declined by its
// class and path, after `weeds lines` printed its class; a duplicate-function copy is declined one file at a time, on
// words the repository wrote down.
import { createHash } from 'node:crypto';
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
  /** The token `weeds lines` printed for a census pattern's class. */
  readonly read: string | undefined;
}

const strayIn = '--in goes with --class duplicate-function --where <path> only';

/** Why the decline's flags cannot go together, which needs no site, or null. */
export function declineUsageProblem({ weedClass, where, record, read }: Decline): string | null {
  if (weedClass !== 'duplicate-function') {
    return record === undefined ? null : strayIn;
  }

  if (where === undefined) {
    return record === undefined
      ? 'decline duplicate-function one file at a time, --where <path>, on the words that keep that copy'
      : strayIn;
  }

  return read === undefined ? null : '--read goes with a class other than duplicate-function only';
}

/** What `weeds lines` prints for a census pattern's class: each of its seed lines with its hits, then the token. */
export function seedLinesRead(
  census: Census,
  weedClass: string,
): { readonly lines: readonly string[]; readonly token: string } {
  const lines = seedLinesOf(census, weedClass).flatMap((seed) => [seed.line, ...seed.hits]);
  const token = createHash('sha256')
    .update([census.sha, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 12);

  return { lines, token };
}

export function noSeedLine(weedClass: string): string {
  return `no line of the seed list is ${weedClass}; census:seed is for those lines alone`;
}

/** Why `census` keeps the decline from being recorded, or null. */
export function declineRefusal(
  checkout: string,
  site: Site,
  census: Census | undefined,
  decline: Decline,
): string | null {
  const { weedClass, where, record, reason, read } = decline;

  if (census === undefined) {
    return where === undefined ? noSeedLine(weedClass) : offSeedList([], weedClass, where);
  }

  const seeds = seedLinesOf(census, weedClass);

  if (where === undefined) {
    return seeds.length === 0 ? noSeedLine(weedClass) : unreadRefusal(census, weedClass, read);
  }

  const offList = offSeedList(seeds, weedClass, where);

  if (offList !== null) {
    return offList;
  }

  return weedClass === 'duplicate-function'
    ? unquotedReason(checkout, site, census.sha, reason, record ?? seedPath(where))
    : unreadRefusal(census, weedClass, read);
}

// A pattern's seed lines are declined only after `weeds lines` printed them, which --read proves.
function unreadRefusal(census: Census, weedClass: string, read: string | undefined): string | null {
  const command = `weeds lines --class ${weedClass} --census ${census.sha}`;

  if (read === undefined) {
    return `run ${command}, read every line it prints, and pass the token on its last line as --read`;
  }

  return read === seedLinesRead(census, weedClass).token
    ? null
    : `--read ${read} is not the token ${command} prints; run it again and read every line it prints`;
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
