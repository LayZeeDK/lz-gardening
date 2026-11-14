// Run: node --test log.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bedCommit,
  claimRefusal,
  eventPath,
  groupWeeds,
  losingClaims,
  maxClockOf,
  parseEvent,
  planAdd,
  planClaim,
  planClose,
  planRelease,
  releasesOfClaim,
  releasesOfLostClaims,
  replay,
  stamp,
  weedId,
} from './log.ts';
import type {
  AddEvent,
  AddInput,
  ClaimEvent,
  CloseEvent,
  Garden,
  GardenEvent,
  OpenWeed,
  ReleaseEvent,
  TendedClose,
} from './log.ts';

const now = new Date('2026-11-11T12:00:00.000Z');
const at = '2026-11-11T10:00:00.000Z';
const later = '2026-11-11T16:00:00.000Z';

function claim(uuid: string, clock: number, writer: string, until = later, weedClass = 'any-type'): ClaimEvent {
  return { op: 'claim', uuid, clock, at, class: weedClass, writer, holder: `${writer} on host`, until };
}

function release(uuid: string, clock: number, claimed: string, weedClass = 'any-type'): ReleaseEvent {
  return { op: 'release', uuid, clock, at, class: weedClass, claim: claimed };
}

function add(uuid: string, clock: number, id: string, fields: Partial<AddEvent> = {}): AddEvent {
  return {
    op: 'add',
    uuid,
    clock,
    at,
    id,
    class: 'any-type',
    where: `src/${id}.ts:1`,
    source: 'census:any-type',
    note: '',
    layer: null,
    sawCloses: [],
    sawTend: null,
    ...fields,
  };
}

function storedAdd(uuid: string, clock: number, fields: Partial<Omit<AddEvent, 'id'>> = {}): AddEvent {
  const event = add(uuid, clock, '', { where: 'src/x.ts:1', ...fields });

  return { ...event, id: weedId(event.class, event.where, event.source) };
}

function close(
  uuid: string,
  clock: number,
  ids: readonly string[],
  kind: 'one-off' | 'kept',
  weedClass = 'any-type',
): CloseEvent {
  return { op: 'close', uuid, clock, at, ids, class: weedClass, kind, by: 'generated code', check: null };
}

function tend(uuid: string, clock: number, ids: readonly string[], weedClass = 'any-type'): TendedClose {
  return {
    op: 'close',
    uuid,
    clock,
    at,
    ids,
    class: weedClass,
    kind: 'tended',
    by: `bed/${weedClass}@1a2b3c4`,
    check: 'eslint.config.mjs',
  };
}

function statuses(garden: Garden, ids: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    ids.map((id) => {
      const status = garden.statusOf(id);

      if (status?.state === 'open') {
        return [id, status.weed.regrownAfter === null ? 'added' : 'regrown'];
      }

      return [id, status === undefined ? undefined : `closed:${status.kind}`];
    }),
  );
}

test('ids depend on class, place and source', () => {
  assert.notEqual(weedId('a', 'f:1', 'commit:1'), weedId('a', 'f:1', 'commit:2'));
  assert.equal(weedId('a', 'f:1', 'commit:1'), weedId('a', 'f:1', 'commit:1'));
});

test('a weed id is ten hex characters', () => {
  assert.match(weedId('any-type', 'src/a.ts:1', 'census:any-type'), /^[0-9a-f]{10}$/);
});

test('an empty log has no open weeds', () => {
  const garden = replay([], now);

  assert.deepEqual(garden.open, []);
});

test('a weed added once is open and added, not regrown', () => {
  const garden = replay([add('u1', 1, 'x')], now);

  assert.deepEqual(statuses(garden, ['x']), { x: 'added' });
});

test('spike 1, scenario 1: the same weed found by two writers is one open weed', () => {
  const garden = replay([add('a1', 1, 'x'), add('b1', 1, 'x')], now);

  assert.deepEqual(
    garden.open.map((weed) => weed.id),
    ['x'],
  );
});

test('spike 1, scenario 2: a close beside a concurrent add of the same weed leaves it closed', () => {
  const writerA = [add('a1', 1, 'x'), close('a2', 2, ['x'], 'one-off')];
  const writerB = [
    add('b1', 1, 'y0', { class: 'other' }),
    add('b2', 2, 'y1', { class: 'other' }),
    add('b3', 3, 'y2', { class: 'other' }),
    close('b4', 4, ['y0'], 'one-off', 'other'),
    close('b5', 5, ['y1'], 'one-off', 'other'),
    close('b6', 6, ['y2'], 'one-off', 'other'),
    add('b7', 7, 'x'),
  ];

  const garden = replay([...writerA, ...writerB], now);

  assert.deepEqual(statuses(garden, ['x']), { x: 'closed:one-off' });
});

test('spike 1, scenario 3: a weed that comes back after a close its writer saw is open again', () => {
  const garden = replay(
    [add('a1', 1, 'x'), close('a2', 2, ['x'], 'one-off'), add('b3', 3, 'x', { sawCloses: ['a2'] })],
    now,
  );

  assert.deepEqual(statuses(garden, ['x']), { x: 'added' });
});

test('spike 1, scenario 5: a weed added after a tend pass its writer saw is regrown, naming that tend close', () => {
  const tended = tend('a2', 2, ['a']);

  const garden = replay([add('a1', 1, 'a'), tended, add('b3', 3, 'b', { sawTend: 'a2' })], now);

  assert.deepEqual(statuses(garden, ['a', 'b']), { a: 'closed:tended', b: 'regrown' });
  assert.equal(garden.open[0]?.regrownAfter, tended);
});

