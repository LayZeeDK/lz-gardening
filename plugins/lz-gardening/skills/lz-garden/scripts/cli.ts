import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unprintablePattern } from './log.ts';
import { inRun } from './store-git.ts';

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

/** Prints what stopped a command and returns its exit code. */
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
