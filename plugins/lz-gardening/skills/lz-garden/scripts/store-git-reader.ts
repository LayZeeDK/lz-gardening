// The reader strategy of a run: one `git cat-file --batch-command` per folder and env, kept for the run and driven
// synchronously through a pump that moves bytes to and from the git processes.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
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

// The pump runs in a worker thread started from this function's source text, so it names nothing outside its body:
// no module to resolve or strip of types when the worker starts. It knows nothing of git.
// Stryker disable all: a mutant placed here calls Stryker's own functions, which the worker's copy of the text lacks
function pumpBody(): void {
  const { spawn } = process.getBuiltinModule('node:child_process');
  const threads = process.getBuiltinModule('node:worker_threads');
  const { MessagePort } = threads;
  const data: unknown = threads.workerData;

  if (
    typeof data !== 'object' ||
    data === null ||
    !('port' in data) ||
    !(data.port instanceof MessagePort) ||
    !('signal' in data) ||
    !(data.signal instanceof Int32Array)
  ) {
    throw new Error('the pump needs a port and a signal');
  }

  const { port, signal } = data;
  const children = new Map<number, ChildProcessWithoutNullStreams>();
  const tell = (message: FromPump): void => {
    port.postMessage(message);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
  };

  port.on('message', (message: ToPump) => {
    const { reader } = message;

    switch (message.kind) {
      case 'start': {
        const child = spawn(message.command, message.args, { cwd: message.cwd, env: message.env });
        children.set(reader, child);
        child.on('error', (error) => {
          tell({ kind: 'ended', reader, code: null, error: error.message });
        });
        child.stdout.on('data', (chunk: Uint8Array) => {
          tell({ kind: 'out', reader, chunk });
        });
        child.stderr.on('data', (chunk: Uint8Array) => {
          tell({ kind: 'err', reader, chunk });
        });
        child.on('close', (code) => {
          tell({ kind: 'ended', reader, code });
        });
        tell({ kind: 'started', reader });
        break;
      }
      case 'write': {
        children.get(reader)?.stdin.write(message.bytes);
        break;
      }
      case 'end': {
        children.get(reader)?.stdin.end();
        break;
      }
      case 'kill': {
        children.get(reader)?.kill('SIGKILL');
        break;
      }
    }
  });
}
// Stryker restore all

function isFromPump(value: unknown): value is FromPump {
  return typeof value === 'object' && value !== null && 'kind' in value && 'reader' in value;
}

// The main thread waits on the shared signal, which the pump moves after each message, and reads the port with
// receiveMessageOnPort: no event loop turn is needed, so the store's reads stay synchronous.
export function workerPump(): Pump {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(`(${pumpBody.toString()})()`, {
    eval: true,
    workerData: { port: port2, signal },
    transferList: [port2],
  });

  return {
    post: (message) => {
      port1.postMessage(message);
    },
    take: (deadline) => {
      for (;;) {
        const seen = Atomics.load(signal, 0);
        const received: unknown = receiveMessageOnPort(port1)?.message;

        if (isFromPump(received)) {
          return received;
        }

        // A deadline already passed waits no time.
        if (Atomics.wait(signal, 0, seen, deadline - Date.now()) === 'timed-out') {
          return undefined;
        }
      }
    },
    stop: () => {
      void worker.terminate();
    },
  };
}

export const gitStartChannel = 'lz-gardening.git-start';

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
    channel(gitStartChannel).publish({ args: batchCommandArgs });
    from.post({ kind: 'start', reader: started, command: 'git', args: batchCommandArgs, cwd: at.cwd, env: envOf(at) });
    const start = takeFrom(from, started);

    if (start === undefined) {
      from.post({ kind: 'kill', reader: started });
      throw new Error(`git cat-file --batch-command: did not start in ${String(answerMs)} ms`);
    }

    if (start.kind === 'ended') {
      throw new Error(`git could not start: ${start.error ?? `it ended with code ${String(start.code)}`}`);
    }

    readers.set(key, { reader: started, cwd: at.cwd });

    return started;
  };

  const round = <T, TAnswer extends ObjectInfo>(
    at: ReadAt,
    items: readonly T[],
    bytes: string,
    parse: (output: Buffer, items: readonly T[]) => Parse<T, TAnswer>,
    nameOf: (item: T) => string,
  ): readonly (readonly [T, TAnswer])[] => {
    // Done on no output only when nothing was asked: git then has nothing to answer, and no reader is started.
    const unasked = parse(Buffer.alloc(0), items);

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
    // Each answer is parsed once: only the bytes after the last whole answer are kept for the next chunk.
    const answers: (readonly [T, TAnswer])[] = [];
    let output = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    for (;;) {
      const message = takeFrom(from, reader);

      if (message === undefined) {
        return fail(`no answer in ${String(answerMs)} ms`);
      }

      if (message.kind === 'ended') {
        forget(reader);
        throw new Error(
          message.error === undefined
            ? `git cat-file --batch-command: ${stderr.toString().trim()}`
            : `git could not start: ${message.error}`,
        );
      }

      if (message.kind === 'err') {
        stderr = Buffer.concat([stderr, message.chunk]);
      }

      if (message.kind === 'out') {
        output = Buffer.concat([output, message.chunk]);
      }

      const parsed = parse(output, items.slice(answers.length));
      answers.push(...parsed.answers);

      if (parsed.done) {
        const stray = outOfStep(
          answers.map(([item, answer]) => [nameOf(item), answer]),
          parsed.end,
          output.length,
        );

        if (stray !== undefined) {
          return fail(stray);
        }

        return answers;
      }

      output = output.subarray(parsed.end);
    }
  };

  const ids = (at: ReadAt, names: readonly string[]): readonly (string | undefined)[] =>
    round(at, names, encodeRequests('info', names), parseInfos, (name) => name).map(([, answer]) =>
      answer.kind === 'object' ? answer.oid : undefined,
    );

  const contents = <T>(
    at: ReadAt,
    items: readonly T[],
    nameOf: (item: T) => string,
  ): readonly (readonly [T, ObjectContents])[] =>
    round(at, items, encodeRequests('contents', items.map(nameOf)), parseContents, nameOf);

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