test('a weed whose add names a close that is not a tend pass as its seen tend is added, not regrown', () => {
  const garden = replay(
    [add('a1', 1, 'a'), close('a2', 2, ['a'], 'one-off'), add('b3', 3, 'b', { sawTend: 'a2' })],
    now,
  );

  assert.deepEqual(statuses(garden, ['b']), { b: 'added' });
});

test('spike 1, scenario 4: a weed added beside a concurrent tend pass of its class is added, not regrown', () => {
  const writerA = [add('a1', 1, 'a'), tend('a2', 2, ['a'])];
  const writerB = [
    add('b1', 1, 'p0', { class: 'other' }),
    close('b2', 2, ['p0'], 'one-off', 'other'),
    add('b3', 3, 'p1', { class: 'other', sawCloses: [] }),
    close('b4', 4, ['p1'], 'one-off', 'other'),
    add('b5', 5, 'b'),
  ];

  const garden = replay([...writerA, ...writerB], now);

  assert.deepEqual(statuses(garden, ['a', 'b']), { a: 'closed:tended', b: 'added' });
});

test('spike 1, scenario 6: a keep beside a concurrent add of the same weed leaves it kept', () => {
  const writerA = [add('a1', 1, 'x'), close('a2', 2, ['x'], 'kept')];
  const writerB = [
    add('b1', 1, 'q', { class: 'other' }),
    close('b2', 2, ['q'], 'one-off', 'other'),
    add('b3', 3, 'q2', { class: 'other' }),
    close('b4', 4, ['q2'], 'one-off', 'other'),
    add('b5', 5, 'x'),
  ];

  const garden = replay([...writerA, ...writerB], now);

  assert.deepEqual(statuses(garden, ['x']), { x: 'closed:kept' });
});

test('spike 1, scenario 7: two writers closing the same weed leave it closed', () => {
  const garden = replay([add('a1', 1, 'x'), close('a2', 2, ['x'], 'one-off'), close('b2', 2, ['x'], 'one-off')], now);

  assert.deepEqual(statuses(garden, ['x']), { x: 'closed:one-off' });
});

test('a close of another class leaves a weed open, though it names the weed', () => {
  const garden = replay([add('a1', 1, 'x'), close('c1', 2, ['x'], 'one-off', 'other')], now);

  assert.deepEqual(statuses(garden, ['x']), { x: 'added' });
});

test('a closed weed takes the kind of its latest close by clock, then uuid, in whatever order the events arrive', () => {
  const events = [add('a1', 1, 'x'), close('b2', 2, ['x'], 'kept'), close('a2', 2, ['x'], 'one-off')];

  assert.deepEqual(
    [statuses(replay(events, now), ['x']), statuses(replay(events.toReversed(), now), ['x'])],
    [{ x: 'closed:kept' }, { x: 'closed:kept' }],
  );
});

test('a weed two writers added is opened by the earliest add by clock and first seen at the earliest time', () => {
  const garden = replay(
    [
      add('b1', 2, 'x', { at: '2026-11-07T10:00:00.000Z', note: 'later clock' }),
      add('a1', 1, 'x', { at: '2026-11-08T10:00:00.000Z', note: 'earlier clock' }),
    ],
    now,
  );

  assert.deepEqual(
    garden.open.map((weed) => [weed.note, weed.firstAt]),
    [['earlier clock', '2026-11-07T10:00:00.000Z']],
  );
});

test('a log with a seed event is seeded', () => {
  const garden = replay([{ op: 'seed', uuid: 's1', clock: 1, at, sha: 'a'.repeat(40) }], now);

  assert.equal(garden.seeded, true);
});

test('a log is seeded when a seed event is among its other events, and not seeded without one', () => {
  const seed = { op: 'seed', uuid: 's2', clock: 2, at, sha: 'a'.repeat(40) } as const;

  assert.deepEqual(
    [replay([add('a1', 1, 'x')], now).seeded, replay([add('a1', 1, 'x'), seed], now).seeded],
    [false, true],
  );
});

test('the highest clock in the log is the one the next event counts on from', () => {
  assert.equal(maxClockOf([add('a1', 3, 'x'), add('b1', 7, 'y'), close('a2', 2, ['z'], 'one-off')]), 7);
});

test('an empty log has clock 0, so the first event stamped on it gets clock 1', () => {
  assert.equal(maxClockOf([]), 0);
});

test('an active claim makes its writer the owner of the class', () => {
  const garden = replay([claim('c1', 1, 'writer-a')], now);

  assert.equal(garden.claims.get('any-type')?.writer, 'writer-a');
});

test('a released claim gives the class back', () => {
  const garden = replay([claim('c1', 1, 'writer-a'), release('r1', 2, 'c1')], now);

  assert.equal(garden.claims.has('any-type'), false);
});

test('a claim whose until is not after the reader clock has expired and gives the class back', () => {
  const garden = replay([claim('c1', 1, 'writer-a', now.toISOString())], now);

  assert.equal(garden.claims.has('any-type'), false);
});

test('a claim taken a moment after the reader clock read the time is live, as another process takes one', () => {
  const later = { ...claim('c1', 1, 'writer-b'), at: '2026-11-11T12:00:00.001Z', until: '2026-11-11T18:00:00.001Z' };

  assert.equal(replay([later], now).claims.get('any-type'), later);
});

test('a claim taken by a writer whose clock runs an hour ahead of the reader is live', () => {
  const ahead = { ...claim('c1', 1, 'writer-b'), at: '2026-11-11T13:00:00.000Z', until: '2026-11-11T19:00:00.000Z' };

  assert.equal(replay([ahead], now).claims.get('any-type'), ahead);
});

