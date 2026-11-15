#!/usr/bin/env node
// Usage, from the repository's checkout (the site is the <repo>.garden folder beside it):
//   node weeds.ts add --class <kebab> --where <path[:line]> --source <kind:ref> --note <text> [--layer <1-6>]
//                     [--census <sha>]
//     Prints `added <id>`, `seen <id>` (already open), `kept <id>` (closed with --keep: a weed left on purpose is
//     never queued again) or `regrown <id> after bed/<class>@<commit> (check: <where>)` (a tend pass closed its
//     class, so the check that was meant to hold it did not; the latest tend pass is named). The check reads
//     `(check: <where> not on the base)` when it is not on the census commit: <sha>, the full commit id of the
//     census this tick took, else the commit of the site's census. Then the bed has not landed, or the check's file
//     is gone from the base. It reads `(check: <where>, base unknown)` when there is no such census, the bed's or
//     the census's commit is in neither the site nor the checkout, or the bed shares no history with the base.
//   node weeds.ts close --id <id> <kind of close>
//   node weeds.ts close-class --class <kebab> <kind of close>
//     The kind of close is exactly one of: --tended bed/<class>@<commit> --check <where the check lives> (a tend
//     pass added a check; close-class only), --one-off <reason> (no check written), --keep <reason> (the weed is
//     deliberate). Values are one line of text without control characters. Both sync with origin before they plan
//     and after they append, then print `<closed|kept> <n>; <share state>`; the last sync's reason and a bed origin
//     did not take are named on stderr. close-class acts only when that first sync leaves the share state synced or
//     local and this writer holds a live claim of the class, as bed does; otherwise it exits 1 with `cannot check
//     the claim of <class>: <state>[ (<reason>)]`, `this site holds no claim of <class>; run weeds claim --class
//     <class>` or `<class> is claimed by <holder> until <time>`, and closes nothing. It ends this writer's claim of
//     the class. close --id needs no claim, names a first sync other than synced or local on stderr, and leaves the
//     claim as it is; it exits 1 with `<class> is claimed by <holder> until <time>`, closing nothing, while another
//     writer holds one.
//   node weeds.ts claim [--class <kebab>]
//     Claims the class, or the first one groups --ready lists, for six hours, and shares the claim:
//     `claimed <class> until <time>`. Exit 1 with `taken <class> by <holder> until <time>`,
//     `nothing ready to tend`, `nothing open for <class>` or `cannot claim <class>: <state>[ (<reason>)]`, the last
//     after releasing the claim (`; release pending` when that release is not shared yet). A bed origin did not take
//     in its first sync is named on stderr.
//   node weeds.ts release --class <kebab>
//     Ends this writer's claim and shares the release: `released <class>; <share state>`, with the sync's reason and
//     a bed origin did not take on stderr, as close does; exit 1 with `no claim of <class> held here`.
//   node weeds.ts groups [--min <n>|--ready]  open weeds per class, most first, and who holds a claim of it
//                                        (tending); --min <n> keeps the classes whose open weeds sit in n or more
//                                        files (places), and defaults to 1; --ready keeps the classes claim without
//                                        --class may take: ready, not stale-verification or repeated-lesson, and
//                                        claimed by no other writer; both together are a usage error
//   node weeds.ts list [--class <kebab>] open weeds, one per line; a regrown weed shows the bed and check, as add does
// Paths (--where, a lesson:<path> source, --check) are repository-relative, and no event may hold this machine's home
// folder, the checkout's path or the site's path: the queue is shared with the repository (exit 2).
// An event file the log cannot read, or that these commands would not write (among them one with a line break or
// control character in a field the scripts print; references/site.md lists the rules), is skipped and named on
// stderr, with the characters that break or reorder a line written as \u{<hex>}; an add or close that has to read
// the log again, because another writer moved it, names it again.
// Exit 0 on success; 1 when a close finds nothing open, close-class lacks the claim, a close meets another writer's
// claim, or a claim or release is refused; 2 on a usage error or any other failure: no site, a damaged or newer log,
// a log that kept moving, or a git error.
import { parseArgs } from 'node:util';
import {
  bedPattern,
  claimableGroups,
  classPattern,
  groupWeeds,
  hasText,
  isLayer,
  objectIdPattern,
  planAdd,
  planClaim,
  planClose,
  planRelease,
  releasesOfClaim,
  replay,
  sourcePattern,
  unprintablePattern,
} from './log.ts';
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
import { escapeUnprintable, isMainModule, processIo, reasonOf, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import { claimedByLine, claimRefusalLine } from './weeds-claim.ts';
import { offBaseIn } from './weeds-landed.ts';
import type { BaseLabel } from './weeds-landed.ts';
import { configValue } from './store-git.ts';
import { append, openSite, readLog } from './store-log.ts';
import type { Replica, Site } from './store-log.ts';
import { isShared, sync, syncTries } from './store-sync.ts';
import type { SyncOptions, SyncResult } from './store-sync.ts';

function firstUnprintable(values: Readonly<Record<string, string | undefined>>): string | null {
  // Stryker disable next-line StringLiteral: an absent flag has no text, and the mutant's text has no control character either
  const flag = Object.entries(values).find(([, value]) => unprintablePattern.test(value ?? ''))?.[0];

  return flag === undefined ? null : `--${flag} must be one line of text without control characters`;
}

const fromRootDriveOrHome = /^(?:[/\\~]|(?<driveLetter>[a-z]:(?!\d+$)))/i;
const throughParent = /(?:^|[/\\])\.\.(?:[/\\]|$)/;
function notRepositoryRelative(path: string): boolean {
  return fromRootDriveOrHome.test(path) || throughParent.test(path);
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
  const { check } = flags;

  if (kind !== 'tended') {
    return check === undefined
      ? { target: byId ? { id: target } : { class: target }, kind, by, check: null }
      : '--check goes with --tended only';
  }

  if (byId) {
    return '--tended closes a whole class; use close-class --class <class>';
  }

  if (check === undefined || !hasText(check)) {
    return '--tended needs --check <where the check lives>';
  }

  if (notRepositoryRelative(check)) {
    return '--check must be a repository-relative path';
  }

  return bedPattern.exec(by)?.[1] === target
    ? { target: { class: target }, kind, by, check }
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

// Stryker disable next-line LzJsNumericLiteral: how many classes a claim without --class tries is policy
const claimRounds = 3;

function claim(io: Io, site: Site, wanted: string | null, now: Date, seams: SyncSeams): number {
  const holder = holderOf(site);
  reportDivergedBeds(io, 'claim', sync(site, { ...seams, attempts: syncTries.quick }, now).divergedBeds);
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
}

type Flags = ReturnType<typeof parseFlags>['values'];

// Number() also reads hex, exponents and padding.
function wholeNumber(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function writeLine(io: Io, line: string): void {
  io.out(`${line}\n`);
}

function add(io: Io, flags: Flags, now: Date): number {
  const input: AddInput = {
    // Stryker disable next-line StringLiteral: an add without --class fails validation, and so does the mutant's text
    class: flags.class ?? '',
    where: flags.where,
    source: flags.source,
    note: flags.note,
    layer: flags.layer === undefined ? null : wholeNumber(flags.layer),
  };
  const problem =
    flags.census === undefined || objectIdPattern.test(flags.census)
      ? validateAdd(input)
      : '--census must be the full commit id census.ts printed';

  if (problem !== null) {
    io.err(`weeds add: ${problem}\n`);

    return 2;
  }

  const site = openSite(io.cwd);
  const offBase = offBaseIn(io.cwd, site.path, flags.census);
  // The status is worked out before the event is written, so a git failure in the bed check writes nothing.
  const { status } = append(
    site,
    (replica) => {
      const outcome = planAdd(eventsReportingSkipped(io, replica), input, now);

      return { drafts: outcome.drafts, status: addStatus(outcome, offBase) };
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

  reportDivergedBeds(io, command, shared.divergedBeds);
}

function reportDivergedBeds(io: Io, command: string, beds: readonly string[]): void {
  beds.forEach((bed) => {
    io.err(`weeds ${command}: ${escapeUnprintable(bed)}\n`);
  });
}

function close(io: Io, command: 'close' | 'close-class', flags: Flags, now: Date, seams: SyncSeams): number {
  const request = parseCloseFlags(command, flags);

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
      io.err(`weeds ${command}: ${claimedByLine(outcome.claim)}\n`);

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
  readonly run: (io: Io, flags: Flags, now: Date, seams: SyncSeams) => number;
}

const closeFlags: readonly (keyof Flags)[] = ['id', 'class', 'tended', 'one-off', 'keep', 'check'];

const commands: readonly Command[] = [
  { name: 'add', flags: ['class', 'where', 'source', 'note', 'layer', 'census'], run: add },
  {
    name: 'close',
    flags: closeFlags,
    run: (io, flags, now, seams) => close(io, 'close', flags, now, seams),
  },
  {
    name: 'close-class',
    flags: closeFlags,
    run: (io, flags, now, seams) => close(io, 'close-class', flags, now, seams),
  },
  { name: 'claim', flags: ['class'], run: claimCommand },
  { name: 'release', flags: ['class'], run: release },
  { name: 'groups', flags: ['min', 'ready'], run: groups },
  { name: 'list', flags: ['class'], run: list },
];

function main(argv: readonly string[], io: Io, now: Date, seams: SyncSeams): number {
  const { positionals, values, tokens } = parseFlags(argv);
  const command = positionals.length === 1 ? commands.find(({ name }) => name === positionals[0]) : undefined;

  if (command === undefined) {
    io.err('usage: weeds.ts add|close|close-class|claim|release|groups|list ... (see the header of weeds.ts)\n');

    return 2;
  }

  const stray = tokens
    .flatMap((token) => (token.kind === 'option' ? [token.name] : []))
    .find((flag) => !command.flags.some((name) => name === flag));

  if (stray !== undefined) {
    io.err(`weeds ${command.name}: --${stray} is not an option of ${command.name}\n`);

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
