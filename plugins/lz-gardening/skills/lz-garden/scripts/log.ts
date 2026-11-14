// The garden log: a grow-only set of immutable events, and the pure replay that turns any set into the queue's
// statuses. Every clone holds a replica; replicas merge by union, so the replay must not depend on the order the
// events arrive in. No I/O here: the store reads and writes the events.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { objectIdPattern } from './store-git.ts';

export { isRecord } from './log-guard.ts';

export const classPattern = /^[a-z0-9][a-z0-9-]*$/;

export const sourcePattern = /^[a-z][a-z-]*:\S/;

export const bedPattern = /^bed\/([a-z0-9][a-z0-9-]*)@([0-9a-f]{4,64})$/;

const controlsAndLineBreaks = String.raw`\p{Cc}\p{Zl}\p{Zp}`;
const bidiControls = String.raw`\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}`;
export const unprintablePattern = new RegExp(`[${controlsAndLineBreaks}${bidiControls}]`, 'u');

// The event fields the scripts print. The log reader skips an event with an unprintable character in one of them, so
// these print as read; text from anywhere else (paths, git's messages, census data) goes through escapeUnprintable.
const printedFields: readonly string[] = ['id', 'where', 'source', 'note', 'check', 'by', 'holder'];

export function hasText(text: string): boolean {
  return text.trim() !== '';
}

export function isLayer(layer: number): boolean {
  return Number.isInteger(layer) && layer >= 1 && layer <= 6;
}

export function weedId(weedClass: string, where: string, source: string): string {
  return createHash('sha256').update(`${weedClass}\u0000${where}\u0000${source}`).digest('hex').slice(0, 10);
}

const weedIdPattern = /^[0-9a-f]{10}$/;

export type CloseKind = 'tended' | 'one-off' | 'kept';

interface EventBase {
  /** crypto.randomUUID(), also the event's file name. */
  readonly uuid: string;
  /** Lamport clock: the highest clock in the writer's replica + 1. Orders only for "earliest" and "latest". */
  readonly clock: number;
  /** Writer's wall time, ISO 8601. Display, firstAt and the bound on a claim's until only; never ordering. */
  readonly at: string;
}

export interface AddEvent extends EventBase {
  readonly op: 'add';
  readonly id: string;
  readonly class: string;
  readonly where: string;
  readonly source: string;
  readonly note: string;
  readonly layer: number | null;
  /** uuids of every close naming this id that the writer's replica held. */
  readonly sawCloses: readonly string[];
  /** uuid of the latest (clock, uuid) tended close of this class in the writer's replica, or null. */
  readonly sawTend: string | null;
}

interface CloseBase extends EventBase {
  readonly op: 'close';
  /** The weeds the writer saw open; one event per close or close-class command. */
  readonly ids: readonly string[];
  readonly class: string;
}

export type CloseEvent =
  | (CloseBase & { readonly kind: 'tended'; readonly by: string; readonly check: string })
  | (CloseBase & { readonly kind: 'one-off' | 'kept'; readonly by: string; readonly check: null });

export type TendedClose = Extract<CloseEvent, { kind: 'tended' }>;

export function bedCommit(tended: TendedClose): string {
  return tended.by.slice(tended.by.indexOf('@') + 1);
}

export interface ClaimEvent extends EventBase {
  readonly op: 'claim';
  readonly class: string;
  /** The site's writer id. */
  readonly writer: string;
  /** Display only: the checkout's `lzGardening.name`, or `writer <first 8 of the writer id>`; never `user.name`. */
  readonly holder: string;
  /** at + claimLifetimeMs. */
  readonly until: string;
}

export interface ReleaseEvent extends EventBase {
  readonly op: 'release';
  readonly class: string;
  readonly claim: string;
}

export interface SeedEvent extends EventBase {
  readonly op: 'seed';
  readonly sha: string;
}

export type GardenEvent = AddEvent | CloseEvent | ClaimEvent | ReleaseEvent | SeedEvent;

export interface OpenWeed {
  readonly id: string;
  readonly class: string;
  readonly where: string;
  readonly source: string;
  readonly note: string;
  readonly layer: number | null;
  /** Earliest `at` among the unended adds of this id. */
  readonly firstAt: string;
  /** The tended close the opening add saw; null means added, not regrown. */
  readonly regrownAfter: TendedClose | null;
}