test('a claim whose until is more than seven hours past the reader clock is not live, whatever its at says', () => {
  const skewed = { ...claim('c1', 1, 'writer-b'), at: '2026-11-11T13:00:00.001Z', until: '2026-11-11T19:00:00.001Z' };

  assert.equal(replay([skewed], now).claims.get('any-type'), undefined);
});

test('a claim whose until is six hours past the reader clock is live, as a claim taken now is', () => {
  const fresh = { ...claim('c1', 1, 'writer-b'), at: now.toISOString(), until: '2026-11-11T18:00:00.000Z' };

  assert.equal(replay([fresh], now).claims.get('any-type'), fresh);
});

test('of two active claims of a class, the earliest by clock, then uuid, owns it on every replica', () => {
  const events = [claim('c3', 2, 'writer-c'), claim('cb', 1, 'writer-b'), claim('ca', 1, 'writer-a')];

  assert.deepEqual(
    [events, events.toReversed()].map((replica) => replay(replica, now).claims.get('any-type')?.writer),
    ['writer-a', 'writer-a'],
  );
});

test('a renewal by the holder keeps the owner and moves its until to the renewed claim', () => {
  const renewedUntil = '2026-11-11T17:00:00.000Z';
  const events = [claim('c1', 1, 'writer-a'), claim('c2', 2, 'writer-a', renewedUntil)];
  const afterFirstUntil = new Date('2026-11-11T16:30:00.000Z');

  assert.deepEqual(
    [now, afterFirstUntil].map((reader) => replay(events, reader).claims.get('any-type')?.until),
    [renewedUntil, renewedUntil],
  );
});

function input(overrides: Partial<AddInput> = {}): AddInput {
  return { class: 'any-type', where: 'src/a.ts:1', source: 'census:any-type', note: 'cast', layer: 2, ...overrides };
}

test('an add of a weed the log has never seen is added, and records that its writer saw no close', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');

  assert.deepEqual(planAdd([], input(), now), {
    said: 'added',
    id,
    drafts: [{ op: 'add', id, ...input(), sawCloses: [], sawTend: null }],
  });
});

test('an add of a weed the log shows open is seen and writes nothing', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');

  assert.deepEqual(planAdd([add('a1', 1, id)], input(), now), { said: 'seen', id, drafts: [] });
});

test('an add of a weed any kept close names is kept and writes nothing, even after a later close of another kind', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');
  const events = [add('a1', 1, id), close('a2', 2, [id], 'kept'), close('b2', 3, [id], 'one-off')];

  assert.deepEqual(planAdd(events, input(), now), { said: 'kept', id, drafts: [] });
});

test('an add of a weed closed before records every close of it its writer saw', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');
  const events = [add('a1', 1, id), close('a2', 2, [id], 'one-off'), close('b2', 2, [id, 'other'], 'one-off')];

  const outcome = planAdd(events, input(), now);

  assert.deepEqual(outcome.said === 'added' ? outcome.drafts[0].sawCloses : null, ['a2', 'b2']);
});

test('an add records only the closes that name its weed, so a keep of another weed neither keeps it nor is seen', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');
  const events = [add('a1', 1, 'other'), close('a2', 2, ['other'], 'kept')];

  assert.deepEqual(planAdd(events, input(), now), {
    said: 'added',
    id,
    drafts: [{ op: 'add', id, ...input(), sawCloses: [], sawTend: null }],
  });
});

test('an add is neither kept nor records the close by a keep of another class that names its weed', () => {
  const id = weedId('any-type', 'src/a.ts:1', 'census:any-type');

  assert.deepEqual(planAdd([close('k1', 1, [id], 'kept', 'other')], input(), now), {
    said: 'added',
    id,
    drafts: [{ op: 'add', id, ...input(), sawCloses: [], sawTend: null }],
  });
});

test('an add of a class a tend pass closed is regrown and records the latest tend close of its class it saw', () => {
  const events = [
    tend('t5', 5, ['o1'], 'other'),
    tend('t4', 4, ['w2']),
    tend('t2', 2, ['w1']),
    add('a1', 1, 'w1'),
    add('a3', 3, 'w2'),
  ];

  const outcome = planAdd(events, input(), now);

  assert.deepEqual(
    [outcome.said, outcome.said === 'regrown' ? [outcome.drafts[0].sawTend, outcome.after.uuid] : null],
    ['regrown', ['t4', 't4']],
  );
});

const oneOff = { kind: 'one-off', by: 'generated code', check: null } as const;

test('a close that finds nothing open says so and writes nothing', () => {
  assert.deepEqual(planClose([], { target: { id: 'x' }, ...oneOff }, 'writer-a', now), {
    said: 'nothing open',
    drafts: [],
  });
});

test('a close by id writes one close event naming that open weed and its class', () => {
  const events = [add('a1', 1, 'x'), add('a2', 2, 'y')];

  assert.deepEqual(planClose(events, { target: { id: 'x' }, ...oneOff }, 'writer-a', now), {
    said: 'closed',
    closed: ['x'],
    drafts: [{ op: 'close', ids: ['x'], class: 'any-type', ...oneOff }],
  });
});

test('a close of a class writes one close event naming every open weed of that class', () => {
  const events = [add('a1', 1, 'x'), add('a2', 2, 'y', { class: 'other' }), add('a3', 3, 'z')];

  assert.deepEqual(planClose(events, { target: { class: 'any-type' }, ...oneOff }, 'writer-a', now), {
    said: 'closed',
    closed: ['x', 'z'],
    drafts: [{ op: 'close', ids: ['x', 'z'], class: 'any-type', ...oneOff }],
  });
});

