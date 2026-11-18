// Run: node --test sync-notes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimEvent } from './log.ts';
import { syncNotes } from './sync-notes.ts';

function claimOf(holder: string): ClaimEvent {
  return {
    op: 'claim',
    uuid: '00000000-0000-4000-8000-000000000000',
    clock: 1,
    at: '2026-01-01T00:00:00.000Z',
    class: 'any-type',
    writer: 'w',
    holder,
    until: '2026-01-01T06:00:00.000Z',
  };
}

test('a sync that left out, kept local and gave back nothing has no notes', () => {
  const notes = syncNotes({
    state: 'local',
    pushedEvents: 0,
    conflicts: [],
    skipped: [],
    yielded: [],
    divergedBeds: [],
  });

  assert.deepEqual(notes, []);
});

test('a sync names each census it left out or kept, each claim it gave back and each bed origin did not take', () => {
  const notes = syncNotes({
    state: 'synced',
    pushedEvents: 0,
    conflicts: [],
    skipped: [],
    sharedCensusIgnored: true,
    censusKeptLocal: 'b\u0007',
    localCensusUnreadable: true,
    censusStillPending: 'c'.repeat(40),
    yielded: [{ claim: claimOf('Ada'), owner: claimOf('Bea') }],
    divergedBeds: ['bed/any-type stays in the site\u001b'],
  });

  assert.deepEqual(notes, [
    'the shared refs/garden/census on origin is not a census; it was left out, and the next census replaces it',
    'the census of b\\u{7} stays local: no branch fetched from origin holds that commit',
    "the site's refs/garden/census is not a census, so it stays local; delete it in the site (git update-ref -d refs/garden/census), and the next tick records a new one",
    `another sync moved the census first; the census of ${'c'.repeat(40)} stays pending for the next sync`,
    'gave back the claim of any-type; Bea holds it',
    'bed/any-type stays in the site\\u{1b}',
  ]);
});