export type WeedStatus =
  { readonly state: 'open'; readonly weed: OpenWeed } | { readonly state: 'closed'; readonly kind: CloseKind };

export interface Garden {
  readonly open: readonly OpenWeed[];
  readonly statusOf: (id: string) => WeedStatus | undefined;
  readonly seeded: boolean;
  readonly claims: ReadonlyMap<string, ClaimEvent>;
}

/** An event as the writer asks for it: stamp assigns uuid, clock and at. */
export type EventDraft<T extends GardenEvent = GardenEvent> = T extends GardenEvent ? Omit<T, keyof EventBase> : never;

export interface AddInput {
  readonly class: string;
  readonly where: string;
  readonly source: string;
  readonly note: string;
  readonly layer: number | null;
}

// Each planner's outcome carries the drafts it writes, none for an outcome that writes nothing, so append writes
// what the plan decided and no caller decides it again.

export type AddOutcome =
  | { readonly said: 'seen' | 'kept'; readonly id: string; readonly drafts: readonly [] }
  | { readonly said: 'added'; readonly id: string; readonly drafts: readonly [EventDraft<AddEvent>] }
  | {
      readonly said: 'regrown';
      readonly id: string;
      readonly drafts: readonly [EventDraft<AddEvent>];
      readonly after: TendedClose;
    };

export function planAdd(events: readonly GardenEvent[], input: AddInput, now: Date): AddOutcome {
  const id = weedId(input.class, input.where, input.source);
  const status = replay(events, now).statusOf(id);

  if (status?.state === 'open') {
    return { said: 'seen', id, drafts: [] };
  }

  const closes = events.filter((event) => event.op === 'close').toSorted(byClock);
  const closesOfId = closes.filter((close) => closesWeed(close, input.class, id));

  if (closesOfId.some((close) => close.kind === 'kept')) {
    return { said: 'kept', id, drafts: [] };
  }

  const tend = latestTendedClose(closes, input.class);
  const draft = (sawTend: string | null): EventDraft<AddEvent> => ({
    op: 'add',
    id,
    ...input,
    sawCloses: closesOfId.map((close) => close.uuid),
    sawTend,
  });

  return tend === undefined
    ? { said: 'added', id, drafts: [draft(null)] }
    : { said: 'regrown', id, drafts: [draft(tend.uuid)], after: tend };
}

function closesWeed(close: CloseEvent, weedClass: string, id: string): boolean {
  return close.class === weedClass && close.ids.includes(id);
}

export function latestTendedClose(events: readonly GardenEvent[], weedClass: string): TendedClose | undefined {
  return events
    .toSorted(byClock)
    .findLast(
      (event): event is TendedClose => event.op === 'close' && event.kind === 'tended' && event.class === weedClass,
    );
}

/** The kind and its data travel together, as in a close event. */
export type CloseRequest = { readonly target: { readonly id: string } | { readonly class: string } } & (
  | { readonly kind: 'tended'; readonly by: string; readonly check: string }
  | { readonly kind: 'one-off' | 'kept'; readonly by: string; readonly check: null }
);

export type CloseOutcome =
  | { readonly said: 'nothing open'; readonly drafts: readonly [] }
  | { readonly said: 'claimed by another'; readonly claim: ClaimEvent; readonly drafts: readonly [] }
  | { readonly said: 'closed' | 'kept'; readonly closed: readonly string[]; readonly drafts: readonly EventDraft[] };

export function planClose(
  events: readonly GardenEvent[],
  request: CloseRequest,
  writer: string,
  now: Date,
): CloseOutcome {
  const { target, ...close } = request;
  const garden = replay(events, now);
  const closing = garden.open.filter((weed) => ('id' in target ? weed.id === target.id : weed.class === target.class));
  const first = closing[0];

  if (first === undefined) {
    return { said: 'nothing open', drafts: [] };
  }

  const held = heldByAnother(garden, first.class, writer);

  if (held !== undefined) {
    return { said: 'claimed by another', claim: held, drafts: [] };
  }

  const closed = closing.map((weed) => weed.id);

  return {
    said: close.kind === 'kept' ? 'kept' : 'closed',
    closed,
    drafts: [
      { op: 'close', ids: closed, class: first.class, ...close },
      ...('class' in target ? releasesOfLiveClaims(events, first.class, writer, now) : []),
    ],
  };
}