test('a keep says kept', () => {
  const keep = { kind: 'kept', by: 'on purpose', check: null } as const;

  const outcome = planClose([add('a1', 1, 'x')], { target: { id: 'x' }, ...keep }, 'writer-a', now);

  assert.equal(outcome.said, 'kept');
});

test('a close is refused while another writer holds an active claim of the class', () => {
  const held = claim('c1', 2, 'writer-b');

  assert.deepEqual(planClose([add('a1', 1, 'x'), held], { target: { id: 'x' }, ...oneOff }, 'writer-a', now), {
    said: 'claimed by another',
    claim: held,
    drafts: [],
  });
});

test('a close by the holder also releases every active claim it holds of the class, renewals included', () => {
  const events = [
    add('a1', 1, 'x'),
    claim('c0', 2, 'writer-a', at),
    claim('c1', 3, 'writer-a'),
    claim('c2', 4, 'writer-a'),
    claim('o1', 5, 'writer-a', later, 'other'),
  ];

  const outcome = planClose(events, { target: { class: 'any-type' }, ...oneOff }, 'writer-a', now);

  assert.deepEqual(outcome.said === 'closed' ? outcome.drafts.slice(1) : null, [
    { op: 'release', class: 'any-type', claim: 'c1' },
    { op: 'release', class: 'any-type', claim: 'c2' },
  ]);
});

test('a close by the holder releases only its own claims, not a later claim of the class by another writer', () => {
  const events = [add('a1', 1, 'x'), claim('c1', 2, 'writer-a'), claim('c2', 3, 'writer-b')];

  const outcome = planClose(events, { target: { class: 'any-type' }, ...oneOff }, 'writer-a', now);

  assert.deepEqual(outcome.said === 'closed' ? outcome.drafts.slice(1) : null, [
    { op: 'release', class: 'any-type', claim: 'c1' },
  ]);
});

test('a close by id by the holder writes the close and no release, so the class stays claimed', () => {
  const events = [add('a1', 1, 'x'), add('a2', 2, 'y'), claim('c1', 3, 'writer-a')];

  const outcome = planClose(events, { target: { id: 'x' }, ...oneOff }, 'writer-a', now);

  assert.deepEqual(outcome.said === 'closed' ? outcome.drafts : null, [
    { op: 'close', ids: ['x'], class: 'any-type', ...oneOff },
  ]);
});

test('an unpushed claim of a class another writer holds in the shared events loses, even with a lower clock', () => {
  const owner = claim('cb', 5, 'writer-b');
  const mine = claim('ca', 1, 'writer-a');

  assert.deepEqual(losingClaims([owner], [mine], 'writer-a', now), [{ claim: mine, owner }]);
});

test('an unpushed renewal of a class this writer owns through a shared claim does not lose', () => {
  assert.deepEqual(losingClaims([claim('c1', 1, 'writer-a')], [claim('c2', 2, 'writer-a')], 'writer-a', now), []);
});

test('an unpushed claim of a class no other writer holds does not lose', () => {
  const shared = [claim('o1', 1, 'writer-b', later, 'other')];

  assert.deepEqual(losingClaims(shared, [claim('c2', 2, 'writer-a')], 'writer-a', now), []);
});

test("an unpushed claim beside another writer's expired claim does not lose", () => {
  const expired = claim('cb', 1, 'writer-b', at);

  assert.deepEqual(losingClaims([expired], [claim('c2', 2, 'writer-a')], 'writer-a', now), []);
});

test("an unpushed claim beside another writer's released claim does not lose", () => {
  const shared = [claim('cb', 1, 'writer-b'), release('rb', 2, 'cb')];

  assert.deepEqual(losingClaims(shared, [claim('c2', 3, 'writer-a')], 'writer-a', now), []);
});

test('a release by the holder writes one release per live claim it holds of the class, renewals included', () => {
  const events = [
    claim('c0', 1, 'writer-a', at),
    claim('c1', 2, 'writer-a'),
    claim('c2', 3, 'writer-a'),
    claim('o1', 4, 'writer-a', later, 'other'),
  ];

  assert.deepEqual(planRelease(events, 'any-type', 'writer-a', now), {
    said: 'released',
    drafts: [
      { op: 'release', class: 'any-type', claim: 'c1' },
      { op: 'release', class: 'any-type', claim: 'c2' },
    ],
  });
});

test('the releases of a planned claim name each claim of its writer, class and until that no release names yet', () => {
  const events = [
    claim('c1', 1, 'writer-a'),
    claim('c2', 2, 'writer-a'),
    release('r2', 3, 'c2'),
    claim('c3', 4, 'writer-a', at),
    claim('c4', 5, 'writer-b'),
    claim('c5', 6, 'writer-a', later, 'other'),
  ];
  const planned = { op: 'claim', class: 'any-type', writer: 'writer-a', holder: 'Ada', until: later } as const;

  assert.deepEqual(releasesOfClaim(events, planned), [{ op: 'release', class: 'any-type', claim: 'c1' }]);
});

test('a lost claim the events already release is not released again, so a second give-back writes nothing', () => {
  const owner = claim('cb', 1, 'writer-b');
  const lost = [{ claim: claim('ca', 2, 'writer-a'), owner }];

  assert.deepEqual(
    [releasesOfLostClaims([owner], lost), releasesOfLostClaims([owner, release('ra', 3, 'ca')], lost)],
    [[{ op: 'release', class: 'any-type', claim: 'ca' }], []],
  );
});

