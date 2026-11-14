// The garden log: a grow-only set of immutable events, and the pure replay that turns any set into the queue's
// statuses. Every clone holds a replica; replicas merge by union, so the replay must not depend on the order the
// events arrive in. No I/O here: the store reads and writes the events.
import { createHash, randomUUID } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const classPattern = /^[a-z0-9][a-z0-9-]*$/;

export const bedPattern = /^bed\/([a-z0-9][a-z0-9-]*)@([0-9a-f]{4,40})$/;

const controlsAndLineBreaks = String.raw`\p{Cc}\p{Zl}\p{Zp}`;
const bidiControls = String.raw`\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}`;
export const unprintablePattern = new RegExp(`[${controlsAndLineBreaks}${bidiControls}]`, 'u');

const printedFields: readonly string[] = ['id', 'where', 'source', 'note', 'check', 'by', 'holder'];

export function weedId(weedClass: string, where: string, source: string): string {
  return createHash('sha256').update(`${weedClass}\u0000${where}\u0000${source}`).digest('hex').slice(0, 10);
}

export type CloseKind = 'tended' | 'one-off' | 'kept';

interface EventBase {
  /** crypto.randomUUID(), also the event's file name. */
  readonly uuid: string;
  /** Lamport clock: the highest clock in the writer's replica + 1. Orders only for "earliest" and "latest". */
  readonly clock: number;
  /** Writer's wall time, ISO 8601. Display, firstAt and claim expiry only; never ordering. */
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
  readonly maxClock: number;
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

export type AddOutcome =
  | { readonly said: 'seen' | 'kept'; readonly id: string }
  | { readonly said: 'added'; readonly id: string; readonly draft: EventDraft<AddEvent> }
  | {
      readonly said: 'regrown';
      readonly id: string;
      readonly draft: EventDraft<AddEvent>;
      readonly after: TendedClose;
    };

/** Today's writer rules over the replica: no add of a weed seen open or kept; records what the writer saw. */
export function planAdd(events: readonly GardenEvent[], input: AddInput, now: Date): AddOutcome {
  const id = weedId(input.class, input.where, input.source);
  const status = replay(events, now).statusOf(id);

  if (status?.state === 'open') {
    return { said: 'seen', id };
  }

  const closes = events.filter((event) => event.op === 'close').toSorted(byClock);
  const closesOfId = closes.filter((close) => close.ids.includes(id));

  if (closesOfId.some((close) => close.kind === 'kept')) {
    return { said: 'kept', id };
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
    ? { said: 'added', id, draft: draft(null) }
    : { said: 'regrown', id, draft: draft(tend.uuid), after: tend };
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
  | { readonly said: 'nothing open' }
  | { readonly said: 'claimed by another'; readonly claim: ClaimEvent }
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
    return { said: 'nothing open' };
  }

  const held = heldByAnother(garden, first.class, writer);

  if (held !== undefined) {
    return { said: 'claimed by another', claim: held };
  }

  const closed = closing.map((weed) => weed.id);

  return {
    said: close.kind === 'kept' ? 'kept' : 'closed',
    closed,
    drafts: [
      { op: 'close', ids: closed, class: first.class, ...close },
      ...('class' in target ? releasesOf(events, first.class, writer, now) : []),
    ],
  };
}

export type ReleasePlan =
  { readonly said: 'released'; readonly drafts: readonly EventDraft[] } | { readonly said: 'no claim' };

export function planRelease(events: readonly GardenEvent[], weedClass: string, writer: string, now: Date): ReleasePlan {
  const drafts = releasesOf(events, weedClass, writer, now);

  return drafts.length === 0 ? { said: 'no claim' } : { said: 'released', drafts };
}

function releasesOf(events: readonly GardenEvent[], weedClass: string, writer: string, now: Date): EventDraft[] {
  return liveClaims(events, now)
    .filter((claim) => claim.writer === writer && claim.class === weedClass)
    .map((claim): EventDraft => ({ op: 'release', class: claim.class, claim: claim.uuid }));
}

/** 6 hours: the GitHub-hosted job limit and GITHUB_TOKEN lifetime, so a crashed CI run's claim ends with it. */
export const claimLifetimeMs = 6 * 60 * 60 * 1000;

/** Classes a claim never picks on its own: they are tended through another class or job. */
export const notTendedDirectly: readonly string[] = ['stale-verification', 'repeated-lesson'];

export type ClaimPlan =
  | { readonly said: 'claimed'; readonly class: string; readonly draft: EventDraft<ClaimEvent> }
  | { readonly said: 'taken'; readonly claim: ClaimEvent }
  | { readonly said: 'nothing ready' }
  | { readonly said: 'nothing open'; readonly class: string };

/** The ready classes a claim without a class may take: not tended directly and claimed by no other writer. */
export function claimableClasses(garden: Garden, writer: string): readonly string[] {
  return readyClasses(garden.open).filter(
    (weedClass) => !notTendedDirectly.includes(weedClass) && heldByAnother(garden, weedClass, writer) === undefined,
  );
}

/**
 * Which class to claim. With a class: taken if another writer holds it, else claimed (a holder's claim renews it).
 * Without: the first claimable class, in groups order.
 */
export function planClaim(
  events: readonly GardenEvent[],
  wanted: string | null,
  writer: string,
  holder: string,
  now: Date,
): ClaimPlan {
  const garden = replay(events, now);
  const chosen = wanted ?? claimableClasses(garden, writer)[0];

  if (chosen === undefined) {
    return { said: 'nothing ready' };
  }

  const held = heldByAnother(garden, chosen, writer);

  if (held !== undefined) {
    return { said: 'taken', claim: held };
  }

  if (!garden.open.some((weed) => weed.class === chosen)) {
    return { said: 'nothing open', class: chosen };
  }

  const until = new Date(now.getTime() + claimLifetimeMs).toISOString();

  return { said: 'claimed', class: chosen, draft: { op: 'claim', class: chosen, writer, holder, until } };
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
export function releasesFor(events: readonly GardenEvent[], lost: readonly LostClaim[]): readonly EventDraft[] {
  const released = releasedClaims(events);

  return lost
    .filter(({ claim }) => !released.has(claim.uuid))
    .map(({ claim }): EventDraft => ({ op: 'release', class: claim.class, claim: claim.uuid }));
}

/** The uuids of the claims a release names. */
export function releasedClaims(events: readonly GardenEvent[]): ReadonlySet<string> {
  return new Set(events.flatMap((event) => (event.op === 'release' ? [event.claim] : [])));
}

/** The active claim of a class when a writer other than this one owns it. */
function heldByAnother(garden: Garden, weedClass: string, writer: string): ClaimEvent | undefined {
  const held = garden.claims.get(weedClass);

  return held?.writer === writer ? undefined : held;
}

/** The file a weed sits in: its `--where` without the line. */
export function placeOf(where: string): string {
  return where.replace(/:\d+$/, '');
}

/** Classes whose open weeds sit in two or more places, in groups order: most open, then most regrown, then by name. */
function readyClasses(open: readonly OpenWeed[]): string[] {
  const regrownIn = (weeds: readonly OpenWeed[]): number => weeds.filter((weed) => weed.regrownAfter !== null).length;

  return [...Map.groupBy(open, (weed) => weed.class)]
    .filter(([, weeds]) => new Set(weeds.map((weed) => placeOf(weed.where))).size >= 2)
    .toSorted(
      ([aClass, a], [bClass, b]) => b.length - a.length || regrownIn(b) - regrownIn(a) || aClass.localeCompare(bClass),
    )
    .map(([weedClass]) => weedClass);
}

/** Stamps drafts with uuid, clock (maxClock + 1, + 2, ...) and at. */
export function stamp(drafts: readonly EventDraft[], maxClock: number, now: Date): GardenEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    uuid: randomUUID(),
    clock: maxClock + index + 1,
    at: now.toISOString(),
  }));
}