export type ReleasePlan =
  | { readonly said: 'released'; readonly drafts: readonly EventDraft<ReleaseEvent>[] }
  | { readonly said: 'no claim'; readonly drafts: readonly [] };

export function planRelease(events: readonly GardenEvent[], weedClass: string, writer: string, now: Date): ReleasePlan {
  const drafts = releasesOfLiveClaims(events, weedClass, writer, now);

  return drafts.length === 0 ? { said: 'no claim', drafts: [] } : { said: 'released', drafts };
}

function releasesOfLiveClaims(
  events: readonly GardenEvent[],
  weedClass: string,
  writer: string,
  now: Date,
): readonly EventDraft<ReleaseEvent>[] {
  return liveClaims(events, now)
    .filter((claim) => claim.writer === writer && claim.class === weedClass)
    .map(releaseOf);
}

function releaseOf(claim: ClaimEvent): EventDraft<ReleaseEvent> {
  return { op: 'release', class: claim.class, claim: claim.uuid };
}

export function releasesOfClaim(
  events: readonly GardenEvent[],
  draft: EventDraft<ClaimEvent>,
): readonly EventDraft<ReleaseEvent>[] {
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
    .map(releaseOf);
}

/** 6 hours: the GitHub-hosted job limit, so a crashed CI run's claim ends with it. */
export const claimLifetimeMs = 6 * 60 * 60 * 1000;

/** Classes a claim never picks on its own: they are tended through another class or job. */
const notTendedDirectly: readonly string[] = ['stale-verification', 'repeated-lesson'];

export type ClaimPlan =
  | { readonly said: 'claimed'; readonly class: string; readonly drafts: readonly [EventDraft<ClaimEvent>] }
  | { readonly said: 'taken'; readonly claim: ClaimEvent; readonly drafts: readonly [] }
  | { readonly said: 'nothing ready'; readonly drafts: readonly [] }
  | { readonly said: 'nothing open'; readonly class: string; readonly drafts: readonly [] };

/**
 * The groups a claim without a class may take, in groups order: ready (open weeds in two or more places), not tended
 * directly, and claimed by no other writer.
 */
export function claimableGroups(garden: Garden, writer: string): readonly Group[] {
  return groupWeeds(garden.open).filter(
    (group) =>
      group.places >= 2 &&
      !notTendedDirectly.includes(group.class) &&
      heldByAnother(garden, group.class, writer) === undefined,
  );
}

export function planClaim(
  events: readonly GardenEvent[],
  wanted: string | null,
  writer: string,
  holder: string,
  now: Date,
): ClaimPlan {
  const garden = replay(events, now);
  const chosen = wanted ?? claimableGroups(garden, writer)[0]?.class;

  if (chosen === undefined) {
    return { said: 'nothing ready', drafts: [] };
  }

  const held = heldByAnother(garden, chosen, writer);

  if (held !== undefined) {
    return { said: 'taken', claim: held, drafts: [] };
  }

  if (!garden.open.some((weed) => weed.class === chosen)) {
    return { said: 'nothing open', class: chosen, drafts: [] };
  }

  const until = new Date(now.getTime() + claimLifetimeMs).toISOString();

  return { said: 'claimed', class: chosen, drafts: [{ op: 'claim', class: chosen, writer, holder, until }] };
}

export interface LostClaim {
  readonly claim: ClaimEvent;
  readonly owner: ClaimEvent;
}

export function losingClaims(
  shared: readonly GardenEvent[],
  mine: readonly ClaimEvent[],
  writer: string,
  now: Date,
): readonly LostClaim[] {
  const garden = replay(shared, now);

  return mine.flatMap((claim) => {
    const owner = heldByAnother(garden, claim.class, writer);

    return owner === undefined ? [] : [{ claim, owner }];
  });
}

/**
 * The claims to give back before a push: this writer's live claims among the events leaving for origin that lose to
 * a claim origin already holds. Origin's events are read only when there is a claim to judge.
 */
export function planGiveBack(
  leaving: readonly GardenEvent[],
  shared: () => readonly GardenEvent[],
  writer: string,
  now: Date,
): readonly LostClaim[] {
  const mine = liveClaims(leaving, now).filter((claim) => claim.writer === writer);

  return mine.length === 0 ? [] : losingClaims(shared(), mine, writer, now);
}

