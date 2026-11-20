#!/usr/bin/env node
// Usage, from the repository's checkout (the site is the <repo>.garden folder beside it):
//   node weeds.ts add --class <kebab> --where <path[:line]> [--where <path[:line]> ...] --source <kind:ref>
//                     --note <text> [--layer <1-6>] [--census <sha>]
//     Adds one weed per distinct --where (`./a` and `a//b` are recorded as `a` and `a/b`, so those spellings make
//     one weed; decline records its --where the same way), all in one append, with the same class, source and
//     note, and prints one line per weed: `added <id>`, `seen <id>` (already open), `kept <id>` (closed with --keep:
//     a weed left on purpose is never queued again) or
//     `regrown <id> after bed/<class>@<commit> (check: <where>)` (a tend pass closed its class, so the check that
//     was meant to hold it did not; the latest tend pass is named). The check reads
//     `(check: <where> not on the base)` when it is not on the census commit: <sha>, the full commit id of the
//     census this tick took, else the commit of the site's census. Then the bed has not landed, or one of the check's
//     files is gone from the base. It reads `(check: <where>, base unknown)` when there is no such census, the bed's or
//     the census's commit is in neither the site nor the checkout, or the bed shares no history with the base.
//     --source census:seed is for a line of the seed list alone: the class and path (line dropped) must be on a line
//     of the seed list of the census taken of <sha> and not yet recorded, else of the site's census; otherwise exit
//     2 with `no line of the seed list is <class> in <path>; census:seed is for those lines alone`.
//   node weeds.ts lines --class <kebab> [--census <sha>]
//     Prints each pattern line of the class on the seed list of the census taken of <sha> and not yet recorded, else
//     of the site's census, each followed by the hits that census holds for it, then `read <class> <token>`; prints
//     nothing without a census.
//   node weeds.ts decline --class <kebab> [--where <path>] --reason <text> [--in <path>] [--read <token>]
//                         [--census <sha>]
//     Leaves a seed line out of the queue: adds its weed with --source census:seed (so on a line of the seed list,
//     as for add) and keeps it (as close --keep <reason> would) in one append, so no later add queues it. Prints
//     `kept <id>`. Without --where it does this for every pattern line of the class that no add covers yet, one
//     weed at the line's path, and prints `declined <n> seed line(s) of <class>`; a class with no line on the seed
//     list exits 2 with `no line of the seed list is <class>; census:seed is for those lines alone`, and
//     duplicate-function exits 2 with `decline duplicate-function one file at a time, --where <path>, on the words
//     that keep that copy`. A seed line counts as covered once each of its paths has an add of its class. A
//     duplicate-function decline's reason must be words that <path>, or the record --in names, holds at the census's
//     commit (comment markers and line breaks aside), else exit 2 with `--reason must quote the words that keep this
//     copy, as <path> holds them at the census's commit`; --in on any other decline exits 2. Any other class's
//     decline needs --read, the token `lines --class <class>` printed for that census, else exit 2 with `run weeds
//     lines --class <class>, read every line it prints, and pass the token on its last line as --read`, or with
//     `--read <token> is not the token weeds lines --class <class> prints for this census; run it again and read every
//     line it prints`.
//   node weeds.ts close --id <id> <kind of close>
//   node weeds.ts close-class --class <kebab> <kind of close>
//     The kind of close is exactly one of: --tended bed/<class>@<commit> --check <where the check lives>
//     [--baselined <id>,<id>] (a tend pass added a check; close-class only), --one-off <reason> (no check written),
//     --keep <reason> (the weed is deliberate). Values are one line of text without control characters.
//     --check goes once per check file, a path spelled two ways (`./a`, `a`) counting once; each must be a file the
//     tended commit holds in the site (else exit 2 with `--check <path> is no file at <bed>`) and must not hold `, `,
//     which joins them in the close's check field (else exit 2).
//     --baselined names the weeds whose copies stay in the check's baseline: the close leaves them open. It exits 1
//     with `<id> is no open weed of <class>`, or `every open weed of <class> is baselined; the check holds none of
//     them`, and closes nothing. Both sync with origin before they plan and after they append, then print
//     `<closed|kept> <n>; <share state>`; the last sync's reason and notes (a bed origin did not take, a census it
//     left out or kept local, a claim it gave back), as site.ts words them, go to stderr. close-class acts only when
//     that first sync leaves the share state synced or local and this writer holds a live claim of the class, as bed
//     does; otherwise it exits 1 with `cannot check the claim of <class>: <state>[ (<reason>)]`, `this site holds no
//     claim of <class>; run weeds claim --class <class>` or `<class> is claimed by <holder> until <time>`, and
//     closes nothing. It ends this writer's claim of the class. close --id needs no claim, names a first sync other
//     than synced or local on stderr, and leaves the claim as it is; it exits 1 with `<class> is claimed by <holder>
//     until <time>`, closing nothing, while another writer holds one.
//   node weeds.ts claim [--class <kebab>]
//     Claims the class, or the first one groups --ready lists, for six hours, and shares the claim:
//     `claimed <class> until <time>`. Exit 1 with `taken <class> by <holder> until <time>`,
//     `nothing ready to tend`, `nothing open for <class>` or `cannot claim <class>: <state>[ (<reason>)]`, the last
//     after releasing the claim (`; release pending` when that release is not shared yet). Its first sync's notes go
//     to stderr, worded as close words them.
//   node weeds.ts release --class <kebab>
//     Ends this writer's claim and shares the release: `released <class>; <share state>`, with the sync's reason and
//     notes on stderr, as close does; exit 1 with `no claim of <class> held here`.
//   node weeds.ts groups [--min <n>|--ready]  open weeds per class, most first, and who holds a claim of it
//                                        (tending); --min <n> keeps the classes whose open weeds sit in n or more
//                                        files (places), and defaults to 1; --ready keeps the classes claim without
//                                        --class may take: ready, not stale-verification or repeated-lesson, and
//                                        claimed by no other writer; both together are a usage error
//   node weeds.ts list [--class <kebab>] open weeds, one per line; a regrown weed shows the bed and check, as add does
// A flag goes once per command, except --where with add and --check with close-class; given twice, it exits 2 with
// `--<flag> goes once with <command>`. A usage error is named before the site is looked for.
// Paths (--where, a lesson:<path> source, --check) are repository-relative, as given and in their plain form, and no
// event may hold this machine's home folder, the checkout's path or the site's path: the queue is shared with the
// repository (exit 2).
// An event file the log cannot read, or that these commands would not write (among them one with a line break or
// control character in a field the scripts print; references/site.md lists the rules), is skipped and named on
// stderr, with the characters that break or reorder a line written as \u{<hex>}; an add or close that has to read
// the log again, because another writer moved it, names it again.
// Exit 0 on success; 1 when a close finds nothing open, close-class lacks the claim or refuses its --baselined
// weeds, a close meets another writer's claim, or a claim or release is refused; 2 on a usage error or any other
// failure: no site, a damaged or newer log, a log that kept moving, or a git error.
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import {
  bedCommit,
  checkSeparator,
  claimableGroups,
  groupWeeds,
  planAdd,
  planDecline,
  planClaim,
  planClose,
  planRelease,
  releasesOfClaim,
  replay,
  weedIdPattern,
} from './log.ts';
import {
  bedPattern,
  classPattern,
  escapeUnprintable,
  hasText,
  isLayer,
  objectIdPattern,
  sourcePattern,
  unprintablePattern,
} from './log-fields.ts';
import type {
  AddInput,
  AddOutcome,
  ClaimEvent,
  ClaimPlan,
  CloseRequest,
  GardenEvent,
  Group,
  OpenWeed,
  TendedClose,
} from './log.ts';
import { isMainModule, processIo, reasonOf, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import { claimedByLine, claimRefusalLine } from './weeds-claim.ts';
import { offBaseIn } from './weeds-landed.ts';
import type { BaseLabel } from './weeds-landed.ts';
import { catFileBatch, configValue } from './store-git.ts';
import { append, openSite, readLog } from './store-log.ts';
import {
  censusIn,
  offSeedList,
  seedLinesIn,
  seedLinesLeft,
  seedLinesOf,
  seedLinesRead,
  seedLinesToken,
} from './census.ts';
import type { SeedLine } from './census.ts';
import type { Census } from './store-census.ts';
import { declineRefusal, declineUsageProblem } from './weeds-decline.ts';
import type { Decline } from './weeds-decline.ts';
import type { Replica, Site } from './store-log.ts';
import { isShared, sync, syncTries } from './store-sync.ts';
import type { SyncOptions, SyncResult } from './store-sync.ts';

function firstUnprintable(values: Readonly<Record<string, string | readonly string[] | undefined>>): string | null {
  const flag = Object.entries(values).find(([, value]) =>
    [value].flat().some((text) => text !== undefined && unprintablePattern.test(text)),
  )?.[0];

  return flag === undefined ? null : `--${flag} must be one line of text without control characters`;
}

const fromRootDriveOrHome = /^(?:[/\\~]|(?<driveLetter>[a-z]:(?!\d+$)))/i;
const throughParent = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
// A path is checked as given and in its plain form with `\` read as `/`: `./` or `.\` can hide the root, drive or `~`
// that normalizing exposes.
function notRepositoryRelative(path: string): boolean {
  return [path, posix.normalize(path.replaceAll('\\', '/'))].some(
    (form) => fromRootDriveOrHome.test(form) || throughParent.test(form),
  );
}

/** The paths in their plain form (`./a` and `a//b` as `a` and `a/b`), each once, in the order given. */
function plainPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => posix.normalize(path)))];
}