test('a release by a writer that holds no claim of the class writes nothing and says so', () => {
  assert.deepEqual(planRelease([claim('cb', 1, 'writer-b')], 'any-type', 'writer-a', now), {
    said: 'no claim',
    drafts: [],
  });
});

test('a claim of a named class with nothing open says nothing open and writes nothing', () => {
  assert.deepEqual(planClaim([add('a1', 1, 'x', { class: 'other' })], 'any-type', 'writer-a', 'Ada', now), {
    said: 'nothing open',
    class: 'any-type',
    drafts: [],
  });
});

test('a claim of a named class with one open weed is claimed', () => {
  assert.equal(planClaim([add('a1', 1, 'x')], 'any-type', 'writer-a', 'Ada', now).said, 'claimed');
});

test('a claim of a class another writer holds is taken', () => {
  const held = claim('c1', 1, 'writer-b');

  assert.deepEqual(planClaim([held], 'any-type', 'writer-a', 'Ada on laptop', now), {
    said: 'taken',
    claim: held,
    drafts: [],
  });
});

test('a claim of a free class is claimed for six hours from now', () => {
  const events = [add('a1', 1, 'x'), add('a2', 2, 'y'), claim('c1', 3, 'writer-b', at)];

  assert.deepEqual(planClaim(events, 'any-type', 'writer-a', 'Ada on laptop', now), {
    said: 'claimed',
    class: 'any-type',
    drafts: [
      {
        op: 'claim',
        class: 'any-type',
        writer: 'writer-a',
        holder: 'Ada on laptop',
        until: '2026-11-11T18:00:00.000Z',
      },
    ],
  });
});

test('a claim by the writer that holds the class renews it with a fresh until', () => {
  const events = [add('a1', 1, 'x'), add('a2', 2, 'y'), claim('c1', 3, 'writer-a')];

  const outcome = planClaim(events, 'any-type', 'writer-a', 'Ada on laptop', now);

  assert.deepEqual(
    [outcome.said, outcome.said === 'claimed' ? outcome.drafts[0].until : null],
    ['claimed', '2026-11-11T18:00:00.000Z'],
  );
});

function openWeed(fields: Partial<OpenWeed>): OpenWeed {
  return {
    id: `${fields.where ?? 'src/a.ts:1'}@${fields.firstAt ?? at}`,
    firstAt: at,
    class: 'any-type',
    where: 'src/a.ts:1',
    source: 'census:any-type',
    note: '',
    layer: null,
    regrownAfter: null,
    ...fields,
  };
}

const tendedClose: TendedClose = {
  op: 'close',
  uuid: '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6',
  clock: 1,
  at,
  ids: ['x'],
  class: 'any-type',
  by: 'bed/any-type@1a2b3c4',
  kind: 'tended',
  check: 'eslint.config.mjs',
};

test('groups count open weeds and distinct files per class, most first', () => {
  const events = [
    add('a1', 1, 'w', { class: 'hollow-assertion', where: 'src/a.spec.ts:3', layer: 2 }),
    add('a2', 2, 'x', { class: 'hollow-assertion', where: 'src/a.spec.ts:9', layer: 2 }),
    add('a3', 3, 'y', { class: 'hollow-assertion', where: 'src/b.spec.ts:1', layer: 2 }),
    add('a4', 4, 'z', { class: 'double-cast', where: 'src/c.ts:4', layer: 1 }),
  ];

  const groups = groupWeeds(replay(events, now).open);

  assert.deepEqual(
    groups.map((group) => [group.class, group.open, group.places, group.layer]),
    [
      ['hollow-assertion', 3, 2, 2],
      ['double-cast', 1, 1, 1],
    ],
  );
});

test('a group counts a file once with or without a line, counts regrown weeds, and takes the lowest layer and first sighting', () => {
  const [group] = groupWeeds([
    openWeed({ where: 'src/a.ts:12', firstAt: '2026-11-07T10:00:00.000Z', layer: 3, regrownAfter: tendedClose }),
    openWeed({ where: 'src/a.ts:34', firstAt: '2026-11-06T09:00:00.000Z', layer: 1, regrownAfter: tendedClose }),
    openWeed({ where: 'src/a.ts', firstAt: '2026-11-08T00:00:00.000Z' }),
    openWeed({ where: 'src/x:1.ts:4' }),
    openWeed({ where: 'src/x:1.ts:9' }),
  ]);

  assert.deepEqual(group, {
    class: 'any-type',
    open: 5,
    places: 2,
    regrown: 2,
    firstAt: '2026-11-06T09:00:00.000Z',
    layer: 1,
  });
});

test('a class whose weeds name no layer has no layer', () => {
  assert.equal(groupWeeds([openWeed({})])[0]?.layer, null);
});

