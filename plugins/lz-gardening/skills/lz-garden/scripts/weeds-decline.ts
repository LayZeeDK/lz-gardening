// Which seed lines `weeds.ts decline` may leave out of the queue. A seed line of most classes is declined by its
// class and path; a duplicate-function copy is declined one file at a time, on words the repository wrote down.
import { offSeedList, seedPath } from './census.ts';
import type { SeedLine } from './census.ts';
import type { AddInput } from './log.ts';
import { optionalGit, siteObjectsInput } from './store-git.ts';
import type { Census } from './store-census.ts';
import type { Site } from './store-log.ts';

export interface Decline {
  readonly input: AddInput;
  readonly where: string | undefined;
  /** The record `--in` names, which holds the words that keep a duplicate-function copy. */
  readonly record: string | undefined;
  readonly seeds: readonly SeedLine[];
}

const strayIn = '--in goes with --class duplicate-function --where <path> only';

/** Why a decline of a class other than duplicate-function cannot be recorded, or null. */
export function seedDeclineRefusal({ input, where, record, seeds }: Decline): string | null {
  if (record !== undefined) {
    return strayIn;
  }

  return where === undefined ? null : offSeedList(seeds, input.class, where);
}

/** Why a duplicate-function decline cannot be recorded, or null. */
export function copyDeclineRefusal(
  checkout: string,
  site: Site,
  census: Census | undefined,
  decline: Decline,
): string | null {
  const { input, where, record, seeds } = decline;

  if (where === undefined) {
    return record === undefined
      ? 'decline duplicate-function one file at a time, --where <path>, on the words that keep that copy'
      : strayIn;
  }

  return (
    offSeedList(seeds, input.class, where) ??
    unquotedReason(checkout, site, census, input.note, record ?? seedPath(where))
  );
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
function unquotedReason(
  checkout: string,
  site: Site,
  census: Census | undefined,
  reason: string,
  path: string,
): string | null {
  const sha = census?.sha;
  // Stryker disable next-line ConditionalExpression: with no census, git show of undefined:<path> fails as well, and the reason is refused alike
  const text =
    sha === undefined ? undefined : optionalGit(checkout, ['show', `${sha}:${path}`], siteObjectsInput(site.path));

  const quote = asProse(reason);

  return text !== undefined && quote !== '' && asProse(text).includes(quote)
    ? null
    : `--reason must quote the words that keep this copy, as ${path} holds them at the census's commit`;
}
