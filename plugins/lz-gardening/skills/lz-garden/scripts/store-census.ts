// The census refs: the census a site holds (refs/garden/census), the census a run took and left pending
// (refs/garden/pending/<sha>), and which of them, or of origin's, the site keeps.
import { z } from 'zod';
import { isRecord, isStampedTime } from './log.ts';
import {
  catFileBatch,
  git,
  gitFailed,
  gitSucceeds,
  isKnownAncestor,
  objectIdPattern,
  objectIds,
  optionalGit,
  refsUnder,
  runGit,
} from './store-git.ts';
import { commitStream, lostToAnotherWriter } from './store-log.ts';
import type { LostToAnotherWriter, Site } from './store-log.ts';

export const censusRef = 'refs/garden/census';

export function leaseOnFetchedCensus(fetched: string | undefined): string {
  return `--force-with-lease=${censusRef}:${fetched ?? ''}`;
}

export function pendingCensusRef(sha: string): string {
  return `refs/garden/pending/${sha}`;
}

export interface Census {
  readonly rev: string;
  readonly sha: string;
  readonly takenAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly hits: Readonly<Record<string, readonly string[]>>;
  readonly duplicates: Readonly<Record<string, readonly string[]>>;
}

// A record parsed as its entries: z.record drops a "__proto__" key, and a duplicated function can have that name.
function recordOf<TValue>(value: z.ZodType<TValue>): z.ZodType<Readonly<Record<string, TValue>>> {
  return z
    .preprocess((input) => (isRecord(input) ? Object.entries(input) : null), z.array(z.tuple([z.string(), value])))
    .transform((entries) => Object.fromEntries(entries));
}

const censusSchema = z
  .object({
    rev: z.string(),
    sha: z.string().regex(objectIdPattern),
    takenAt: z.string().refine(isStampedTime),
    counts: recordOf(z.int().nonnegative()),
    hits: recordOf(z.array(z.string())),
    duplicates: recordOf(z.array(z.string())),
  })
  .refine(({ counts, hits }) => Object.keys(counts).every((id) => Object.hasOwn(hits, id)));

export function parseCensus(json: unknown): Census | null {
  const parsed = censusSchema.safeParse(json);

  return parsed.success ? parsed.data : null;
}

export interface StoredCensus {
  readonly census: Census;
  readonly text: string;
  readonly patterns: string | undefined;
}

export function writePendingCensus(
  site: Pick<Site, 'path' | 'checkout'>,
  sha: string,
  text: string,
  patterns?: string,
): void {
  const files = [
    { path: 'census.json', text },
    ...(patterns === undefined ? [] : [{ path: 'patterns.json', text: patterns }]),
  ];
  git(site.path, ['fast-import', '--quiet', '--done', '--force', '--date-format=rfc2822'], {
    input: commitStream(site, pendingCensusRef(sha), 'garden: census\n', files),
  });
}

export type ReadCensus =
  { readonly kind: 'none' } | { readonly kind: 'not a census' } | ({ readonly kind: 'census' } & StoredCensus);

export function readCensusAt(site: string, ref: string): ReadCensus {
  const [text, patterns] = catFileBatch(site, [`${ref}:census.json`, `${ref}:patterns.json`], (name) => name).map(
    ([, object]) => (object.kind === 'blob' ? object.text : undefined),
  );

  if (text === undefined) {
    return { kind: 'none' };
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'not a census' };
  }

  const census = parseCensus(json);

  return census === null ? { kind: 'not a census' } : { kind: 'census', census, text, patterns };
}

export function readableCensus(site: string, ref: string): Census | undefined {
  const read = readCensusAt(site, ref);

  return read.kind === 'census' ? read.census : undefined;
}

export interface Recorded {
  readonly local: string | undefined;
  readonly sha: string | undefined;
}

export function hasCensusOf(site: Pick<Site, 'checkout' | 'path'>, pendingSha: string): boolean {
  const [pending, local] = objectIds(site.path, [pendingCensusRef(pendingSha), censusRef]);

  return pending !== undefined || covers(site, censusAt(site, local), pendingSha);
}

function censusAt(site: Pick<Site, 'path'>, local: string | undefined): Census | undefined {
  return local === undefined ? undefined : readableCensus(site.path, local);
}

function covers(site: Pick<Site, 'checkout'>, held: Census | undefined, pendingSha: string): boolean {
  return held !== undefined && isKnownAncestor(site.checkout, pendingSha, held.sha);
}

function recordPendingCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  pendingSha: string,
): Recorded | LostToAnotherWriter {
  const [pending, local] = objectIds(site.path, [pendingCensusRef(pendingSha), censusRef]);
  const held = censusAt(site, local);

  if (pending === undefined || covers(site, held, pendingSha)) {
    return { local, sha: held?.sha };
  }

  return moveCensusIfStill(site.path, pending, local) ? { local: pending, sha: pendingSha } : lostToAnotherWriter;
}

function localCensusIsNewer(site: Pick<Site, 'checkout' | 'path'>, local: string | undefined, theirs: Census): boolean {
  const mine = censusAt(site, local);

  return mine !== undefined && mine.sha !== theirs.sha && isKnownAncestor(site.checkout, theirs.sha, mine.sha);
}

export interface CensusTips {
  readonly local: string | undefined;
  readonly shared: string | undefined;
}

interface Settled {
  readonly local: string | undefined;
  readonly ignored: boolean;
}

export function settleCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  tips: CensusTips,
  pendingSha: string | undefined,
): (Settled & { readonly recorded: Recorded | undefined }) | LostToAnotherWriter {
  const adopted = adoptSharedCensus(site, tips);

  if (adopted === lostToAnotherWriter) {
    return adopted;
  }

  if (pendingSha === undefined) {
    return { ...adopted, recorded: undefined };
  }

  const recorded = recordPendingCensus(site, pendingSha);

  return recorded === lostToAnotherWriter ? recorded : { ...adopted, local: recorded.local, recorded };
}

function adoptSharedCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  { local, shared }: CensusTips,
): Settled | LostToAnotherWriter {
  if (shared === undefined || shared === local) {
    return { local, ignored: false };
  }

  const theirs = readableCensus(site.path, shared);

  if (theirs === undefined) {
    return { local, ignored: true };
  }

  if (localCensusIsNewer(site, local, theirs)) {
    return { local, ignored: false };
  }

  return moveCensusIfStill(site.path, shared, local) ? { local: shared, ignored: false } : lostToAnotherWriter;
}

// Another sync of this site may have moved the census first: to the same commit, which is as good as moving it here,
// or to another, which loses this move.
function moveCensusIfStill(site: string, to: string, from: string | undefined): boolean {
  const args = ['update-ref', censusRef, to, from ?? ''];
  const moved = runGit(site, args);

  if (moved.status === 0) {
    return true;
  }

  const now = optionalGit(site, ['rev-parse', '--verify', '--quiet', censusRef], { readsOnly: true });

  if (now === from) {
    throw gitFailed(args, moved.stderr);
  }

  return now === to;
}

export function finishPendingCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  pendingSha: string,
  triedRecord: Recorded | undefined,
): LostToAnotherWriter | undefined {
  const recorded = triedRecord ?? recordPendingCensus(site, pendingSha);

  if (recorded === lostToAnotherWriter) {
    return recorded;
  }

  const pendingPrefix = pendingCensusRef('');
  const deletes = [...refsUnder(site.path, [pendingPrefix])].filter(([name]) => {
    const sha = name.slice(pendingPrefix.length);

    return sha === pendingSha || (recorded.sha !== undefined && isKnownAncestor(site.checkout, sha, recorded.sha));
  });
  // Another sync of this site may delete them first, failing these deletes; what either leaves, a later sync deletes.
  gitSucceeds(site.path, ['update-ref', '--stdin'], {
    input: deletes.map(([name, oid]) => `delete ${name} ${oid}\n`).join(''),
  });

  return undefined;
}

// A census to push, the commit of one no branch fetched from origin holds, or one that is not a census: the last two
// stay in the site.
export type LocalCensus = 'ahead' | 'not a census' | { readonly offOrigin: string };

export function localCensusOf(site: Pick<Site, 'checkout' | 'path'>, ref: string): LocalCensus {
  const sha = readableCensus(site.path, ref)?.sha;

  if (sha === undefined) {
    return 'not a census';
  }

  const holders = optionalGit(
    site.checkout,
    ['for-each-ref', '--count=1', '--format=%(refname)', `--contains=${sha}`, 'refs/remotes/origin/'],
    { readsOnly: true },
  );

  return holders === undefined || holders === '' ? { offOrigin: sha } : 'ahead';
}