test('groups sort by open weeds, then by regrowth, then by name', () => {
  const groups = groupWeeds([
    openWeed({ class: 'b-one', where: 'b' }),
    openWeed({ class: 'a-one', where: 'a' }),
    openWeed({ class: 'c-regrown', where: 'c', regrownAfter: tendedClose }),
    openWeed({ class: 'd-three', where: 'd1' }),
    openWeed({ class: 'd-three', where: 'd2' }),
    openWeed({ class: 'd-three', where: 'd3' }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.class),
    ['d-three', 'c-regrown', 'a-one', 'b-one'],
  );
});

test('a writer may act on a class under its own live claim, and is refused one it holds no claim of or another holds', () => {
  const owner = claim('c1', 1, 'writer-b');
  const garden = replay([owner, claim('c2', 2, 'writer-a', later, 'other')], now);

  assert.deepEqual(
    [
      claimRefusal(garden, 'other', 'writer-a'),
      claimRefusal(garden, 'unclaimed-class', 'writer-a'),
      claimRefusal(garden, 'any-type', 'writer-a'),
    ],
    [undefined, { kind: 'unclaimed' }, { kind: 'held', owner }],
  );
});

test('a claim of the next ready class finds nothing ready when no class has two open weeds', () => {
  assert.deepEqual(planClaim([add('a1', 1, 'x')], null, 'writer-a', 'Ada on laptop', now), {
    said: 'nothing ready',
    drafts: [],
  });
});

test('a claim of the next ready class finds nothing ready when a class has two open weeds in one file', () => {
  const events = [
    add('a1', 1, 'x', { where: 'src/panel.spec.ts:412' }),
    add('a2', 2, 'y', { where: 'src/panel.spec.ts:476' }),
  ];

  assert.deepEqual(planClaim(events, null, 'writer-a', 'Ada on laptop', now), { said: 'nothing ready', drafts: [] });
});

test('a claim of the next ready class takes a class with two open weeds', () => {
  const outcome = planClaim([add('a1', 1, 'x'), add('a2', 2, 'y')], null, 'writer-a', 'Ada on laptop', now);

  assert.deepEqual([outcome.said, outcome.said === 'claimed' ? outcome.class : null], ['claimed', 'any-type']);
});

test('a claim of the next ready class skips a class another writer holds', () => {
  const events = [
    add('a1', 1, 'x'),
    add('a2', 2, 'y'),
    add('a3', 3, 'p', { class: 'other' }),
    add('a4', 4, 'q', { class: 'other' }),
    claim('c1', 5, 'writer-b'),
  ];

  const outcome = planClaim(events, null, 'writer-a', 'Ada on laptop', now);

  assert.deepEqual([outcome.said, outcome.said === 'claimed' ? outcome.class : null], ['claimed', 'other']);
});

test('a claim of the next ready class never picks stale-verification or repeated-lesson', () => {
  const events = ['stale-verification', 'repeated-lesson'].flatMap((weedClass, index) => [
    add(`a${String(index)}x`, 1, `${weedClass}-x`, { class: weedClass }),
    add(`a${String(index)}y`, 2, `${weedClass}-y`, { class: weedClass }),
  ]);

  assert.deepEqual(planClaim(events, null, 'writer-a', 'Ada on laptop', now), { said: 'nothing ready', drafts: [] });
});

test('a claim of the next ready class takes the class with the most open weeds first, as groups lists them', () => {
  const events = [
    add('a1', 1, 'x'),
    add('a2', 2, 'y'),
    add('a3', 3, 'p', { class: 'other' }),
    add('a4', 4, 'q', { class: 'other' }),
    add('a5', 5, 'r', { class: 'other' }),
  ];

  const outcome = planClaim(events, null, 'writer-a', 'Ada on laptop', now);

  assert.deepEqual([outcome.said, outcome.said === 'claimed' ? outcome.class : null], ['claimed', 'other']);
});

test('a claim of the next ready class breaks a tie in open weeds by the most regrown', () => {
  const events = [
    add('a1', 1, 'x'),
    add('a2', 2, 'y'),
    add('a3', 3, 'w', { class: 'other' }),
    tend('t4', 4, ['w'], 'other'),
    add('a5', 5, 'p', { class: 'other', sawTend: 't4' }),
    add('a6', 6, 'q', { class: 'other' }),
  ];

  const outcome = planClaim(events, null, 'writer-a', 'Ada on laptop', now);

  assert.deepEqual([outcome.said, outcome.said === 'claimed' ? outcome.class : null], ['claimed', 'other']);
});

test('a claim of the next ready class breaks a tie in open and regrown weeds by class name', () => {
  const events = [
    add('a1', 1, 'x', { class: 'z-class' }),
    add('a2', 2, 'y', { class: 'z-class' }),
    add('a3', 3, 'p', { class: 'a-class' }),
    add('a4', 4, 'q', { class: 'a-class' }),
  ];

  const outcome = planClaim(events, null, 'writer-a', 'Ada on laptop', now);

  assert.deepEqual([outcome.said, outcome.said === 'claimed' ? outcome.class : null], ['claimed', 'a-class']);
});

test('stamping gives the drafts the next clocks after the replica, in order, and the writer time', () => {
  const drafts = [
    { op: 'seed', sha: 'a'.repeat(40) },
    { op: 'release', class: 'any-type', claim: 'c1' },
  ] as const;

  assert.deepEqual(
    stamp(drafts, 7, now).map((event) => [event.op, event.clock, event.at]),
    [
      ['seed', 8, now.toISOString()],
      ['release', 9, now.toISOString()],
    ],
  );
});

test('an event lives in a shard named by the first two characters of its uuid', () => {
  assert.equal(
    eventPath('0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6'),
    'events/0f/0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6.json',
  );
});

const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
const weed = weedId('any-type', 'src/x.ts:1', 'census:any-type');

test('an event file that is not JSON parses to the reason it was skipped', () => {
  assert.equal(parseEvent(eventPath(uuid), '{"op":'), 'not JSON');
});

test('an add event file parses back to the event that was written', () => {
  const event = storedAdd(uuid, 3, { layer: 2, note: 'cast', sawCloses: ['c1'], sawTend: 't1' });

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('an add event file whose id is not the weed id of its class, where and source is skipped, so it cannot stand in for another weed', () => {
  const event = { ...storedAdd(uuid, 3), id: weedId('any-type', 'src/y.ts:1', 'census:any-type') };

  assert.equal(
    parseEvent(eventPath(uuid), JSON.stringify(event)),
    'id is not the weed id of its class, where and source',
  );
});

test('an add event file whose layer is not a whole number from 1 to 6 is skipped, as add refuses it', () => {
  const parse = (layer: number): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify(storedAdd(uuid, 3, { layer })));

  assert.deepEqual(
    [parse(0), parse(7), parse(2.5)],
    [
      'layer is not a whole number from 1 to 6',
      'layer is not a whole number from 1 to 6',
      'layer is not a whole number from 1 to 6',
    ],
  );
});

test('an add event file whose where is blank is skipped, as add refuses it', () => {
  const parse = (where: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify(storedAdd(uuid, 3, { where })));

  assert.deepEqual([parse(''), parse(' ')], ['where is blank', 'where is blank']);
});

test('an add event file whose source does not name its kind is skipped, as add refuses it', () => {
  const event = storedAdd(uuid, 3, { source: 'abc1234' });

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'source is not <kind>:<ref>');
});

test('an add event file at layer 1 or 6, the first and last layers, parses', () => {
  const parse = (layer: number): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify(storedAdd(uuid, 3, { layer })));

  assert.deepEqual([parse(1), parse(6)], [storedAdd(uuid, 3, { layer: 1 }), storedAdd(uuid, 3, { layer: 6 })]);
});

