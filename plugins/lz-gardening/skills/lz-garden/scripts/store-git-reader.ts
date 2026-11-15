// The reader strategy of a run: one `git cat-file --batch-command` per folder and env, kept for the run and driven
// synchronously through a pump that moves bytes to and from the git processes.
import { encodeRequests, outOfStep, parseContents, parseInfos, walkTree } from './store-git-objects.ts';
import type { ObjectContents, ObjectInfo, ObjectReads, Parse, ReadAt } from './store-git-objects.ts';

export type ToPump =
  | {
      readonly kind: 'start';
      readonly reader: number;
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<NodeJS.ProcessEnv>;
    }
  | { readonly kind: 'write'; readonly reader: number; readonly bytes: string }
  | { readonly kind: 'end'; readonly reader: number }
  | { readonly kind: 'kill'; readonly reader: number };

export type FromPump =
  | { readonly kind: 'started'; readonly reader: number }
  | { readonly kind: 'out'; readonly reader: number; readonly chunk: Uint8Array }
  | { readonly kind: 'err'; readonly reader: number; readonly chunk: Uint8Array }
  | { readonly kind: 'ended'; readonly reader: number; readonly code: number | null; readonly error?: string };

export interface Pump {
  readonly post: (message: ToPump) => void;
  readonly take: (deadline: number) => FromPump | undefined;
  readonly stop: () => void;
}

export interface ReaderOptions {
  readonly startPump: () => Pump;
  readonly envOf: (at: ReadAt) => Readonly<NodeJS.ProcessEnv>;
  readonly answerMs: number;
  readonly endMs: number;
}

export const batchCommandArgs = ['cat-file', '--batch-command', '--buffer', '-Z'] as const;

export function readerReads({ startPump, envOf, answerMs, endMs }: ReaderOptions): ObjectReads {
  let pump: Pump | undefined;
  const readers = new Map<string, { readonly reader: number; readonly cwd: string }>();
  let started = 0;

  const forget = (reader: number): void => {
    for (const [key, held] of readers) {
      if (held.reader === reader) {
        readers.delete(key);
      }
    }
  };

  // The next message of this reader; of another reader's messages only its end is kept.
  const takeFrom = (from: Pump, reader: number): FromPump | undefined => {
    for (;;) {
      const message = from.take(Date.now() + answerMs);

      if (message === undefined || message.reader === reader) {
        return message;
      }

      if (message.kind === 'ended') {
        forget(message.reader);
      }
    }
  };

  const readerAt = (from: Pump, at: ReadAt): number => {
    const key = JSON.stringify([at.cwd, Object.entries(at.overrides).sort()]);
    const known = readers.get(key);

    if (known !== undefined) {
      return known.reader;
    }

    started += 1;
    from.post({ kind: 'start', reader: started, command: 'git', args: batchCommandArgs, cwd: at.cwd, env: envOf(at) });
    const start = takeFrom(from, started);

    if (start === undefined) {
      from.post({ kind: 'kill', reader: started });
      throw new Error(`git cat-file --batch-command: did not start in ${String(answerMs)} ms`);
    }

    if (start.kind === 'ended') {
      throw new Error(`git could not start: ${start.error ?? ''}`);
    }

    readers.set(key, { reader: started, cwd: at.cwd });

    return started;
  };

  const round = <T, TAnswer extends ObjectInfo>(
    at: ReadAt,
    bytes: string,
    parse: (output: Buffer) => Parse<T, TAnswer>,
    nameOf: (item: T) => string,
  ): readonly (readonly [T, TAnswer])[] => {
    // Done on no output only when nothing was asked: git then has nothing to answer, and no reader is started.
    const unasked = parse(Buffer.alloc(0));

    if (unasked.done) {
      return unasked.answers;
    }

    const from = (pump ??= startPump());
    const reader = readerAt(from, at);
    const fail = (reason: string): never => {
      from.post({ kind: 'kill', reader });
      forget(reader);
      throw new Error(`git cat-file --batch-command: ${reason}`);
    };
    from.post({ kind: 'write', reader, bytes });
    let output = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    for (;;) {
      const message = takeFrom(from, reader);

      if (message === undefined) {
        return fail(`no answer in ${String(answerMs)} ms`);
      }

      if (message.kind === 'ended') {
        forget(reader);
        throw new Error(`git cat-file --batch-command: ${stderr.toString().trim()}`);
      }

      if (message.kind === 'err') {
        stderr = Buffer.concat([stderr, message.chunk]);
      }

      if (message.kind === 'out') {
        output = Buffer.concat([output, message.chunk]);
      }

      const parsed = parse(output);

      if (parsed.done) {
        const stray = outOfStep(
          parsed.answers.map(([item, answer]) => [nameOf(item), answer]),
          parsed.end,
          output.length,
        );

        if (stray !== undefined) {
          return fail(stray);
        }

        return parsed.answers;
      }
    }
  };

  const ids = (at: ReadAt, names: readonly string[]): readonly (string | undefined)[] =>
    round(
      at,
      encodeRequests('info', names),
      (output) => parseInfos(output, names),
      (name) => name,
    ).map(([, answer]) => (answer.kind === 'object' ? answer.oid : undefined));

  const contents = <T>(
    at: ReadAt,
    items: readonly T[],
    nameOf: (item: T) => string,
  ): readonly (readonly [T, ObjectContents])[] =>
    round(at, encodeRequests('contents', items.map(nameOf)), (output) => parseContents(output, items), nameOf);

  return {
    tip: (at, ref) => ids(at, [ref])[0],
    ids,
    contents,
    tree: (at, commit) => walkTree((names) => contents(at, names, (name) => name), commit),
    close: (cwd) => {
      const from = pump;

      if (from === undefined) {
        return;
      }

      const closing = [...readers].filter(([, held]) => cwd === undefined || held.cwd === cwd);
      const open = new Set(closing.map(([, held]) => held.reader));
      const endAll = (kind: 'end' | 'kill'): void => {
        for (const reader of open) {
          from.post({ kind, reader });
        }

        const deadline = Date.now() + endMs;

        while (open.size > 0) {
          const message = from.take(deadline);

          if (message === undefined) {
            return;
          }

          if (message.kind === 'ended') {
            open.delete(message.reader);
          }
        }
      };
      endAll('end');
      endAll('kill');

      for (const [key] of closing) {
        readers.delete(key);
      }

      if (cwd === undefined) {
        from.stop();
        pump = undefined;
      }
    },
  };
}
