// The garden site and its log: where the site is, and how events are read from and appended to refs/garden/log.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { eventPath, isRecord, parseEvent, stamp } from './log.ts';
import type { EventDraft, GardenEvent } from './log.ts';
import {
  catFileBatch,
  configValue,
  forgetConfig,
  git,
  gitEnv,
  mainCheckout,
  optionalGit,
  runGit,
  treeEntries,
  waitForRefLocks,
} from './store-git.ts';

export const logRef = 'refs/garden/log';

export const logFormat = 1;

export function data(text: string): string {
  return `data ${String(Buffer.byteLength(text))}\n${text}\n`;
}

export function identity(checkout: string, whose: 'author' | 'committer', now: string): string {
  const variable = `GIT_${whose.toUpperCase()}`;
  const name = configValue(checkout, 'lzGardening.name');
  const email = configValue(checkout, 'lzGardening.email');
  const signer = name === undefined || email === undefined ? 'lz-gardening <>' : `${name} <${email}>`;

  return `${whose} ${signer} ${gitEnv(checkout)[`${variable}_DATE`] ?? now}\n`;
}

type LogFile = { readonly path: string; readonly text: string } | { readonly path: string; readonly oid: string };

// fast-import moves the ref only by fast-forward, so a commit planned on the tip lands only while the ref names it,
// and a first commit lands only where there is no log. A merge parent adds history, not files: the tree is the tip's
// plus the files given.
export function writeLogIfStill(
  { path: site, checkout }: Pick<Site, 'path' | 'checkout'>,
  tip: string | null,
  files: readonly LogFile[],
  merge?: string,
): boolean {
  const now = `@${String(Math.floor(Date.now() / 1000))} +0000`;
  const stream = [
    `commit ${logRef}\n`,
    identity(checkout, 'author', now),
    identity(checkout, 'committer', now),
    data('garden: log\n'),
    ...(tip === null ? [] : [`from ${tip}\n`]),
    ...(merge === undefined ? [] : [`merge ${merge}\n`]),
    ...files.map((file) =>
      'oid' in file ? `M 100644 ${file.oid} ${file.path}\n` : `M 100644 inline ${file.path}\n${data(file.text)}`,
    ),
    'done\n',
  ].join('');
  const imported = runGit(site, [...waitForRefLocks, 'fast-import', '--quiet', '--done', '--date-format=rfc2822'], {
    input: stream,
  });

  if (imported.status === 0) {
    return true;
  }

  if (tip === null || git(site, ['rev-parse', '--verify', logRef]) === tip) {
    throw new Error(`git fast-import ${logRef}: ${imported.stderr.trim()}`);
  }

  return false;
}

export function moveLogIfStill(site: string, to: string, from: string): boolean {
  const args = [...waitForRefLocks, 'update-ref', logRef, to, from];
  const moved = runGit(site, args);

  if (moved.status !== 0 && git(site, ['rev-parse', '--verify', logRef]) === from) {
    throw new Error(`git ${args.join(' ')}: ${moved.stderr.trim()}`);
  }

  return moved.status === 0;
}

export const writerKey = 'lzGardening.writer';

export function startLog(site: Pick<Site, 'path' | 'checkout'>): void {
  writeLogIfStill(site, null, [{ path: 'garden.json', text: JSON.stringify({ format: logFormat }) }]);
}

export function plantWriter(site: string): void {
  if (configValue(site, writerKey) === undefined) {
    git(site, ['config', writerKey, randomUUID()]);
    forgetConfig(site);
  }
}

export function siteOf(cwd: string): { readonly checkout: string; readonly path: string } {
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

export function withWriter({ checkout, path }: Pick<Site, 'checkout' | 'path'>): Site {
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
  const texts = new Map(read.flatMap(([{ path }, { text }]) => (text === undefined ? [] : [[path, text] as const])));
  const missing = read.flatMap(([{ oid, path }, { header, type, text }]) => {
    if (text !== undefined) {
      return [];
    }

    if (type !== 'missing') {
      throw new Error(`git cat-file --batch: read ${JSON.stringify(header)} for ${path}, not ${oid} blob <size>`);
    }

    return [{ path, why: 'missing from the site' }];
  });
  const skipped = [
    ...listed.filter(({ type }) => type !== 'blob').map(({ type, path }) => ({ path, why: `a ${type}, not a file` })),
    ...missing,
  ];

  return { texts, skipped };
}

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

  const format = isRecord(garden) ? garden['format'] : undefined;

  if (typeof format !== 'number' || !Number.isSafeInteger(format) || format < 1) {
    throw new Error(`${logRef}:garden.json names no log format`);
  }

  return format;
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

export function readLog(site: Pick<Site, 'path'>): Replica {
  const tip = optionalGit(site.path, ['rev-parse', '--verify', '--quiet', logRef], { readsOnly: true });

  if (tip === undefined) {
    throw new Error(`no garden log at ${site.path}; run site.ts open first`);
  }

  return readReplica(site.path, tip);
}

// Stryker disable next-line LzJsNumericLiteral: how many tries a writer spends is policy; the bound is tested through append's tries
const appendTries = 50;

export function machinePathTest(site: Pick<Site, 'checkout' | 'path'>): (text: string) => boolean {
  const fold = (text: string): string => text.replaceAll(/[\\/]+/g, '/').toLowerCase();
  const paths = [homedir(), site.checkout, site.path]
    .map((path) => fold(path).replace(/\/+$/, ''))
    .filter((path) => !/^(?:[a-z]:)?$/.test(path))
    // Git Bash writes d:/x as /d/x, and WSL's /mnt/d/x and Cygwin's /cygdrive/d/x hold that too.
    .flatMap((path) => [path, path.replace(/^([a-z]):\//, '/$1/')]);
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

  for (const draft of drafts) {
    for (const [field, value] of Object.entries(draft)) {
      if (typeof value === 'string' && holdsMachinePath(value)) {
        throw new Error(
          `the ${field} holds a path on this machine; the queue is shared with the repository, so write paths repository-relative`,
        );
      }
    }
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

    const maxClock = replica.events.reduce((max, event) => Math.max(max, event.clock), 0);

    if (!Number.isSafeInteger(maxClock + drafts.length)) {
      throw new Error(`${logRef} holds clock ${String(maxClock)}; the next clock would pass the largest whole number`);
    }

    const events = stamp(drafts, maxClock, now);

    if (
      writeLogIfStill(
        site,
        replica.tip,
        events.map((event) => ({ path: eventPath(event.uuid), text: JSON.stringify(event) })),
      )
    ) {
      return planned;
    }

    if (attempt >= tries) {
      throw new Error(`${logRef} kept moving; ${String(tries)} tries to append failed`);
    }
  }
}
