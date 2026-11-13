import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay, unprintablePattern } from './log.ts';
import { inRun, isShared, readLog } from './store.ts';
import type { Site, SyncResult } from './store.ts';

const everyUnprintable = new RegExp(unprintablePattern.source, 'gu');

export function escapeUnprintable(text: string): string {
  return text.replace(everyUnprintable, (character) => `\\u{${character.charCodeAt(0).toString(16)}}`);
}

export function reasonOf(result: SyncResult): string {
  return result.reason === undefined ? '' : ` (${escapeUnprintable(result.reason)})`;
}

// bed and close-class act on a class only under this writer's live claim, read after a sync that left the log local
// or shared, so another clone's newer claim is seen and this claim is on origin.
export function claimRefusal(site: Site, weedClass: string, pre: SyncResult, now: Date): string | undefined {
  if (!isShared(pre)) {
    return `cannot check the claim of ${weedClass}: ${pre.state}${reasonOf(pre)}`;
  }

  const owner = replay(readLog(site).events, now).claims.get(weedClass);

  if (owner === undefined) {
    return `this site holds no claim of ${weedClass}; run weeds claim --class ${weedClass}`;
  }

  if (owner.writer !== site.writer) {
    return `${weedClass} is claimed by ${escapeUnprintable(owner.holder)} until ${owner.until}`;
  }

  return undefined;
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

export function runCommand(name: string, io: Io, main: () => number): number {
  try {
    return inRun(io.env, main);
  } catch (error: unknown) {
    io.err(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);

    return 2;
  }
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
export function isMainModule(url: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && realpathSync.native(resolve(entry)) === realpathSync.native(fileURLToPath(url));
}