test('an event file whose uuid is not its file name is skipped, so it cannot shadow another event', () => {
  const other = 'ff3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';

  assert.equal(parseEvent(eventPath(other), JSON.stringify(storedAdd(uuid, 3))), 'uuid is not its file name');
});

test('an event file whose uuid is not a lowercase UUID is skipped, though it is its file name', () => {
  const parse = (name: string): GardenEvent | string => parseEvent(eventPath(name), JSON.stringify(add(name, 3, 'x')));

  assert.deepEqual([parse('not-a-uuid'), parse(uuid.toUpperCase())], ['uuid is not a UUID', 'uuid is not a UUID']);
});

test('an event file whose uuid has text before or after a UUID is skipped, though it is its file name', () => {
  const parse = (name: string): GardenEvent | string => parseEvent(eventPath(name), JSON.stringify(add(name, 3, 'x')));

  assert.deepEqual([parse(`a${uuid}`), parse(`${uuid}a`)], ['uuid is not a UUID', 'uuid is not a UUID']);
});

test('an event file whose class has text after a kebab-case class id is skipped', () => {
  const event = storedAdd(uuid, 3, { class: 'any-type!' });

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'class "any-type!" is not a kebab-case class id');
});

test('the bed commit of a tend close is what its by names after the @', () => {
  assert.equal(bedCommit(tend(uuid, 4, [weed])), '1a2b3c4');
});

test('an event file whose at is not a date is skipped', () => {
  const event = { ...storedAdd(uuid, 3), at: 'yesterday' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'at is not a date');
});

test('an event file whose clock is past the whole numbers a double holds is skipped, so it cannot stop later clocks', () => {
  const parse = (clock: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify(storedAdd(uuid, 3)).replace('"clock":3', `"clock":${clock}`));

  assert.deepEqual(
    [parse('1e400'), parse('9007199254740992')],
    ['clock is not a whole number from 0', 'clock is not a whole number from 0'],
  );
});

test('an event file whose clock is below 0 is skipped', () => {
  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(storedAdd(uuid, -1))), 'clock is not a whole number from 0');
});

test('an event file at clock 0 parses, since the clock counts from 0', () => {
  const event = storedAdd(uuid, 0);

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('an event file whose at is a date in another form than the UTC one writers stamp is skipped', () => {
  const parse = (time: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify({ ...storedAdd(uuid, 3), at: time }));

  assert.deepEqual(
    [parse('Wed, 11 Nov 2026 10:00:00 GMT'), parse('2026-11-11 10:00')],
    ['at is not a date', 'at is not a date'],
  );
});

test('an event file whose at is past year 9999 is skipped, so string order stays time order', () => {
  const event = { ...storedAdd(uuid, 3), at: '+010000-01-01T00:00:00.000Z' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'at is not a date');
});

test('a claim event file whose until is not a date is skipped, rather than read as expired', () => {
  const event = { ...claim(uuid, 5, 'writer-a'), until: 'tomorrow' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'until is not a date');
});

test('a claim event file whose until is a local time is skipped, so every reader ends the claim at the same moment', () => {
  const event = { ...claim(uuid, 5, 'writer-a'), until: '2026-11-11 16:00' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'until is not a date');
});

test('a claim event file whose until is more than six hours after its at is skipped, so no claim holds a class for good', () => {
  const event = { ...claim(uuid, 5, 'writer-a'), until: '2026-11-11T16:00:00.001Z' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), "until is more than a claim's lifetime after at");
});

test('a close event file parses back to the event that was written', () => {
  const event = close(uuid, 4, [weed, weedId('any-type', 'src/y.ts:1', 'census:any-type')], 'one-off');

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a close event file that names no weed is skipped, as a close of nothing open writes nothing', () => {
  const event = close(uuid, 4, [], 'one-off');

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'close names no weed');
});

test('a close event file that names something other than a weed id is skipped', () => {
  const parse = (id: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify(close(uuid, 4, [weed, id], 'one-off')));

  assert.deepEqual(
    [parse('x'), parse(`0${weed}`), parse(`${weed}0`)],
    [
      'close names something other than a weed id',
      'close names something other than a weed id',
      'close names something other than a weed id',
    ],
  );
});

