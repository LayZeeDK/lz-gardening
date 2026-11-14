// The census refs: the census a site holds (refs/garden/census), the census a run took and left pending
// (refs/garden/pending/<sha>), and which of them, or of origin's, the site keeps.
import { isRecord } from './log.ts';
import {
  catFileBatch,
  git,
  gitSucceeds,
  isKnownAncestor,
  objectIds,
  optionalGit,
  refsUnder,
  runGit,
} from './store-git.ts';
import { commitStream } from './store-log.ts';
import type { Site } from './store-log.ts';

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

export function parseCensus(json: unknown): Census | null {
  if (!isRecord(json) || !isRecord(json['counts']) || !isRecord(json['hits'])) {
    return null;
  }

  const { rev, sha, takenAt } = json;

  if (typeof rev !== 'string' || typeof sha !== 'string' || typeof takenAt !== 'string') {
    return null;
  }

  const counts: Record<string, number> = {};

  for (const [id, count] of Object.entries(json['counts'])) {
    if (typeof count === 'number') {
      counts[id] = count;
    }
  }

  return {
    rev,
    sha,
    takenAt,
    counts,
    hits: stringLists(json['hits']),
    duplicates: stringLists(json['duplicates']),
  };
}

function stringLists(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, list]) =>
      Array.isArray(list) ? [[key, list.filter((item): item is string => typeof item === 'string')] as const] : [],
    ),
  );
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

export function readCensusAt(site: string, ref: string): StoredCensus | null | 'not a census' {
  const [text, patterns] = catFileBatch(site, [`${ref}:census.json`, `${ref}:patterns.json`], (name) => name).map(
    ([, object]) => object.text,
  );

  if (text === undefined) {
    return null;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return 'not a census';
  }

  const census = parseCensus(json);

  return census === null ? 'not a census' : { census, text, patterns };
}

export interface Recorded {
  readonly local: string | undefined;
  readonly sha: string | undefined;
}

export function recordPendingCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  pendingSha: string,
): Recorded | 'lost to another writer' {
  const [pending, local] = objectIds(site.path, [pendingCensusRef(pendingSha), censusRef]);
  const held = local === undefined ? undefined : censusIn(site.path, local);

  if (pending === undefined || (held !== undefined && isKnownAncestor(site.checkout, pendingSha, held.sha))) {
    return { local, sha: held?.sha };
  }

  return moveCensusIfStill(site.path, pending, local) ? { local: pending, sha: pendingSha } : 'lost to another writer';
}

function localCensusIsNewer(site: Pick<Site, 'checkout' | 'path'>, local: string | undefined, theirs: Census): boolean {
  const mine = local === undefined ? undefined : censusIn(site.path, local);

  return mine !== undefined && mine.sha !== theirs.sha && isKnownAncestor(site.checkout, theirs.sha, mine.sha);
}

function censusIn(site: string, ref: string): Census | undefined {
  const read = readCensusAt(site, ref);

  return typeof read === 'object' && read !== null ? read.census : undefined;
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
): (Settled & { readonly recorded: Recorded | undefined }) | 'lost to another writer' {
  const adopted = adoptSharedCensus(site, tips);

  if (adopted === 'lost to another writer') {
    return adopted;
  }

  if (pendingSha === undefined) {
    return { ...adopted, recorded: undefined };
  }

  const recorded = recordPendingCensus(site, pendingSha);

  return recorded === 'lost to another writer' ? recorded : { ...adopted, local: recorded.local, recorded };
}

function adoptSharedCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  { local, shared }: CensusTips,
): Settled | 'lost to another writer' {
  if (shared === undefined || shared === local) {
    return { local, ignored: false };
  }

  const theirs = censusIn(site.path, shared);

  if (theirs === undefined) {
    return { local, ignored: true };
  }

  if (localCensusIsNewer(site, local, theirs)) {
    return { local, ignored: false };
  }

  return moveCensusIfStill(site.path, shared, local) ? { local: shared, ignored: false } : 'lost to another writer';
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
    throw new Error(`git ${args.join(' ')}: ${moved.stderr.trim()}`);
  }

  return now === to;
}

export function finishPendingCensus(
  site: Pick<Site, 'checkout' | 'path'>,
  pendingSha: string,
  recorded: Recorded,
): void {
  const pendingPrefix = pendingCensusRef('');
  const deletes = [...refsUnder(site.path, [pendingPrefix])].filter(([name]) => {
    const sha = name.slice(pendingPrefix.length);

    return sha === pendingSha || (recorded.sha !== undefined && isKnownAncestor(site.checkout, sha, recorded.sha));
  });
  // Another sync of this site may delete them first, failing these deletes; what either leaves, a later sync deletes.
  gitSucceeds(site.path, ['update-ref', '--stdin'], {
    input: deletes.map(([name, oid]) => `delete ${name} ${oid}\n`).join(''),
  });
}

export function censusOffOrigin(site: Pick<Site, 'checkout' | 'path'>, ref: string): string | undefined {
  const sha = censusIn(site.path, ref)?.sha;

  if (sha === undefined) {
    return undefined;
  }

  const holders = optionalGit(
    site.checkout,
    ['for-each-ref', '--count=1', '--format=%(refname)', `--contains=${sha}`, 'refs/remotes/origin/'],
    { readsOnly: true },
  );

  return holders === undefined || holders === '' ? sha : undefined;
}
