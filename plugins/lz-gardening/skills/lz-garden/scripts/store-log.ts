// The garden site and its log: where the site is, and how events are read from and appended to refs/garden/log.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { eventPath, maxClockOf, parseEvent, stamp } from './log.ts';
import type { EventDraft, GardenEvent } from './log.ts';
import {
  catFileBatch,
  configValue,
  forgetConfig,
  git,
  mainCheckout,
  refTip,
  runGit,
  treeEntries,
} from './store-git.ts';

export const logRef = 'refs/garden/log';

export const logFormat = 1;

function data(text: string): string {
  return `data ${String(Buffer.byteLength(text))}\n${text}\n`;
}

function identityPart(checkout: string, key: string): string | undefined {
  const value = configValue(checkout, key);

  if (value !== undefined && /[\n<>]/.test(value)) {
    throw new Error(`${key} holds a line break, < or >, which a commit cannot name; change it`);
  }

  return value;
}

function identity(checkout: string, whose: 'author' | 'committer', now: string): string {
  const name = identityPart(checkout, 'lzGardening.name');
  const email = identityPart(checkout, 'lzGardening.email');
  const who = name === undefined || email === undefined ? 'lz-gardening <>' : `${name} <${email}>`;

  return `${whose} ${who} ${now}\n`;
}

type CommitFile = { readonly path: string; readonly text: string } | { readonly path: string; readonly oid: string };

// A fast-import stream of one commit to ref, on the first parent given and merging the others, authored and
// committed as the checkout's garden identity.
export function commitStream(
  { checkout }: Pick<Site, 'checkout'>,
  ref: string,
  message: string,
  files: readonly CommitFile[],
  parents: readonly string[] = [],
): string {
  const nowInUtc = `@${String(Math.floor(Date.now() / 1000))} +0000`;

  return [
    `commit ${ref}\n`,
    identity(checkout, 'author', nowInUtc),
    identity(checkout, 'committer', nowInUtc),
    data(message),
    ...parents.map((parent, index) => `${index === 0 ? 'from' : 'merge'} ${parent}\n`),
    ...files.map((file) =>
      'oid' in file ? `M 100644 ${file.oid} ${file.path}\n` : `M 100644 inline ${file.path}\n${data(file.text)}`,
    ),
    'done\n',
  ].join('');
}

// Stryker disable next-line StringLiteral: callers compare a result with this constant, never with its text
export const lostToAnotherWriter = 'lost to another writer';
export type LostToAnotherWriter = typeof lostToAnotherWriter;

// fast-import moves the ref only by fast-forward, so a commit planned on the tip lands only while the ref names it,
// and a first commit lands only where there is no log. A merge parent adds history, not files: the tree is the tip's
// plus the files given.
export function writeLogIfStill(
  site: Located,
  tip: string | null,
  files: readonly CommitFile[],
  merge?: string,
): boolean {
  const parents = [...(tip === null ? [] : [tip]), ...(merge === undefined ? [] : [merge])];
  const imported = runGit(site.path, ['fast-import', '--quiet', '--done', '--date-format=rfc2822'], {
    input: commitStream(site, logRef, 'garden: log\n', files, parents),
  });

  if (imported.status === 0) {
    return true;
  }

  if ((refTip(site.path, logRef) ?? null) === tip) {
    throw new Error(`git fast-import ${logRef}: ${imported.stderr.trim()}`);
  }

  return false;
}

export const writerKey = 'lzGardening.writer';

export function startLog(site: Located): void {
  writeLogIfStill(site, null, [{ path: 'garden.json', text: JSON.stringify({ format: logFormat }) }]);
}

export function plantWriter(site: string): void {
  if (configValue(site, writerKey) === undefined) {
    git(site, ['config', writerKey, randomUUID()]);
    forgetConfig(site);
  }
}

export function siteOf(cwd: string): Located {
  const checkout = resolve(mainCheckout(cwd));

  if (basename(checkout).endsWith('.garden')) {
    throw new Error(`${cwd} is in a garden site or bed; run the garden scripts from the repository's checkout`);
  }

  return { checkout, path: join(dirname(checkout), `${basename(checkout)}.garden`) };
}

export interface Site {
  readonly checkout: string;
  readonly path: string;
  readonly writer: string;
}

export type Located = Pick<Site, 'checkout' | 'path'>;

export function requireSite(path: string): void {
  if (!existsSync(join(path, '.git'))) {
    throw new Error(`no garden site at ${path}; run site.ts open first`);
  }
}

export function openSite(cwd: string): Site {
  const { checkout, path } = siteOf(cwd);
  requireSite(path);

  return withWriter({ checkout, path });
}

export function withWriter({ checkout, path }: Located): Site {
  const writer = configValue(path, writerKey);

  if (writer === undefined) {
    throw new Error(`no writer id (${writerKey}) at ${path}; run site.ts open first`);
  }

  return { checkout, path, writer };
}

interface Skipped {
  readonly path: string;
  readonly why: string;
}

export interface Replica {
  readonly tip: string;
  readonly events: readonly GardenEvent[];
  readonly skipped: readonly Skipped[];
}