/** A release of each lost claim the events do not release already. */
export function releasesOfLostClaims(
  events: readonly GardenEvent[],
  lost: readonly LostClaim[],
): readonly EventDraft<ReleaseEvent>[] {
  const released = releasedClaims(events);

  return lost.filter(({ claim }) => !released.has(claim.uuid)).map(({ claim }) => releaseOf(claim));
}

/** The uuids of the claims a release names. */
export function releasedClaims(events: readonly GardenEvent[]): ReadonlySet<string> {
  return new Set(events.flatMap((event) => (event.op === 'release' ? [event.claim] : [])));
}

export type ClaimRefusal = { readonly kind: 'unclaimed' } | { readonly kind: 'held'; readonly owner: ClaimEvent };

/** Why a writer may not act on a class under its claim: no live claim, or another writer's; undefined when it holds it. */
export function claimRefusal(garden: Garden, weedClass: string, writer: string): ClaimRefusal | undefined {
  const owner = garden.claims.get(weedClass);

  if (owner === undefined) {
    return { kind: 'unclaimed' };
  }

  return owner.writer === writer ? undefined : { kind: 'held', owner };
}

/** The active claim of a class when a writer other than this one owns it. */
function heldByAnother(garden: Garden, weedClass: string, writer: string): ClaimEvent | undefined {
  const held = garden.claims.get(weedClass);

  return held?.writer === writer ? undefined : held;
}

/** The file a weed sits in: its `--where` without the line. */
function placeOf(where: string): string {
  return where.replace(/:\d+$/, '');
}

export interface Group {
  readonly class: string;
  readonly open: number;
  /** The files its open weeds sit in. */
  readonly places: number;
  readonly regrown: number;
  readonly firstAt: string;
  readonly layer: number | null;
}

/** Open weeds per class, in groups order: most open, then most regrown, then by name. */
export function groupWeeds(weeds: readonly OpenWeed[]): readonly Group[] {
  return [...Map.groupBy(weeds, (weed) => weed.class)]
    .map(([weedClass, members]): Group => {
      const times = members.map((weed) => weed.firstAt).sort();
      const layers = members.flatMap((weed) => (weed.layer === null ? [] : [weed.layer]));

      return {
        class: weedClass,
        open: members.length,
        places: new Set(members.map((weed) => placeOf(weed.where))).size,
        regrown: members.filter((weed) => weed.regrownAfter !== null).length,
        // Stryker disable next-line StringLiteral: a group always has a member, so times[0] is never missing
        firstAt: times[0] ?? '',
        layer: layers.length === 0 ? null : Math.min(...layers),
      };
    })
    .sort((a, b) => b.open - a.open || b.regrown - a.regrown || a.class.localeCompare(b.class));
}

export function maxClockOf(events: readonly GardenEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.clock), 0);
}

/** Stamps drafts with uuid, clock (maxClock + 1, + 2, ...) and at. */
export function stamp(drafts: readonly EventDraft[], maxClock: number, now: Date): readonly GardenEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    uuid: randomUUID(),
    clock: maxClock + index + 1,
    at: now.toISOString(),
  }));
}

export function eventPath(uuid: string): string {
  return `events/${uuid.slice(0, 2)}/${uuid}.json`;
}

