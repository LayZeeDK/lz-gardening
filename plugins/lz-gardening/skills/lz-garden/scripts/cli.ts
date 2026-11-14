import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unprintablePattern } from './log.ts';
import { inRun } from './store-git.ts';
import type { SyncResult } from './store-sync.ts';

const everyUnprintable = new RegExp(unprintablePattern.source, 'gu');

export function escapeUnprintable(text: string): string {
  return text.replace(everyUnprintable, (character) => `\\u{${character.charCodeAt(0).toString(16)}}`);
}

export function reasonOf(result: SyncResult): string {
  return result.reason === undefined ? '' : ` (${escapeUnprintable(result.reason)})`;
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

  return (
    entry !== undefined &&
    existsSync(entry) &&
    realpathSync.native(resolve(entry)) === realpathSync.native(fileURLToPath(url))
  );
}