function blobsAt(
  site: string,
  commit: string,
): {
  readonly texts: ReadonlyMap<string, string>;
  readonly skipped: readonly Skipped[];
} {
  const listed = treeEntries(git(site, ['ls-tree', '-r', '-z', commit], { readsOnly: true }));
  const read = catFileBatch(
    site,
    listed.filter(({ type }) => type === 'blob'),
    ({ oid }) => oid,
  );
  const texts = new Map(
    read.flatMap(([{ path }, object]) => (object.kind === 'blob' ? [[path, object.text] as const] : [])),
  );
  const missing = read.flatMap(([{ oid, path }, object]) => {
    if (object.kind === 'other') {
      throw new Error(
        `git cat-file --batch: read ${JSON.stringify(object.header)} for ${path}, not ${oid} blob <size>`,
      );
    }

    return object.kind === 'missing' ? [{ path, why: 'missing from the site' }] : [];
  });
  const skipped = [
    ...listed.filter(({ type }) => type !== 'blob').map(({ type, path }) => ({ path, why: `a ${type}, not a file` })),
    ...missing,
  ];

  return { texts, skipped };
}

const gardenSchema = z.object({ format: z.int().positive() });

export function formatOf(gardenJson: string | undefined): number {
  if (gardenJson === undefined) {
    throw new Error(`${logRef} has no garden.json`);
  }

  let garden: unknown;

  try {
    garden = JSON.parse(gardenJson);
  } catch {
    throw new Error(`${logRef}:garden.json is not JSON`);
  }

  const parsed = gardenSchema.safeParse(garden);

  if (!parsed.success) {
    throw new Error(`${logRef}:garden.json names no log format`);
  }

  return parsed.data.format;
}

export function readReplica(site: string, tip: string): Replica {
  const { texts: blobs, skipped } = blobsAt(site, tip);
  const format = formatOf(blobs.get('garden.json'));

  if (format !== logFormat) {
    throw new Error(
      `${logRef} is in format ${JSON.stringify(format)}, which this version cannot read; update lz-gardening`,
    );
  }

  const parsed = [...blobs]
    .filter(([path]) => path !== 'garden.json')
    .map(([path, text]) => ({ path, event: parseEvent(path, text) }));

  return {
    tip,
    events: parsed.flatMap(({ event }) => (typeof event === 'string' ? [] : [event])),
    skipped: [
      ...skipped,
      ...parsed.flatMap(({ path, event }) => (typeof event === 'string' ? [{ path, why: event }] : [])),
    ],
  };
}

export function noLogAt(site: string): Error {
  return new Error(`no garden log at ${site}; run site.ts open first`);
}

export function readLog(site: Pick<Site, 'path'>): Replica {
  const tip = refTip(site.path, logRef);

  if (tip === undefined) {
    throw noLogAt(site.path);
  }

  return readReplica(site.path, tip);
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a writer spends is policy; the bound is tested through append's tries
const appendTries = 50;

export function machinePathTest(site: Located): (text: string) => boolean {
  const fold = (text: string): string => text.replaceAll(/[\\/]+/g, '/').toLowerCase();
  const paths = [homedir(), site.checkout, site.path]
    .map((path) => fold(path).replace(/\/+$/, ''))
    .filter((path) => !/^(?:[a-z]:)?$/.test(path))
    // Git Bash writes d:/x as /d/x, WSL as /mnt/d/x and Cygwin as /cygdrive/d/x.
    .flatMap((path) => [
      path,
      ...['/', '/mnt/', '/cygdrive/'].map((prefix) => path.replace(/^([a-z]):\//, `${prefix}$1/`)),
    ]);
  const holds = (text: string, path: string): boolean => {
    for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
      if (!/[\w.-]/.test(text.charAt(at - 1)) && !/[\w.-]/.test(text.charAt(at + path.length))) {
        return true;
      }
    }

    return false;
  };

  return (text) => paths.some((path) => holds(fold(text), path));
}

function refuseMachinePaths(site: Site, drafts: readonly EventDraft[]): void {
  const holdsMachinePath = machinePathTest(site);
  const field = drafts
    .flatMap((draft) => Object.entries(draft))
    .find(([, value]) => typeof value === 'string' && holdsMachinePath(value))?.[0];

  if (field !== undefined) {
    throw new Error(
      `the ${field} holds a path on this machine; the queue is shared with the repository, so write paths repository-relative`,
    );
  }
}

// Appends the drafts a plan of the current log gives, planning again on the new log while another writer moves it,
// and returns the plan that landed.
export function append<T extends { readonly drafts: readonly EventDraft[] }>(
  site: Site,
  plan: (replica: Replica) => T,
  now: Date,
  tries = appendTries,
): T {
  for (let attempt = 1; ; attempt += 1) {
    const replica = readLog(site);
    const planned = plan(replica);
    const { drafts } = planned;

    if (drafts.length === 0) {
      return planned;
    }

    refuseMachinePaths(site, drafts);

    const maxClock = maxClockOf(replica.events);

    if (!Number.isSafeInteger(maxClock + drafts.length)) {
      throw new Error(`${logRef} holds clock ${String(maxClock)}; the next clock would pass the largest whole number`);
    }

    const files = stamp(drafts, maxClock, now).map((event) => ({
      path: eventPath(event.uuid),
      text: JSON.stringify(event),
    }));
    const skippedBecause = files
      .map(({ path, text }) => parseEvent(path, text))
      .find((read) => typeof read === 'string');

    if (skippedBecause !== undefined) {
      throw new Error(`an event to append would be skipped by every reader: ${skippedBecause}`);
    }

    if (writeLogIfStill(site, replica.tip, files)) {
      return planned;
    }

    if (attempt >= tries) {
      throw new Error(`${logRef} kept moving; ${String(tries)} tries to append failed`);
    }
  }
}