export function isStampedTime(text: string): boolean {
  const time = Date.parse(text);

  return /^\d{4}-/.test(text) && !Number.isNaN(time) && new Date(time).toISOString() === text;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const eventPathPattern =
  /^events\/([0-9a-f]{2})\/\1[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

// Any number JSON reads, Infinity from 1e400 included, which z.number() refuses; a range check then reports it.
function jsonNumber(params: { readonly error: string }): z.ZodType<number> {
  return z.custom<number>((value) => typeof value === 'number', params);
}

const missingEnvelope = { error: 'missing uuid, clock or at' };

const envelopeSchema = z
  .looseObject(
    {
      uuid: z.string(missingEnvelope),
      clock: jsonNumber(missingEnvelope),
      at: z.string(missingEnvelope),
    },
    { error: 'not an object' },
  )
  .refine(({ clock }) => Number.isSafeInteger(clock) && clock >= 0, 'clock is not a whole number from 0')
  .refine(({ at }) => isStampedTime(at), 'at is not a date')
  .refine(({ uuid }) => uuidPattern.test(uuid), 'uuid is not a UUID');

const malformedAdd = { error: 'malformed add' };

const addSchema = z
  .object({
    op: z.literal('add'),
    id: z.string(malformedAdd),
    class: z.string(malformedAdd),
    where: z.string(malformedAdd),
    source: z.string(malformedAdd),
    note: z.string(malformedAdd),
    layer: jsonNumber(malformedAdd).nullable(),
    sawCloses: z.array(z.string(malformedAdd), malformedAdd),
    sawTend: z.string(malformedAdd).nullable(),
  })
  .refine(({ where }) => hasText(where), 'where is blank')
  .refine(({ source }) => sourcePattern.test(source), 'source is not <kind>:<ref>')
  .refine(({ layer }) => layer === null || isLayer(layer), 'layer is not a whole number from 1 to 6')
  .refine(
    (add) => add.id === weedId(add.class, add.where, add.source),
    'id is not the weed id of its class, where and source',
  );

const malformedClose = { error: 'malformed close' };

const closeFields = {
  op: z.literal('close'),
  ids: z.array(z.string(malformedClose), malformedClose),
  class: z.string(malformedClose),
  by: z.string(malformedClose),
};

const closeSchema = z
  .looseObject(closeFields)
  .refine(({ ids }) => ids.length > 0, 'close names no weed')
  .refine(({ ids }) => ids.every((id) => weedIdPattern.test(id)), 'close names something other than a weed id')
  .refine(({ by }) => hasText(by), 'by is blank')
  .pipe(
    z.discriminatedUnion(
      'kind',
      [
        z
          .object({ ...closeFields, kind: z.literal('tended'), check: z.string(malformedClose) })
          .refine(({ check }) => hasText(check), 'check is blank')
          .refine(
            (close) => bedPattern.exec(close.by)?.[1] === close.class,
            'tend close names no bed/<class>@<commit>',
          ),
        z.object({ ...closeFields, kind: z.enum(['one-off', 'kept']), check: z.null(malformedClose) }),
      ],
      malformedClose,
    ),
  );

const malformedClaim = { error: 'malformed claim' };

const claimSchema = z
  .object({
    op: z.literal('claim'),
    at: z.string(malformedClaim),
    class: z.string(malformedClaim),
    writer: z.string(malformedClaim),
    holder: z.string(malformedClaim),
    until: z.string(malformedClaim),
  })
  .refine(({ until }) => isStampedTime(until), 'until is not a date')
  .refine(
    ({ at, until }) => Date.parse(until) - Date.parse(at) <= claimLifetimeMs,
    "until is more than a claim's lifetime after at",
  );

const malformedRelease = { error: 'malformed release' };

const releaseSchema = z
  .object({ op: z.literal('release'), class: z.string(malformedRelease), claim: z.string(malformedRelease) })
  .refine(({ claim }) => uuidPattern.test(claim), 'claim is not a UUID');

const seedSchema = z
  .object({ op: z.literal('seed'), sha: z.string({ error: 'malformed seed' }) })
  .refine(({ sha }) => objectIdPattern.test(sha), 'sha is not a full commit id');

type Body<TEvent> = TEvent extends GardenEvent ? Omit<TEvent, keyof EventBase> : never;

const bodySchemas = new Map<unknown, z.ZodType<Body<GardenEvent>>>([
  ['add', addSchema],
  ['close', closeSchema],
  ['claim', claimSchema],
  ['release', releaseSchema],
  ['seed', seedSchema],
]);

function sharedFieldFault(json: Readonly<Record<string, unknown>>): string | undefined {
  const weedClass = json['class'];

  if (typeof weedClass === 'string' && !classPattern.test(weedClass)) {
    return `class ${JSON.stringify(weedClass)} is not a kebab-case class id`;
  }

  const unprintable = printedFields.find((field) => {
    const value = json[field];

    return typeof value === 'string' && unprintablePattern.test(value);
  });

  return unprintable === undefined ? undefined : `${unprintable} holds a line break or control character`;
}

export function firstReason(error: z.ZodError): string {
  // Stryker disable next-line OptionalChaining,LogicalOperator: a failed parse has at least one issue
  return error.issues[0]?.message ?? error.message;
}

export function parseEvent(path: string, text: string): GardenEvent | string {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return 'not JSON';
  }

  const envelope = envelopeSchema.safeParse(json);

  if (!envelope.success) {
    return firstReason(envelope.error);
  }

  const { uuid, clock, at } = envelope.data;

  if (eventPath(uuid) !== path) {
    return 'uuid is not its file name';
  }

  const fault = sharedFieldFault(envelope.data);

  if (fault !== undefined) {
    return fault;
  }

  const op = envelope.data['op'];
  const bodySchema = bodySchemas.get(op);

  if (bodySchema === undefined) {
    return `unknown op ${JSON.stringify(op)}`;
  }

  const body = bodySchema.safeParse(envelope.data);

  return body.success ? { ...body.data, uuid, clock, at } : firstReason(body.error);
}

/** The (clock, uuid) order that "earliest" and "latest" mean on every replica. */
function byClock(a: GardenEvent, b: GardenEvent): number {
  // Stryker disable next-line EqualityOperator,LzJsNumericLiteral: a uuid is its event's file name, so two events never tie on it, and V8's sort reads only whether the result is below 0, so -2, 2 and 0 sort as -1 and 1 do
  return a.clock - b.clock || (a.uuid < b.uuid ? -1 : 1);
}

/**
 * A close ends every add of its ids that did not see it; a weed is open while one of its adds is not ended. The
 * earliest unended add opens it, and is regrown when it saw a tend close of its class.
 */
function openWeeds(ordered: readonly GardenEvent[], closes: readonly CloseEvent[]): ReadonlyMap<string, OpenWeed> {
  const closesById = Map.groupBy(
    closes.flatMap((close) => close.ids.map((id) => ({ id, close }))),
    (named) => named.id,
  );
  const ended = (event: AddEvent): boolean =>
    closesById
      .get(event.id)
      ?.some(({ close }) => closesWeed(close, event.class, event.id) && !event.sawCloses.includes(close.uuid)) ?? false;

  return ordered
    .filter((event): event is AddEvent => event.op === 'add' && !ended(event))
    .reduce((openById, event) => {
      const opened = openById.get(event.id);

      return openById.set(
        event.id,
        opened === undefined
          ? {
              id: event.id,
              class: event.class,
              where: event.where,
              source: event.source,
              note: event.note,
              layer: event.layer,
              firstAt: event.at,
              regrownAfter:
                closes.find((close): close is TendedClose => close.kind === 'tended' && close.uuid === event.sawTend) ??
                null,
            }
          : // Stryker disable next-line EqualityOperator: when the two times are equal, either one is the same string
            { ...opened, firstAt: event.at < opened.firstAt ? event.at : opened.firstAt },
      );
    }, new Map<string, OpenWeed>());
}

// How far a writer's clock may run ahead of the reader's: another process, or another machine, takes a claim after the
// reader read the time. Dropping such a claim as dated in the future would let two writers hold one class.
const clockSkewAllowanceMs = 60 * 60 * 1000;

function liveClaims(events: readonly GardenEvent[], now: Date): ClaimEvent[] {
  const released = releasedClaims(events);
  const ending = (claim: ClaimEvent): number => Date.parse(claim.until) - now.getTime();

  return events
    .filter((event) => event.op === 'claim')
    .filter(
      (claim) =>
        !released.has(claim.uuid) && ending(claim) > 0 && ending(claim) <= claimLifetimeMs + clockSkewAllowanceMs,
    )
    .toSorted(byClock);
}

/**
 * A claim is active until a release names it or its until passes the reader's clock. The earliest active claim of a
 * class owns it; a later claim by the same writer renews it.
 */
function activeClaims(ordered: readonly GardenEvent[], now: Date): ReadonlyMap<string, ClaimEvent> {
  return liveClaims(ordered, now).reduce((claims, event) => {
    const owner = claims.get(event.class);

    return owner === undefined || owner.writer === event.writer ? claims.set(event.class, event) : claims;
  }, new Map<string, ClaimEvent>());
}

export function replay(events: readonly GardenEvent[], now: Date): Garden {
  const ordered = events.toSorted(byClock);
  const closes = ordered.filter((event) => event.op === 'close');
  const openById = openWeeds(ordered, closes);
  const open = [...openById.values()];
  const statusOf = (id: string): WeedStatus | undefined => {
    const weed = openById.get(id);

    if (weed !== undefined) {
      return { state: 'open', weed };
    }

    const close = closes.findLast((event) => event.ids.includes(id));

    return close === undefined ? undefined : { state: 'closed', kind: close.kind };
  };

  return {
    open,
    statusOf,
    seeded: events.some((event) => event.op === 'seed'),
    claims: activeClaims(ordered, now),
  };
}
