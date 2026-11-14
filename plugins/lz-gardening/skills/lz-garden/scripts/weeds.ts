#!/usr/bin/env node
// Usage, from the repository's checkout (the site is the <repo>.garden folder beside it):
//   node weeds.ts add --class <kebab> --where <path[:line]> --source <kind:ref> --note <text> [--layer <1-6>]
//                     [--census <sha>]
//     Prints `added <id>`, `seen <id>` (already open), `kept <id>` (closed with --keep: a weed left on purpose is
//     never queued again) or `regrown <id> after bed/<class>@<commit> (check: <where>)` (a tend pass closed its
//     class, so the check that was meant to hold it did not; the latest tend pass is named). The check reads
//     `(check: <where> not on the base)` when it is not on the census commit: <sha>, the full commit id of the
//     census this tick took, else the commit of the site's census. Then the bed has not landed, or the check's file
//     is gone from the base.
//   node weeds.ts close --id <id> <kind of close>
//   node weeds.ts close-class --class <kebab> <kind of close>
//     The kind of close is exactly one of: --tended bed/<class>@<commit> --check <where the check lives> (a tend
//     pass added a check; close-class only), --one-off <reason> (no check written), --keep <reason> (the weed is
//     deliberate). Values are one line of text without control characters. Both sync with origin before they plan
//     and after they append, then print `<closed|kept> <n>; <share state>`; a bed origin did not take is named on
//     stderr. close-class acts only when that first sync leaves the share state synced or local and this writer
//     holds a live claim of the class, as bed does; otherwise it exits 1 with `cannot check the claim of <class>:
//     <state> (<reason>)`, `this site holds no claim of <class>; run weeds claim --class <class>` or `<class> is
//     claimed by <holder> until <time>`, and closes nothing. It ends this writer's claim of the class. close --id
//     needs no claim, names a first sync other than synced or local on stderr, and leaves the claim as it is.
//   node weeds.ts claim [--class <kebab>]
//     Claims the class, or the first ready one (open weeds in two or more files, claimed by no other writer), for six hours,
//     and shares the claim: `claimed <class> until <time>`. Exit 1 with `taken <class> by <holder> until <time>`,
//     `nothing ready to tend`, `nothing open for <class>` or `cannot claim <class>: <state> (<reason>)`, the last
//     after releasing the claim (`; release pending` when that release is not shared yet).
//   node weeds.ts release --class <kebab>
//     Ends this writer's claim and shares the release: `released <class>; <share state>`; exit 1 with
//     `no claim of <class> held here`.
//   node weeds.ts groups [--min <n>|--ready]  open weeds per class, most first, and who holds a claim of it
//                                        (tending); --min <n> keeps the classes whose open weeds sit in n or more
//                                        files (places), and defaults to 1; --ready keeps the classes claim without
//                                        --class may take: ready, not stale-verification or repeated-lesson, and
//                                        claimed by no other writer; both together are a usage error
//   node weeds.ts list [--class <kebab>] open weeds, one per line; a regrown weed shows the bed and check, as add does
// Paths (--where, a lesson:<path> source, --check) are repository-relative, and no event may hold this machine's home
// folder, the checkout's path or the site's path: the queue is shared with the repository (exit 2).
// An event file the log cannot read, or whose text holds a line break or control character, is skipped and named on
// stderr, with the characters that break or reorder a line written as \u{<hex>}; an add or close that has to read the
// log again, because another writer moved it, names it again.
// Exit 0 on success; 1 when a close finds nothing open, close-class lacks the claim, or a claim or release is
// refused; 2 on a usage error or any other failure: no site, a damaged or newer log, a log that kept moving, or a
// git error.
import { parseArgs } from 'node:util';
import {
  bedCommit,
  bedPattern,
  claimableGroups,
  classPattern,
  groupWeeds,
  planAdd,
  planClaim,
  planClose,
  planRelease,
  releasedClaims,
  replay,
  unprintablePattern,
} from './log.ts';
import type { AddInput, AddOutcome, ClaimEvent, CloseRequest, EventDraft, GardenEvent, TendedClose } from './log.ts';
import { claimRefusalLine, escapeUnprintable, isMainModule, processIo, reasonOf, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import { configValue, git, gitSucceeds, objectIdPattern, optionalGit } from './store-git.ts';
import { append, openSite, readLog } from './store-log.ts';
import type { Replica, Site } from './store-log.ts';
import { censusRef, readCensusAt } from './store-census.ts';
import { isShared, sync, syncTries } from './store-sync.ts';
import type { SyncOptions } from './store-sync.ts';

const sourcePattern = /^[a-z][a-z-]*:\S/;

function firstUnprintable(values: Readonly<Record<string, string | undefined>>): string | null {
  // Stryker disable next-line StringLiteral: an absent flag has no text, and the mutant's text has no control character either
  const flag = Object.entries(values).find(([, value]) => unprintablePattern.test(value ?? ''))?.[0];

  return flag === undefined ? null : `--${flag} must be one line of text without control characters`;
}

const fromRootDriveOrHome = /^(?:[/\\~]|[a-z]:)/i;
const throughParent = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
function notRepositoryRelative(path: string): boolean {
  return fromRootDriveOrHome.test(path) || throughParent.test(path);
}

export function validateAdd(input: AddInput): string | null {
  if (!classPattern.test(input.class)) {
    return '--class must be kebab-case';
  }

  if (input.where.trim() === '') {
    return '--where must not be empty';
  }

  const unprintable = firstUnprintable({ where: input.where, source: input.source, note: input.note });

  if (unprintable !== null) {
    return unprintable;
  }

  if (notRepositoryRelative(input.where)) {
    return '--where must be a repository-relative path';
  }

  if (input.source.startsWith('lesson:') && notRepositoryRelative(input.source.slice('lesson:'.length))) {
    return '--source lesson:<path> must be a repository-relative path';
  }

  if (!sourcePattern.test(input.source)) {
    return '--source must look like <kind>:<ref>, for example commit:1a2b3c4 or census:eslint-disable';
  }

  if (input.class === 'repeated-lesson' && !input.source.startsWith('lesson:')) {
    return "--class repeated-lesson takes --source lesson:<path>:<line>, a record that holds the lesson; queue a clean-up that did not hold under the mistake's own class";
  }

  if (input.layer !== null && !(Number.isInteger(input.layer) && input.layer >= 1 && input.layer <= 6)) {
    return '--layer must be an integer from 1 to 6';
  }

  return null;
}

export interface CloseFlags {
  readonly id?: string | undefined;
  readonly class?: string | undefined;
  readonly tended?: string | undefined;
  readonly 'one-off'?: string | undefined;
  readonly keep?: string | undefined;
  readonly check?: string | undefined;
}

/** The close a command's flags ask for, or what is wrong with them. */
export function parseCloseFlags(command: 'close' | 'close-class', flags: CloseFlags): CloseRequest | string {
  const kinds = (
    [
      ['tended', flags.tended],
      ['one-off', flags['one-off']],
      ['kept', flags.keep],
    ] as const
  ).flatMap(([kind, by]) => (by === undefined ? [] : [{ kind, by }]));
  const chosen = kinds.length === 1 ? kinds[0] : undefined;
  const target = command === 'close' ? flags.id : flags.class;

  if (chosen === undefined || chosen.by.trim() === '' || target === undefined) {
    return `needs ${command === 'close' ? '--id' : '--class'} and exactly one of --tended, --one-off or --keep`;
  }

  const unprintable = firstUnprintable({
    tended: flags.tended,
    'one-off': flags['one-off'],
    keep: flags.keep,
    check: flags.check,
  });

  if (unprintable !== null) {
    return unprintable;
  }

  const { kind, by } = chosen;
  const { check } = flags;

  if (kind !== 'tended') {
    return check === undefined
      ? { target: command === 'close' ? { id: target } : { class: target }, kind, by, check: null }
      : '--check goes with --tended only';
  }

  if (command === 'close') {
    return '--tended closes a whole class; use close-class --class <class>';
  }

  if (check === undefined || check.trim() === '') {
    return '--tended needs --check <where the check lives>';
  }

  if (notRepositoryRelative(check)) {
    return '--check must be a repository-relative path';
  }

  return bedPattern.exec(by)?.[1] === target
    ? { target: { class: target }, kind, by, check }
    : `--tended must be bed/${target}@<commit>, got ${by}`;
}

function after(tended: TendedClose, offBase: boolean): string {
  return `after ${tended.by} (check: ${tended.check}${offBase ? ' not on the base' : ''})`;
}

function shaOfReadableCensus(site: string): string | undefined {
  const recorded = readCensusAt(site, censusRef);
  const sha = typeof recorded === 'object' ? recorded?.census.sha : undefined;

  return sha !== undefined && objectIdPattern.test(sha) ? sha : undefined;
}

function checkOffBase(io: Io, site: string, census: string | undefined, tended: TendedClose): boolean {
  const tip = bedCommit(tended);
  const base = census ?? shaOfReadableCensus(site);
  const where = tended.check;

  if (base === undefined) {
    return false;
  }

  if (where.trim() === '') {
    return false;
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
  const hasCheck = (commit: string): boolean => gitSucceeds(io.cwd, ['cat-file', '-e', `${commit}:${where}`], withSite);
  const fork = optionalGit(io.cwd, ['merge-base', tip, base], withSite);

  if (fork === undefined || !hasCheck(tip)) {
    return false;
  }

  if (!hasCheck(base)) {
    return true;
  }

  if (!hasCheck(fork)) {
    return false;
  }

  const diffOptions = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
  const checkPath = ['--', `:(top,literal)${where}`];
  const patchIdOf = (diffArgs: readonly string[]): string | undefined => {
    const diff = git(io.cwd, [...diffArgs, ...checkPath], withSite);

    return diff === '' ? undefined : git(io.cwd, ['patch-id'], { ...withSite, input: diff }).split(' ')[0];
  };
  const bedChange = patchIdOf(['diff', ...diffOptions, fork, tip]);
  const bedLeftCheckAsItWas = bedChange === undefined;

  if (bedLeftCheckAsItWas) {
    return false;
  }

  // An empty range prints nothing, which splits into one blank line, and a blank is no commit.
  const isCommit = (line: string): boolean => line !== '';
  const patchIdsIn = (range: string): (string | undefined)[] =>
    git(io.cwd, ['rev-list', '--no-merges', range, ...checkPath], withSite)
      .split('\n')
      .filter(isCommit)
      .map((commit) => patchIdOf(['diff-tree', '-p', '--root', '--no-commit-id', ...diffOptions, commit]));
  const onBase = new Set(patchIdsIn(`${fork}..${base}`));

  return !onBase.has(bedChange) && !patchIdsIn(`${fork}..${tip}`).every((id) => onBase.has(id));
}

export function addStatus(outcome: AddOutcome, offBase: (tended: TendedClose) => boolean): string {
  switch (outcome.said) {
    case 'seen':
    case 'kept':
    case 'added': {
      return `${outcome.said} ${outcome.id}`;
    }
    case 'regrown': {
      return `regrown ${outcome.id} ${after(outcome.after, offBase(outcome.after))}`;
    }
  }
}

function offBaseIn(io: Io, site: string, census: string | undefined): (tended: TendedClose) => boolean {
  const known = new Map<TendedClose, boolean>();

  return (tended) => {
    const offBase = known.get(tended) ?? checkOffBase(io, site, census, tended);
    // Stryker disable next-line CallExpression: without the cache, each weed works out the same label again
    known.set(tended, offBase);

    return offBase;
  };
}

function eventsReportingSkipped(io: Io, replica: Replica): readonly GardenEvent[] {
  replica.skipped.forEach(({ path, why }) => {
    io.err(`weeds: skipped ${escapeUnprintable(path)}: ${escapeUnprintable(why)}\n`);
  });

  return replica.events;
}

function holderOf(site: Site): string {
  return escapeUnprintable(configValue(site.checkout, 'lzGardening.name') ?? `writer ${site.writer.slice(0, 8)}`);
}

export type SyncSeams = Pick<SyncOptions, 'wait' | 'timeoutMs'>;

function releasesOfClaim(events: readonly GardenEvent[], draft: EventDraft<ClaimEvent>): readonly EventDraft[] {
  const released = releasedClaims(events);

  return events
    .filter(
      (event): event is ClaimEvent =>
        event.op === 'claim' &&
        event.writer === draft.writer &&
        event.class === draft.class &&
        event.until === draft.until &&
        !released.has(event.uuid),
    )
    .map((claim) => ({ op: 'release', class: claim.class, claim: claim.uuid }));
}

function takenLine(owner: ClaimEvent): string {
  return `taken ${owner.class} by ${owner.holder} until ${owner.until}\n`;
}

// Stryker disable next-line LzJsNumericLiteral: how many classes a claim without --class tries is policy
const claimRounds = 3;

function claim(io: Io, site: Site, wanted: string | null, now: Date, seams: SyncSeams): number {
  const holder = holderOf(site);
  sync(site, { ...seams, attempts: syncTries.quick }, now);
  let owner: ClaimEvent | undefined;

  for (let round = 1; round <= (wanted === null ? claimRounds : 1); round += 1) {
    const planned = append(
      site,
      (replica) => planClaim(eventsReportingSkipped(io, replica), wanted, site.writer, holder, now),
      now,
    );

    switch (planned.said) {
      case 'taken': {
        io.out(takenLine(planned.claim));

        return 1;
      }
      case 'nothing open': {
        io.out(`nothing open for ${planned.class}\n`);

        return 1;
      }
      case 'nothing ready': {
        io.out('nothing ready to tend\n');

        return 1;
      }
      case 'claimed': {
        break;
      }
    }

    const shared = sync(site, { ...seams, attempts: syncTries.sharing }, now);

    if (!isShared(shared)) {
      append(site, (replica) => ({ drafts: releasesOfClaim(replica.events, planned.drafts[0]) }), now);
      const pending = isShared(sync(site, { ...seams, attempts: syncTries.quick }, now)) ? '' : '; release pending';
      io.out(`cannot claim ${planned.class}: ${shared.state}${reasonOf(shared)}${pending}\n`);

      return 1;
    }

    owner = replay(readLog(site).events, now).claims.get(planned.class);

    if (owner?.writer === site.writer) {
      io.out(`claimed ${owner.class} until ${owner.until}\n`);

      return 0;
    }
  }

  // Stryker disable next-line ConditionalExpression: a claim that synced always has an owner, its own or another's
  if (owner !== undefined) {
    io.out(takenLine(owner));
  }

  return 1;
}

function main(argv: readonly string[], io: Io, now: Date, seams: SyncSeams): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      class: { type: 'string' },
      where: { type: 'string', default: '' },
      // Stryker disable next-line StringLiteral: an add without --source fails validation, and so does the mutant's text
      source: { type: 'string', default: '' },
      note: { type: 'string', default: '' },
      layer: { type: 'string' },
      census: { type: 'string' },
      id: { type: 'string' },
      tended: { type: 'string' },
      'one-off': { type: 'string' },
      keep: { type: 'string' },
      check: { type: 'string' },
      min: { type: 'string' },
      ready: { type: 'boolean', default: false },
    },
  });
  const command = positionals.length === 1 ? positionals[0] : undefined;
  const write = (line: string): void => {
    io.out(`${line}\n`);
  };

  switch (command) {
    case 'add': {
      const input: AddInput = {
        // Stryker disable next-line StringLiteral: an add without --class fails validation, and so does the mutant's text
        class: values.class ?? '',
        where: values.where,
        source: values.source,
        note: values.note,
        layer: values.layer === undefined ? null : Number(values.layer),
      };
      const problem =
        values.census === undefined || objectIdPattern.test(values.census)
          ? validateAdd(input)
          : '--census must be the full commit id census.ts printed';

      if (problem !== null) {
        io.err(`weeds add: ${problem}\n`);

        return 2;
      }

      const site = openSite(io.cwd);
      const offBase = offBaseIn(io, site.path, values.census);
      // The status is worked out before the event is written, so a git failure in the bed check writes nothing.
      const { status } = append(
        site,
        (replica) => {
          const outcome = planAdd(eventsReportingSkipped(io, replica), input, now);

          return { drafts: outcome.drafts, status: addStatus(outcome, offBase) };
        },
        now,
      );
      write(status);

      return 0;
    }
    case 'close':
    case 'close-class': {
      const request = parseCloseFlags(command, values);

      if (typeof request === 'string') {
        io.err(`weeds ${command}: ${request}\n`);

        return 2;
      }

      const site = openSite(io.cwd);
      const before = sync(site, { ...seams, attempts: syncTries.quick }, now);
      const refusal = 'class' in request.target ? claimRefusalLine(site, request.target.class, before, now) : undefined;

      if (refusal !== undefined) {
        io.err(`weeds ${command}: ${refusal}\n`);

        return 1;
      }

      if (!isShared(before)) {
        io.err(`weeds ${command}: planned ${before.state}${reasonOf(before)}\n`);
      }

      const outcome = append(
        site,
        (replica) => planClose(eventsReportingSkipped(io, replica), request, site.writer, now),
        now,
      );

      switch (outcome.said) {
        case 'claimed by another': {
          const { claim } = outcome;
          io.err(`weeds ${command}: ${claim.class} is claimed by ${claim.holder} until ${claim.until}\n`);

          return 1;
        }
        case 'nothing open': {
          const target = 'id' in request.target ? request.target.id : request.target.class;
          io.err(`weeds ${command}: nothing open for ${target}\n`);

          return 1;
        }
        case 'closed':
        case 'kept': {
          const shared = sync(site, { ...seams, attempts: syncTries.sharing }, now);
          write(`${outcome.said} ${String(outcome.closed.length)}; ${shared.state}`);

          if (shared.reason !== undefined) {
            io.err(`weeds ${command}: ${escapeUnprintable(shared.reason)}\n`);
          }

          shared.divergedBeds.forEach((bed) => {
            io.err(`weeds ${command}: ${escapeUnprintable(bed)}\n`);
          });

          return 0;
        }
      }
    }
    case 'claim': {
      if (values.class !== undefined && !classPattern.test(values.class)) {
        io.err('weeds claim: --class must be kebab-case\n');

        return 2;
      }

      return claim(io, openSite(io.cwd), values.class ?? null, now, seams);
    }
    case 'release': {
      const weedClass = values.class ?? '';

      if (!classPattern.test(weedClass)) {
        io.err('weeds release: --class must be kebab-case\n');

        return 2;
      }

      const site = openSite(io.cwd);
      const planned = append(
        site,
        (replica) => planRelease(eventsReportingSkipped(io, replica), weedClass, site.writer, now),
        now,
      );

      if (planned.said === 'no claim') {
        write(`no claim of ${weedClass} held here`);

        return 1;
      }

      write(`released ${weedClass}; ${sync(site, { ...seams, attempts: syncTries.sharing }, now).state}`);

      return 0;
    }
    case 'groups': {
      if (values.ready && values.min !== undefined) {
        io.err('weeds groups: --ready and --min go apart; give one or the other\n');

        return 2;
      }

      const minText = values.min ?? '1';
      const min = Number(minText);

      if (!Number.isInteger(min) || min < 1) {
        io.err(`weeds groups: --min must be a whole number of at least 1, got ${minText}\n`);

        return 2;
      }

      const site = openSite(io.cwd);
      const garden = replay(eventsReportingSkipped(io, readLog(site)), now);
      const groups = values.ready
        ? claimableGroups(garden, site.writer)
        : groupWeeds(garden.open).filter((group) => group.places >= min);
      write(`${'class'.padEnd(36)} open places regrown layer first-seen tending`);

      for (const group of groups) {
        const tending = garden.claims.get(group.class)?.holder ?? '-';
        write(
          `${group.class.padEnd(36)} ${String(group.open).padStart(4)} ${String(group.places).padStart(6)} ${String(group.regrown).padStart(7)} ${String(group.layer ?? '-').padStart(5)} ${group.firstAt.slice(0, 10)} ${tending}`,
        );
      }

      return 0;
    }
    case 'list': {
      const only = values.class;
      const site = openSite(io.cwd);
      const offBase = offBaseIn(io, site.path, undefined);

      for (const weed of replay(eventsReportingSkipped(io, readLog(site)), now).open.filter(
        (item) => only === undefined || item.class === only,
      )) {
        const regrown =
          weed.regrownAfter === null ? '' : ` [regrown ${after(weed.regrownAfter, offBase(weed.regrownAfter))}]`;
        write(`${weed.id} ${weed.class} ${weed.where} [${weed.source}]${regrown} ${weed.note}`);
      }

      return 0;
    }
    default: {
      io.err('usage: weeds.ts add|close|close-class|claim|release|groups|list ... (see the header of weeds.ts)\n');

      return 2;
    }
  }
}

export function run(argv: readonly string[], io: Io, now = new Date(), seams: SyncSeams = {}): number {
  return runCommand('weeds', io, () => main(argv, io, now, seams));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), processIo());
}
