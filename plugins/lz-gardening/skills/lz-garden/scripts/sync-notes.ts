import { escapeUnprintable } from './cli.ts';
import { censusRef } from './store-census.ts';
import type { SyncResult } from './store-sync.ts';

/** What a sync left out, gave back or could not share, one line each, for a command to print on stderr. */
export function syncNotes(result: SyncResult): readonly string[] {
  return [
    ...(result.sharedCensusIgnored === true
      ? [`the shared ${censusRef} on origin is not a census; it was left out, and the next census replaces it`]
      : []),
    ...(result.censusKeptLocal === undefined
      ? []
      : [
          `the census of ${escapeUnprintable(result.censusKeptLocal)} stays local: no branch fetched from origin holds that commit`,
        ]),
    ...(result.localCensusUnreadable === true
      ? [
          `the site's ${censusRef} is not a census, so it stays local; delete it in the site (git update-ref -d ${censusRef}), and the next tick records a new one`,
        ]
      : []),
    ...(result.censusStillPending === undefined
      ? []
      : [
          `another sync moved the census first; the census of ${result.censusStillPending} stays pending for the next sync`,
        ]),
    ...result.yielded.map(({ claim, owner }) => `gave back the claim of ${claim.class}; ${owner.holder} holds it`),
    ...result.divergedBeds.map(escapeUnprintable),
  ];
}