export function validateAdd(input: AddInput): string | null {
  if (!classPattern.test(input.class)) {
    return '--class must be kebab-case';
  }

  if (!hasText(input.where)) {
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

  if (input.layer !== null && !isLayer(input.layer)) {
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
  readonly check?: readonly string[] | undefined;
  readonly baselined?: string | undefined;
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
  const byId = command === 'close';
  const target = byId ? flags.id : flags.class;

  if (chosen === undefined || !hasText(chosen.by) || target === undefined || !hasText(target)) {
    return `needs ${byId ? '--id' : '--class'} and exactly one of --tended, --one-off or --keep`;
  }

  if ((byId ? flags.class : flags.id) !== undefined) {
    return byId
      ? '--class goes with close-class; close takes --id alone'
      : '--id goes with close; close-class takes --class alone';
  }

  if (!byId && !classPattern.test(target)) {
    return '--class must be kebab-case';
  }

  const unprintable = firstUnprintable({
    id: flags.id,
    tended: flags.tended,
    'one-off': flags['one-off'],
    keep: flags.keep,
    check: flags.check,
  });

  if (unprintable !== null) {
    return unprintable;
  }

  const { kind, by } = chosen;
  const { check, baselined } = flags;

  if (baselined !== undefined && (byId || kind !== 'tended')) {
    return '--baselined goes with close-class --tended only';
  }

  const baselinedIds = baselined?.split(',') ?? [];

  if (!baselinedIds.every((id) => weedIdPattern.test(id))) {
    return '--baselined must be weed ids separated by commas';
  }

  if (kind !== 'tended') {
    return check === undefined
      ? { target: byId ? { id: target } : { class: target }, kind, by, check: null }
      : '--check goes with --tended only';
  }

  if (byId) {
    return '--tended closes a whole class; use close-class --class <class>';
  }

  if (check === undefined || !check.every(hasText)) {
    return '--tended needs --check <where the check lives>';
  }

  if (check.some(notRepositoryRelative)) {
    return '--check must be a repository-relative path';
  }

  if (check.some((path) => path.includes(checkSeparator))) {
    return `--check must not hold "${checkSeparator}", which separates the checks of one close`;
  }

  return bedPattern.exec(by)?.[1] === target
    ? {
        target: { class: target, baselined: baselinedIds },
        kind,
        by,
        check: plainPaths(check),
      }
    : `--tended must be bed/${target}@<commit>, got ${by}`;
}

const labelText: Readonly<Record<BaseLabel, string>> = {
  'no label': '',
  'not on the base': ' not on the base',
  'base unknown': ', base unknown',
};

function after(tended: TendedClose, label: BaseLabel): string {
  return `after ${tended.by} (check: ${tended.check}${labelText[label]})`;
}

export function addStatus(outcome: AddOutcome, offBase: (tended: TendedClose) => BaseLabel): string {
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

function takenLine(owner: ClaimEvent): string {
  return `taken ${owner.class} by ${owner.holder} until ${owner.until}\n`;
}

function claimRefusalOut(planned: Exclude<ClaimPlan, { readonly said: 'claimed' }>): string {
  switch (planned.said) {
    case 'taken': {
      return takenLine(planned.claim);
    }
    case 'nothing open': {
      return `nothing open for ${planned.class}\n`;
    }
    case 'nothing ready': {
      return 'nothing ready to tend\n';
    }
  }
}

const claimRounds = 3;

function claim(io: Io, site: Site, wanted: string | null, now: Date, seams: SyncSeams): number {
  const holder = holderOf(site);
  reportSyncNotes(io, 'claim', sync(site, { ...seams, attempts: syncTries.quick }, now));
  let owner: ClaimEvent | undefined;
  const rounds = wanted === null ? claimRounds : 1;

  for (let round = 1; round <= rounds; round += 1) {
    const planned = append(
      site,
      (replica) => planClaim(eventsReportingSkipped(io, replica), wanted, site.writer, holder, now),
      now,
    );

    if (planned.said !== 'claimed') {
      io.out(claimRefusalOut(planned));

      return 1;
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

function parseFlags(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      class: { type: 'string' },
      where: { type: 'string', multiple: true },
      // Stryker disable next-line StringLiteral: an add without --source fails validation, and so does the mutant's text
      source: { type: 'string', default: '' },
      note: { type: 'string', default: '' },
      layer: { type: 'string' },
      census: { type: 'string' },
      in: { type: 'string' },
      read: { type: 'string' },
      id: { type: 'string' },
      tended: { type: 'string' },
      'one-off': { type: 'string' },
      keep: { type: 'string' },
      reason: { type: 'string', default: '' },
      check: { type: 'string', multiple: true },
      baselined: { type: 'string' },
      min: { type: 'string' },
      ready: { type: 'boolean', default: false },
    },
  });
}

type Flags = ReturnType<typeof parseFlags>['values'];

/** The flags the parser takes more than once (`multiple: true`). */
type RepeatableFlag = {
  [Flag in keyof Flags]-?: Flags[Flag] extends readonly string[] | undefined ? Flag : never;
}[keyof Flags];

// Number() also reads hex, exponents and padding.
function wholeNumber(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function writeLine(io: Io, line: string): void {
  io.out(`${line}\n`);
}

function add(io: Io, flags: Flags, now: Date): number {
  const wheres = flags.where ?? [''];
  const inputOf = (where: string): AddInput => ({
    // Stryker disable next-line StringLiteral: an add without --class fails validation, and so does the mutant's text
    class: flags.class ?? '',
    where,
    source: flags.source,
    note: flags.note,
    layer: flags.layer === undefined ? null : wholeNumber(flags.layer),
  });
  const problem = censusProblem(flags.census) ?? firstOf(wheres.map(inputOf), validateAdd);

  if (problem !== null) {
    io.err(`weeds add: ${problem}\n`);

    return 2;
  }

  const inputs = plainPaths(wheres).map(inputOf);

  const site = openSite(io.cwd);
  const seeds = flags.source === 'census:seed' ? seedLinesIn(site.path, flags.census) : undefined;
  const offList = seeds === undefined ? null : firstOf(inputs, (input) => offSeedList(seeds, input.class, input.where));

  if (offList !== null) {
    io.err(`weeds add: ${offList}\n`);

    return 2;
  }

  const offBase = offBaseIn(io.cwd, site.path, flags.census);
  // The status is worked out before the event is written, so a git failure in the bed check writes nothing.
  const { status } = append(
    site,
    (replica) => {
      const events = eventsReportingSkipped(io, replica);
      const outcomes = inputs.map((input) => planAdd(events, input, now));

      return {
        drafts: outcomes.flatMap((outcome) => outcome.drafts),
        status: outcomes.map((outcome) => addStatus(outcome, offBase)).join('\n'),
      };
    },
    now,
  );
  writeLine(io, status);

  return 0;
}

/** The first problem `check` finds among `items`, or null. */
function firstOf<T>(items: readonly T[], check: (item: T) => string | null): string | null {
  return items.map(check).find((problem) => problem !== null) ?? null;
}

function censusProblem(census: string | undefined): string | null {
  return census === undefined || objectIdPattern.test(census)
    ? null
    : '--census must be the full commit id census.ts printed';
}

function decline(io: Io, flags: Flags, now: Date): number {
  const [where] = plainPaths(flags.where ?? []);
  const input: AddInput = {
    // Stryker disable next-line StringLiteral: a decline without --class fails validation, and so does the mutant's text
    class: flags.class ?? '',
    // Validated as given. With no --where the seed lines name the paths, all repository-relative; `.` stands in.
    where: flags.where?.[0] ?? '.',
    source: 'census:seed',
    note: flags.reason,
    layer: null,
  };
  const request: Decline = { weedClass: input.class, where, record: flags.in, reason: input.note };
  const problem =
    declineUsageProblem(request) ??
    firstUnprintable({ in: flags.in }) ??
    censusProblem(flags.census) ??
    (hasText(flags.reason) ? validateAdd(input) : '--reason must not be empty');

  if (problem !== null) {
    io.err(`weeds decline: ${problem}\n`);

    return 2;
  }

  const site = openSite(io.cwd);
  const census = censusIn(site.path, flags.census);
  const refusal = declineRefusal(io.cwd, site, census, request) ?? unreadRefusal(census, input.class, flags.read);

  if (refusal !== null) {
    io.err(`weeds decline: ${refusal}\n`);

    return 2;
  }

  if (where === undefined) {
    return declineClass(io, site, seedLinesOf(census, input.class), input, now);
  }

  const { status } = append(
    site,
    (replica) => {
      const { id, drafts } = planDecline(eventsReportingSkipped(io, replica), { ...input, where }, now);

      return { drafts, status: `kept ${id}` };
    },
    now,
  );
  writeLine(io, status);

  return 0;
}

/** Why a decline of a pattern class's seed lines needs `weeds lines` first, or null when --read is its token. */
function unreadRefusal(census: Census | undefined, weedClass: string, read: string | undefined): string | null {
  if (weedClass === 'duplicate-function' || census === undefined) {
    return null;
  }

  if (read === undefined) {
    return `run weeds lines --class ${weedClass}, read every line it prints, and pass the token on its last line as --read`;
  }

  return read === seedLinesToken(census, weedClass)
    ? null
    : `--read ${read} is not the token weeds lines --class ${weedClass} prints for this census; run it again and read every line it prints`;
}

function lines(io: Io, flags: Flags): number {
  const census = censusIn(openSite(io.cwd).path, flags.census);
  const weedClass = flags.class ?? '';

  if (census !== undefined) {
    [...seedLinesRead(census, weedClass), `read ${weedClass} ${seedLinesToken(census, weedClass)}`].forEach((line) => {
      writeLine(io, line);
    });
  }

  return 0;
}

function declineClass(io: Io, site: Site, seeds: readonly SeedLine[], input: AddInput, now: Date): number {
  const { status } = append(
    site,
    (replica) => {
      const events = eventsReportingSkipped(io, replica);
      const left = seedLinesLeft(seeds, events);

      return {
        drafts: left
          .flatMap((seed) => seed.paths)
          .flatMap((where) => planDecline(events, { ...input, where }, now).drafts),
        status: `declined ${String(left.length)} seed line${left.length === 1 ? '' : 's'} of ${input.class}`,
      };
    },
    now,
  );
  writeLine(io, status);

  return 0;
}

function reportShared(io: Io, command: string, shared: SyncResult): void {
  if (shared.reason !== undefined) {
    io.err(`weeds ${command}: ${escapeUnprintable(shared.reason)}\n`);
  }

  reportSyncNotes(io, command, shared);
}

function reportSyncNotes(io: Io, command: string, result: SyncResult): void {
  result.notes.forEach((note) => {
    io.err(`weeds ${command}: ${note}\n`);
  });
}

/** The first of the close's check files that the tended bed commit does not hold. */
function checkMissingFromBed(site: Site, by: string, checks: readonly string[]): string | undefined {
  const commit = bedCommit(by);

  return catFileBatch(site.path, checks, (path) => `${commit}:${path}`).find(
    ([, object]) => object.kind !== 'blob',
  )?.[0];
}

function close(io: Io, command: 'close' | 'close-class', flags: Flags, now: Date, seams: SyncSeams): number {
  const request = parseCloseFlags(command, flags);

  if (typeof request === 'string') {
    io.err(`weeds ${command}: ${request}\n`);

    return 2;
  }

  const site = openSite(io.cwd);
  const missingCheck = request.kind === 'tended' ? checkMissingFromBed(site, request.by, request.check) : undefined;

  if (missingCheck !== undefined) {
    io.err(`weeds ${command}: --check ${missingCheck} is no file at ${request.by}\n`);

    return 2;
  }

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
      io.err(`weeds ${command}: ${claimedByLine(outcome.claim)}\n`);

      return 1;
    }
    case 'baselined not open': {
      io.err(`weeds ${command}: ${outcome.id} is no open weed of ${outcome.class}\n`);

      return 1;
    }
    case 'all baselined': {
      io.err(`weeds ${command}: every open weed of ${outcome.class} is baselined; the check holds none of them\n`);

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
      writeLine(io, `${outcome.said} ${String(outcome.closed.length)}; ${shared.state}`);
      reportShared(io, command, shared);

      return 0;
    }
  }
}

function claimCommand(io: Io, flags: Flags, now: Date, seams: SyncSeams): number {
  if (flags.class !== undefined && !classPattern.test(flags.class)) {
    io.err('weeds claim: --class must be kebab-case\n');

    return 2;
  }

  return claim(io, openSite(io.cwd), flags.class ?? null, now, seams);
}

function release(io: Io, flags: Flags, now: Date, seams: SyncSeams): number {
  // Stryker disable next-line StringLiteral: a release without --class fails validation, and so does the mutant's text
  const weedClass = flags.class ?? '';

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
    writeLine(io, `no claim of ${weedClass} held here`);

    return 1;
  }

  const shared = sync(site, { ...seams, attempts: syncTries.sharing }, now);
  writeLine(io, `released ${weedClass}; ${shared.state}`);
  reportShared(io, 'release', shared);

  return 0;
}

function groups(io: Io, flags: Flags, now: Date): number {
  if (flags.ready && flags.min !== undefined) {
    io.err('weeds groups: --ready and --min go apart; give one or the other\n');

    return 2;
  }

  const minText = flags.min ?? '1';
  const min = wholeNumber(minText);

  if (!Number.isInteger(min) || min < 1) {
    io.err(`weeds groups: --min must be a whole number of at least 1, got ${minText}\n`);

    return 2;
  }

  const site = openSite(io.cwd);
  const garden = replay(eventsReportingSkipped(io, readLog(site)), now);
  const listed = flags.ready
    ? claimableGroups(garden, site.writer)
    : groupWeeds(garden.open).filter((group) => group.places >= min);
  writeLine(io, `${'class'.padEnd(36)} open places regrown layer first-seen tending`);

  listed.forEach((group) => {
    writeLine(io, groupRow(group, garden.claims.get(group.class)?.holder ?? '-'));
  });

  return 0;
}

function groupRow(group: Group, tending: string): string {
  return `${group.class.padEnd(36)} ${String(group.open).padStart(4)} ${String(group.places).padStart(6)} ${String(group.regrown).padStart(7)} ${String(group.layer ?? '-').padStart(5)} ${group.firstAt.slice(0, 10)} ${tending}`;
}

function weedRow(weed: OpenWeed, offBase: (tended: TendedClose) => BaseLabel): string {
  const regrown =
    weed.regrownAfter === null ? '' : ` [regrown ${after(weed.regrownAfter, offBase(weed.regrownAfter))}]`;

  return `${weed.id} ${weed.class} ${weed.where} [${weed.source}]${regrown} ${weed.note}`;
}

function list(io: Io, flags: Flags, now: Date): number {
  const only = flags.class;
  const site = openSite(io.cwd);
  const offBase = offBaseIn(io.cwd, site.path, undefined);

  replay(eventsReportingSkipped(io, readLog(site)), now)
    .open.filter((weed) => only === undefined || weed.class === only)
    .forEach((weed) => {
      writeLine(io, weedRow(weed, offBase));
    });

  return 0;
}

interface Command {
  readonly name: string;
  readonly flags: readonly (keyof Flags)[];
  /** The repeatable flags this command takes more than once; any other flag given twice is refused. */
  readonly repeatable: readonly RepeatableFlag[];
  readonly run: (io: Io, flags: Flags, now: Date, seams: SyncSeams) => number;
}

const closeFlags: readonly (keyof Flags)[] = ['id', 'class', 'tended', 'one-off', 'keep', 'check', 'baselined'];

const commands: readonly Command[] = [
  { name: 'add', flags: ['class', 'where', 'source', 'note', 'layer', 'census'], repeatable: ['where'], run: add },
  { name: 'decline', flags: ['class', 'where', 'reason', 'in', 'read', 'census'], repeatable: [], run: decline },
  { name: 'lines', flags: ['class', 'census'], repeatable: [], run: lines },
  {
    name: 'close',
    flags: closeFlags,
    repeatable: [],
    run: (io, flags, now, seams) => close(io, 'close', flags, now, seams),
  },
  {
    name: 'close-class',
    flags: closeFlags,
    repeatable: ['check'],
    run: (io, flags, now, seams) => close(io, 'close-class', flags, now, seams),
  },
  { name: 'claim', flags: ['class'], repeatable: [], run: claimCommand },
  { name: 'release', flags: ['class'], repeatable: [], run: release },
  { name: 'groups', flags: ['min', 'ready'], repeatable: [], run: groups },
  { name: 'list', flags: ['class'], repeatable: [], run: list },
];

function main(argv: readonly string[], io: Io, now: Date, seams: SyncSeams): number {
  const { positionals, values, tokens } = parseFlags(argv);
  const command = positionals.length === 1 ? commands.find(({ name }) => name === positionals[0]) : undefined;

  if (command === undefined) {
    io.err(
      'usage: weeds.ts add|lines|decline|close|close-class|claim|release|groups|list ... (see the header of weeds.ts)\n',
    );

    return 2;
  }

  const named = tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []));
  const stray = named.find((flag) => !command.flags.some((name) => name === flag));

  if (stray !== undefined) {
    io.err(`weeds ${command.name}: --${stray} is not an option of ${command.name}\n`);

    return 2;
  }

  const repeated = named.find(
    (flag, index) => named.indexOf(flag) !== index && !command.repeatable.some((name) => name === flag),
  );

  if (repeated !== undefined) {
    io.err(`weeds ${command.name}: --${repeated} goes once with ${command.name}\n`);

    return 2;
  }

  return command.run(io, values, now, seams);
}

export function run(argv: readonly string[], io: Io, now = new Date(), seams: SyncSeams = {}): number {
  return runCommand('weeds', io, () => main(argv, io, now, seams));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), processIo());
}
