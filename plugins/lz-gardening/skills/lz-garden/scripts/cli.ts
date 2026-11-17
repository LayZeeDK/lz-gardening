import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unprintablePattern } from './log.ts';
import { censusRef } from './store-census.ts';
import { inRun } from './store-git.ts';
import type { SyncResult } from './store-sync.ts';

const everyUnprintable = new RegExp(unprintablePattern.source, 'gu');

export function escapeUnprintable(text: string): string {
  return text.replace(everyUnprintable, (character) => `\\u{${character.charCodeAt(0).toString(16)}}`);
}

interface WithReason {
  readonly reason?: string | undefined;
}

export function printableReason(result: WithReason): string | undefined {
  return result.reason === undefined ? undefined : escapeUnprintable(result.reason);
}

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

export function reasonOf(result: WithReason): string {
  const reason = printableReason(result);

  return reason === undefined ? '' : ` (${reason})`;
}

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export function processIo(): Io {
  return {
    get cwd() {
      return process.cwd();
    },
    env: process.env,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
  };
}

export function commandFailed(name: string, io: Io, error: unknown): number {
  io.err(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);

  return 2;
}

export function runCommand(name: string, io: Io, main: () => number): number {
  try {
    return inRun(io.env, main);
  } catch (error: unknown) {
    return commandFailed(name, io, error);
  }
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
export function isMainModule(url: string): boolean {
  const entry = process.argv[1];

  return (
    entry !== undefined &&
    existsSync(entry) &&
    realpathSync.native(resolve(entry)) === realpathSync.native(fileURLToPath(url))
  );
}