test('a one-off or kept close event file whose reason is blank is skipped, as close refuses it', () => {
  const parse = (by: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify({ ...close(uuid, 4, [weed], 'kept'), by }));

  assert.deepEqual([parse(''), parse(' ')], ['by is blank', 'by is blank']);
});

test('a tend close event file whose check is blank is skipped, as close-class refuses it', () => {
  const parse = (check: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify({ ...tend(uuid, 4, [weed]), check }));

  assert.deepEqual([parse(''), parse(' ')], ['check is blank', 'check is blank']);
});

test('a tend close event file parses back with its bed and check', () => {
  const event = tend(uuid, 4, [weed]);

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a tend close event file naming a bed commit by its full SHA-256 id parses back', () => {
  const event = { ...tend(uuid, 4, [weed]), by: `bed/any-type@${'a'.repeat(64)}` };

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a tend close event file naming a bed commit longer than any object id is skipped', () => {
  const event = { ...tend(uuid, 4, [weed]), by: `bed/any-type@${'a'.repeat(65)}` };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'tend close names no bed/<class>@<commit>');
});

test('a tend close event file that names no bed of its own class is skipped', () => {
  const event = { ...tend(uuid, 4, [weed]), by: 'bed/other@1a2b3c4' };

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'tend close names no bed/<class>@<commit>');
});

test('a tend close event file whose by holds a bed inside other text is skipped', () => {
  const parse = (by: string): GardenEvent | string =>
    parseEvent(eventPath(uuid), JSON.stringify({ ...tend(uuid, 4, [weed]), by }));

  assert.deepEqual(
    [parse('xbed/any-type@1a2b3c4'), parse('bed/any-type@1a2b3c4x')],
    ['tend close names no bed/<class>@<commit>', 'tend close names no bed/<class>@<commit>'],
  );
});

test('a kept close event file parses back to the event that was written', () => {
  const event = close(uuid, 4, [weed], 'kept');

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('an add event file with no layer and no tend seen parses back to the event that was written', () => {
  const event = storedAdd(uuid, 3, { layer: null, sawTend: null });

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a claim event file parses back to the event that was written', () => {
  const event = claim(uuid, 5, 'writer-a');

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a release event file parses back to the event that was written', () => {
  const event = release(uuid, 6, 'ff3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6');

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('a release event file whose claim is not an event uuid is skipped', () => {
  const event = release(uuid, 6, 'c1');

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'claim is not a UUID');
});

test('a seed event file whose sha is not a full commit id is skipped', () => {
  const event = { op: 'seed', uuid, clock: 7, at, sha: '--x' } as const;

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'sha is not a full commit id');
});

test('a seed event file parses back to the event that was written', () => {
  const event = { op: 'seed', uuid, clock: 7, at, sha: 'a'.repeat(40) } as const;

  assert.deepEqual(parseEvent(eventPath(uuid), JSON.stringify(event)), event);
});

test('an event file with an op this version does not know is skipped and names the op', () => {
  const text = JSON.stringify({ op: 'prune', uuid, clock: 8, at });

  assert.equal(parseEvent(eventPath(uuid), text), 'unknown op "prune"');
});

test('an event file whose class is not a kebab-case class id is skipped, since bed refs are built from it', () => {
  const event = claim(uuid, 5, 'writer-a', later, '../main');

  assert.equal(parseEvent(eventPath(uuid), JSON.stringify(event)), 'class "../main" is not a kebab-case class id');
});

test('an event file whose text holds a line break or control character is skipped, since commands print it raw', () => {
  const parse = (event: object): GardenEvent | string => parseEvent(eventPath(uuid), JSON.stringify(event));

  assert.deepEqual(
    [
      parse(add(uuid, 3, 'x\nforged')),
      parse(storedAdd(uuid, 3, { where: 'src/a.ts:1\nforged' })),
      parse(storedAdd(uuid, 3, { source: 'census:\u001b[31m' })),
      parse(storedAdd(uuid, 3, { note: 'a\u202eb' })),
      parse({ ...tend(uuid, 4, [weed]), check: 'checks/a\u0000.mjs' }),
      parse({ ...close(uuid, 4, [weed], 'one-off'), by: 'reason\rmore' }),
      parse({ ...claim(uuid, 5, 'writer-a'), holder: 'a\u2028b' }),
    ],
    [
      'id holds a line break or control character',
      'where holds a line break or control character',
      'source holds a line break or control character',
      'note holds a line break or control character',
      'check holds a line break or control character',
      'by holds a line break or control character',
      'holder holds a line break or control character',
    ],
  );
});

test('each malformed event file says what is wrong with it', () => {
  const base = { uuid, clock: 1, at };
  const parse = (fields: object): GardenEvent | string => parseEvent(eventPath(uuid), JSON.stringify(fields));

  assert.deepEqual(
    [
      parse([]),
      parse({ op: 'seed', uuid, at }),
      parse({ ...storedAdd(uuid, 1), sawCloses: [1] }),
      parse({ ...storedAdd(uuid, 1), sawCloses: ['c1', 1] }),
      parse({ ...close(uuid, 1, [weed], 'one-off'), ids: 'x' }),
      parse({ ...close(uuid, 1, [weed], 'one-off'), check: 'eslint.config.mjs' }),
      parse({ ...claim(uuid, 1, 'writer-a'), until: 1 }),
      parse({ ...base, op: 'release', class: 'any-type' }),
      parse({ ...base, op: 'seed' }),
    ],
    [
      'not an object',
      'missing uuid, clock or at',
      'malformed add',
      'malformed add',
      'malformed close',
      'malformed close',
      'malformed claim',
      'malformed release',
      'malformed seed',
    ],
  );
});