/** Where an event lives in the log tree: events/<uuid[0..2]>/<uuid>.json (256 shards, 3,000 each). */
export function eventPath(uuid: string): string {
  return `events/${uuid.slice(0, 2)}/${uuid}.json`;
}

function isStampedTime(text: string): boolean {
  const time = Date.parse(text);

  return /^\d{4}-/.test(text) && !Number.isNaN(time) && new Date(time).toISOString() === text;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const eventPathPattern =
  /^events\/([0-9a-f]{2})\/\1[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Parses one event file at the trust boundary; anything malformed is a reason string, never a throw. */
export function parseEvent(path: string, text: string): GardenEvent | string {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return 'not JSON';
  }

  if (!isRecord(json)) {
    return 'not an object';
  }

  const { uuid, clock, at } = json;

  if (typeof uuid !== 'string' || typeof clock !== 'number' || typeof at !== 'string') {
    return 'missing uuid, clock or at';
  }

  if (!Number.isSafeInteger(clock) || clock < 0) {
    return 'clock is not a whole number from 0';
  }

  if (!isStampedTime(at)) {
    return 'at is not a date';
  }

  if (!uuidPattern.test(uuid)) {
    return 'uuid is not a UUID';
  }

  if (eventPath(uuid) !== path) {
    return 'uuid is not its file name';
  }

  const weedClass = json['class'];

  if (typeof weedClass === 'string' && !classPattern.test(weedClass)) {
    return `class ${JSON.stringify(weedClass)} is not a kebab-case class id`;
  }

  const unprintable = printedFields.find((field) => {
    const value = json[field];

    return typeof value === 'string' && unprintablePattern.test(value);
  });

  if (unprintable !== undefined) {
    return `${unprintable} holds a line break or control character`;
  }

  const base = { uuid, clock, at };

  switch (json['op']) {
    case 'close': {
      return parseClose(json, base);
    }
    case 'claim': {
      return parseClaim(json, base);
    }
    case 'release': {
      const claimed = json['claim'];

      return typeof weedClass === 'string' && typeof claimed === 'string'
        ? { op: 'release', ...base, class: weedClass, claim: claimed }
        : 'malformed release';
    }
    case 'seed': {
      const { sha } = json;

      return typeof sha === 'string' ? { op: 'seed', ...base, sha } : 'malformed seed';
    }
    case 'add': {
      return parseAdd(json, base);
    }
    default: {
      return `unknown op ${JSON.stringify(json['op'])}`;
    }
  }
}

function parseClaim(json: Record<string, unknown>, base: EventBase): ClaimEvent | string {
  const { writer, holder, until } = json;
  const weedClass = json['class'];

  if (
    typeof weedClass !== 'string' ||
    typeof writer !== 'string' ||
    typeof holder !== 'string' ||
    typeof until !== 'string'
  ) {
    return 'malformed claim';
  }

  if (!isStampedTime(until)) {
    return 'until is not a date';
  }

  return { op: 'claim', ...base, class: weedClass, writer, holder, until };
}

function parseClose(json: Record<string, unknown>, base: EventBase): CloseEvent | string {
  const { ids, kind, by, check } = json;
  const weedClass = json['class'];

  if (!isStringArray(ids) || typeof weedClass !== 'string' || typeof by !== 'string') {
    return 'malformed close';
  }

  if (kind === 'tended' && typeof check === 'string') {
    return bedPattern.exec(by)?.[1] === weedClass
      ? { op: 'close', ...base, ids, class: weedClass, kind, by, check }
      : 'tend close names no bed/<class>@<commit>';
  }

  if ((kind === 'one-off' || kind === 'kept') && check === null) {
    return { op: 'close', ...base, ids, class: weedClass, kind, by, check };
  }

  return 'malformed close';
}

function parseAdd(json: Record<string, unknown>, base: EventBase): AddEvent | string {
  const { id, where, source, note, layer, sawCloses, sawTend } = json;
  const weedClass = json['class'];

  if (
    typeof id !== 'string' ||
    typeof weedClass !== 'string' ||
    typeof where !== 'string' ||
    typeof source !== 'string' ||
    typeof note !== 'string' ||
    !(typeof layer === 'number' || layer === null) ||
    !isStringArray(sawCloses) ||
    !(typeof sawTend === 'string' || sawTend === null)
  ) {
    return 'malformed add';
  }

  return { op: 'add', ...base, id, class: weedClass, where, source, note, layer, sawCloses, sawTend };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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
function openWeeds(ordered: readonly GardenEvent[], closes: readonly CloseEvent[]): Map<string, OpenWeed> {
  const ended = (event: AddEvent): boolean =>
    closes.some((close) => close.ids.includes(event.id) && !event.sawCloses.includes(close.uuid));
  const openById = new Map<string, OpenWeed>();

  for (const event of ordered) {
    if (event.op !== 'add' || ended(event)) {
      continue;
    }

    const opened = openById.get(event.id);

    if (opened !== undefined) {
      // Stryker disable next-line EqualityOperator: when the two times are equal, either one is the same string
      openById.set(event.id, { ...opened, firstAt: event.at < opened.firstAt ? event.at : opened.firstAt });
    } else {
      openById.set(event.id, {
        id: event.id,
        class: event.class,
        where: event.where,
        source: event.source,
        note: event.note,
        layer: event.layer,
        firstAt: event.at,
        regrownAfter:
          closes.find((close): close is TendedClose => close.kind === 'tended' && close.uuid === event.sawTend) ?? null,
      });
    }
  }

  return openById;
}

/** The claims no release names whose until is later than the reader's clock, in (clock, uuid) order. */
function liveClaims(events: readonly GardenEvent[], now: Date): ClaimEvent[] {
  const released = releasedClaims(events);

  return events
    .filter((event) => event.op === 'claim')
    .filter((claim) => !released.has(claim.uuid) && Date.parse(claim.until) > now.getTime())
    .toSorted(byClock);
}

/**
 * A claim is active until a release names it or its until passes the reader's clock. The earliest active claim of a
 * class owns it; a later claim by the same writer renews it.
 */
function activeClaims(ordered: readonly GardenEvent[], now: Date): Map<string, ClaimEvent> {
  const claims = new Map<string, ClaimEvent>();

  for (const event of liveClaims(ordered, now)) {
    const owner = claims.get(event.class);

    if (owner === undefined || owner.writer === event.writer) {
      claims.set(event.class, event);
    }
  }

  return claims;
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
    maxClock: ordered.at(-1)?.clock ?? 0,
  };
}
