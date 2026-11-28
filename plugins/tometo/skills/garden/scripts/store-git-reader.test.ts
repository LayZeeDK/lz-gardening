// Run: node --test store-git-reader.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { test } from 'node:test';
import { readerReads, workerPump } from './store-git-reader.ts';
import type { FromPump, Pump, ToPump } from './store-git-reader.ts';
import { repo } from './test-repo.ts';

const oid = 'a'.repeat(40);
const at = { cwd: 'D:/site', overrides: {} };

// A pump with no process: each message posted gets the replies `respond` gives it, taken in order.
function scriptedPump(respond: (message: ToPump) => readonly FromPump[]) {
  const posted: (ToPump | { readonly kind: 'stop'; readonly reader: 0 })[] = [];
  const waiting: FromPump[] = [];
  const pump: Pump = {
    post: (message) => {
      posted.push(message);
      waiting.push(...respond(message));
    },
    take: () => waiting.shift(),
    stop: () => {
      posted.push({ kind: 'stop', reader: 0 });
    },
  };

  return { posted, pump, untaken: () => waiting.length };
}

function readerOf(pump: Pump, starts: Pump[] = []) {
  return readerReads({
    startPump: () => {
      starts.push(pump);

      return pump;
    },
    envOf: () => ({ GIT_DIR: '' }),
    answerMs: 1000,
    endMs: 1000,
  });
}

// A git that answers every write with one commit header, and ends when its input ends or it is killed.
function oneCommitGit(message: ToPump): readonly FromPump[] {
  switch (message.kind) {
    case 'start': {
      return [{ kind: 'started', reader: message.reader }];
    }
    case 'write': {
      return [{ kind: 'out', reader: message.reader, chunk: Buffer.from(`${oid} commit 136\0`) }];
    }
    case 'end': {
      return [{ kind: 'ended', reader: message.reader, code: 0 }];
    }
    case 'kill': {
      return [{ kind: 'ended', reader: message.reader, code: null }];
    }
  }
}

function postedLines(posted: readonly { readonly kind: string; readonly reader: number }[]): readonly string[] {
  return posted.map((message) => `${message.kind} ${String(message.reader)}`);
}

test('an id read starts one git cat-file in the folder and asks it for the name', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);

  assert.deepEqual(
    [readerOf(pump).ids(at, ['HEAD']), posted],
    [
      [oid],
      [
        {
          kind: 'start',
          reader: 1,
          command: 'git',
          args: ['cat-file', '--batch-command', '--buffer', '-Z'],
          cwd: 'D:/site',
          env: { GIT_DIR: '' },
        },
        { kind: 'write', reader: 1, bytes: 'info HEAD\0flush\0' },
      ],
    ],
  );
});

test('a second read in the same folder asks the same git, through the same pump', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const starts: Pump[] = [];
  const reads = readerOf(pump, starts);
  reads.ids(at, ['HEAD']);
  reads.ids(at, ['main']);

  assert.deepEqual([starts.length, posted.map(({ kind }) => kind)], [1, ['start', 'write', 'write']]);
});

test('a read with its own env asks a git of its own, so no other object store answers it', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids({ cwd: 'D:/site', overrides: { GIT_NO_LAZY_FETCH: '1' } }, ['HEAD']);
  reads.ids(at, ['HEAD']);

  assert.deepEqual(
    posted.map((message) => `${message.kind} ${String(message.reader)}`),
    ['start 1', 'write 1', 'start 2', 'write 2', 'write 1'],
  );
});

test('a git that does not answer in time is killed and the read throws', () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'start' ? [{ kind: 'started', reader: message.reader }] : [],
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: no answer in 1000 ms',
  });
  assert.deepEqual(posted.at(-1), { kind: 'kill', reader: 1 });
});

test('after a failed read the next read starts a new git', () => {
  const { posted, pump } = scriptedPump((message) => {
    switch (message.kind) {
      case 'start': {
        return [{ kind: 'started', reader: message.reader }];
      }
      case 'kill': {
        return [{ kind: 'ended', reader: message.reader, code: null }];
      }
      default: {
        return message.reader === 1 ? [] : oneCommitGit(message);
      }
    }
  });
  const reads = readerOf(pump);
  assert.throws(() => reads.ids(at, ['HEAD']));

  assert.deepEqual(
    [reads.ids(at, ['HEAD']), posted.map((message) => `${message.kind} ${String(message.reader)}`)],
    [[oid], ['start 1', 'write 1', 'kill 1', 'start 2', 'write 2']],
  );
});

test("output a killed git sent late is not read as the next git's answer", () => {
  const stale = Buffer.from(`${'b'.repeat(40)} commit 1\0`);
  const { pump } = scriptedPump((message) => {
    switch (message.kind) {
      case 'start': {
        return [{ kind: 'started', reader: message.reader }];
      }
      case 'kill': {
        return [
          { kind: 'out', reader: message.reader, chunk: stale },
          { kind: 'out', reader: message.reader, chunk: stale },
          { kind: 'ended', reader: message.reader, code: null },
        ];
      }
      default: {
        return message.reader === 1 ? [] : oneCommitGit(message);
      }
    }
  });
  const reads = readerOf(pump);
  assert.throws(() => reads.ids(at, ['HEAD']));

  assert.deepEqual(reads.ids(at, ['HEAD']), [oid]);
});

test('a git that answers more than it was asked is out of step: killed, and the read throws', () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [{ kind: 'out', reader: message.reader, chunk: Buffer.from(`${oid} commit 136\0${oid} commit 136\0`) }]
      : oneCommitGit(message),
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: the output goes on past the last answer',
  });
  assert.deepEqual(posted.at(-1), { kind: 'kill', reader: 1 });
});

test("a git that ends during a read fails it with git's own message", () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'write' && message.reader === 1
      ? [
          { kind: 'err', reader: message.reader, chunk: Buffer.from('fatal: invalid ') },
          { kind: 'err', reader: message.reader, chunk: Buffer.from('object type\n') },
          { kind: 'ended', reader: message.reader, code: 128 },
        ]
      : oneCommitGit(message),
  );
  const reads = readerOf(pump);

  assert.throws(() => reads.ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: fatal: invalid object type',
  });
  reads.ids(at, ['HEAD']);
  assert.deepEqual(
    posted.map((message) => `${message.kind} ${String(message.reader)}`),
    ['start 1', 'write 1', 'start 2', 'write 2'],
  );
});

test('a git that stops answering fails the read with what it wrote to stderr', () => {
  const { pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [{ kind: 'err', reader: message.reader, chunk: Buffer.from('error: unable to read packed refs\n') }]
      : oneCommitGit(message),
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: no answer in 1000 ms; git said: error: unable to read packed refs',
  });
});

test('a git that ends during a read with nothing on stderr fails it with its exit code', () => {
  const { pump } = scriptedPump((message) =>
    message.kind === 'write' ? [{ kind: 'ended', reader: message.reader, code: 137 }] : oneCommitGit(message),
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: it ended with code 137',
  });
});

test("a ref's tip is the id git answers for it, and a ref git does not have has none", () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [
          {
            kind: 'out',
            reader: message.reader,
            chunk: Buffer.from(message.bytes.includes('gone') ? 'refs/gone missing\0' : `${oid} commit 136\0`),
          },
        ]
      : oneCommitGit(message),
  );
  const reads = readerOf(pump);

  assert.deepEqual(
    [reads.tip(at, 'refs/garden/log'), reads.tip(at, 'refs/gone'), posted.at(1)],
    [oid, undefined, { kind: 'write', reader: 1, bytes: 'info refs/garden/log\0flush\0' }],
  );
});

test("a contents read pairs each item with its object's bytes", () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [{ kind: 'out', reader: message.reader, chunk: Buffer.from(`${oid} blob 2\0hi\0`) }]
      : oneCommitGit(message),
  );
  const item = { path: 'a.txt' };

  assert.deepEqual(
    [readerOf(pump).contents(at, [item], ({ path }) => `HEAD:${path}`), posted.at(1)],
    [
      [[item, { kind: 'object', oid, type: 'blob', size: 2, bytes: Buffer.from('hi') }]],
      { kind: 'write', reader: 1, bytes: 'contents HEAD:a.txt\0flush\0' },
    ],
  );
});

test('answers cut across chunks inside a header, inside the bytes and before the closing NUL pair as if whole', () => {
  const chunks = [`${oid} bl`, `ob 5\0hel`, 'lo', `\0${oid} blob 2\0hi`, '\0'];
  const { pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? chunks.map((text) => ({ kind: 'out', reader: message.reader, chunk: Buffer.from(text) }) as const)
      : oneCommitGit(message),
  );

  assert.deepEqual(
    readerOf(pump).contents(at, ['HEAD:a.txt', 'HEAD:b.txt'], (name) => name),
    [
      ['HEAD:a.txt', { kind: 'object', oid, type: 'blob', size: 5, bytes: Buffer.from('hello') }],
      ['HEAD:b.txt', { kind: 'object', oid, type: 'blob', size: 2, bytes: Buffer.from('hi') }],
    ],
  );
});

test("a commit's files are walked through contents reads of its trees", () => {
  const blob = 'b'.repeat(40);
  const root = Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(blob, 'hex')]);
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [
          {
            kind: 'out',
            reader: message.reader,
            chunk: Buffer.concat([Buffer.from(`${oid} tree ${String(root.length)}\0`), root, Buffer.from('\0')]),
          },
        ]
      : oneCommitGit(message),
  );

  assert.deepEqual(
    [readerOf(pump).tree(at, 'main'), posted.at(1)],
    [
      [{ type: 'blob', oid: blob, path: 'a.txt' }],
      { kind: 'write', reader: 1, bytes: 'contents main^{tree}\0flush\0' },
    ],
  );
});

test('a read of no names asks git nothing and starts nothing', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const starts: Pump[] = [];
  const reads = readerOf(pump, starts);

  assert.deepEqual(
    [reads.ids(at, []), reads.contents(at, [], (name: string) => name), posted, starts],
    [[], [], [], []],
  );
});

test("close ends every reader's input and stops the pump", () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids({ cwd: 'D:/checkout', overrides: {} }, ['HEAD']);
  reads.close();

  assert.deepEqual(postedLines(posted).slice(4), ['end 1', 'end 2', 'stop 0']);
});

test('close returns once every git has ended, so its folder can be renamed', () => {
  const { pump, untaken } = scriptedPump(oneCommitGit);
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids({ cwd: 'D:/checkout', overrides: {} }, ['HEAD']);
  reads.close();

  assert.equal(untaken(), 0);
});

test('closing one folder ends only its readers; the others keep reading, and it reads again with a new git', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const checkout = { cwd: 'D:/checkout', overrides: {} };
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);
  reads.close('D:/site');
  reads.ids(checkout, ['HEAD']);
  reads.ids(at, ['HEAD']);

  assert.deepEqual(postedLines(posted).slice(4), ['end 1', 'write 2', 'start 3', 'write 3']);
});

test("a git that ends while another folder's close waits is forgotten, so its next read starts a new one", () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'end' ? [{ kind: 'ended', reader: 2, code: 0 }, ...oneCommitGit(message)] : oneCommitGit(message),
  );
  const checkout = { cwd: 'D:/checkout', overrides: {} };
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);
  reads.close('D:/site');
  reads.ids(checkout, ['HEAD']);

  assert.deepEqual(postedLines(posted).slice(4), ['end 1', 'start 3', 'write 3']);
});

test('a git that ends while another reads is forgotten, so its next read starts a new one', () => {
  let writes = 0;
  const { posted, pump } = scriptedPump((message) => {
    if (message.kind === 'write') {
      writes += 1;

      if (writes === 3) {
        return [{ kind: 'ended', reader: 2, code: 0 }, ...oneCommitGit(message)];
      }
    }

    return oneCommitGit(message);
  });
  const checkout = { cwd: 'D:/checkout', overrides: {} };
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);
  reads.ids(at, ['HEAD']);

  assert.deepEqual(postedLines(posted).slice(4), ['write 1', 'start 3', 'write 3', 'write 1']);
});

test('output another git sends while one reads forgets neither git', () => {
  let writes = 0;
  const { posted, pump } = scriptedPump((message) => {
    if (message.kind === 'write') {
      writes += 1;

      if (writes === 3) {
        return [{ kind: 'err', reader: 2, chunk: Buffer.from('warning\n') }, ...oneCommitGit(message)];
      }
    }

    return oneCommitGit(message);
  });
  const checkout = { cwd: 'D:/checkout', overrides: {} };
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);
  reads.ids(at, ['HEAD']);
  reads.ids(checkout, ['HEAD']);

  assert.deepEqual(postedLines(posted).slice(4), ['write 1', 'write 2']);
});

test('the same env overrides in another order ask the same git', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const reads = readerOf(pump);
  reads.ids({ cwd: 'D:/site', overrides: { GIT_A: '1', GIT_B: '2' } }, ['HEAD']);
  reads.ids({ cwd: 'D:/site', overrides: { GIT_B: '2', GIT_A: '1' } }, ['HEAD']);

  assert.deepEqual(postedLines(posted), ['start 1', 'write 1', 'write 1']);
});

test("close waits past a git's last output for its end", () => {
  const { pump, untaken } = scriptedPump((message) =>
    message.kind === 'end'
      ? [{ kind: 'err', reader: message.reader, chunk: Buffer.from('bye\n') }, ...oneCommitGit(message)]
      : oneCommitGit(message),
  );
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.close();

  assert.equal(untaken(), 0);
});

test('a git whose start is not reported in time is killed, and the read throws', () => {
  const { posted, pump } = scriptedPump(() => []);

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), {
    message: 'git cat-file --batch-command: did not start in 1000 ms',
  });
  assert.deepEqual(postedLines(posted), ['start 1', 'kill 1']);
});

test('a second close does nothing, and a read after a close starts a new pump', () => {
  const { posted, pump } = scriptedPump(oneCommitGit);
  const starts: Pump[] = [];
  const reads = readerOf(pump, starts);
  reads.ids(at, ['HEAD']);
  reads.close();
  reads.close();
  reads.ids(at, ['HEAD']);

  assert.deepEqual(
    [postedLines(posted), starts.length],
    [['start 1', 'write 1', 'end 1', 'stop 0', 'start 2', 'write 2'], 2],
  );
});

test('close kills a git that does not end when its input ends, and waits for that', () => {
  const { posted, pump, untaken } = scriptedPump((message) => (message.kind === 'end' ? [] : oneCommitGit(message)));
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.close();

  assert.deepEqual([postedLines(posted).slice(2), untaken()], [['end 1', 'kill 1', 'stop 0'], 0]);
});

test('a folder closed whose git never says it ended reads again with a new git', () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'end' || message.kind === 'kill' ? [] : oneCommitGit(message),
  );
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.close('D:/site');
  reads.ids(at, ['HEAD']);

  assert.deepEqual(postedLines(posted).slice(2), ['end 1', 'kill 1', 'start 2', 'write 2']);
});

test("close waits for a git's end until the end's time has passed since it asked", () => {
  const { pump } = scriptedPump(oneCommitGit);
  const deadlines: number[] = [];
  const reads = readerOf({
    ...pump,
    take: (deadline) => {
      deadlines.push(deadline);

      return pump.take(deadline);
    },
  });
  reads.ids(at, ['HEAD']);
  const taken = deadlines.length;
  const asked = Date.now();
  reads.close();
  const closed = Date.now();

  assert.deepEqual(
    deadlines.slice(taken).map((deadline) => asked + 1000 <= deadline && deadline <= closed + 1000),
    [true],
  );
});

test('a git that cannot start fails the read with the reason, and nothing is written to it', () => {
  const { posted, pump } = scriptedPump((message) =>
    message.kind === 'start' ? [{ kind: 'ended', reader: message.reader, code: null, error: 'spawn git ENOENT' }] : [],
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), { message: 'git could not start: spawn git ENOENT' });
  assert.deepEqual(
    posted.map(({ kind }) => kind),
    ['start'],
  );
});

test('a git that ends before it is said to start, with no error, fails the read with its exit code', () => {
  const { pump } = scriptedPump((message) =>
    message.kind === 'start' ? [{ kind: 'ended', reader: message.reader, code: 128 }] : [],
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), { message: 'git could not start: it ended with code 128' });
});

test('a git that could not start, told only after it was said to start, fails the read with the reason', () => {
  const { pump } = scriptedPump((message) =>
    message.kind === 'write'
      ? [{ kind: 'ended', reader: message.reader, code: null, error: 'spawn git ENOENT' }]
      : oneCommitGit(message),
  );

  assert.throws(() => readerOf(pump).ids(at, ['HEAD']), { message: 'git could not start: spawn git ENOENT' });
});

test('each git a reader starts is told on the tometo.git-start channel, for counts of the git a command starts', (t) => {
  const { pump } = scriptedPump(oneCommitGit);
  const told: unknown[] = [];
  const listen = (message: unknown): void => {
    told.push(message);
  };
  subscribe('tometo.git-start', listen);
  t.after(() => {
    unsubscribe('tometo.git-start', listen);
  });
  const reads = readerOf(pump);
  reads.ids(at, ['HEAD']);
  reads.ids(at, ['HEAD']);

  assert.deepEqual(told, [{ args: ['cat-file', '--batch-command', '--buffer', '-Z'] }]);
});

// Every message the pump sends for one reader, until its end or the deadline.
function messagesOf(pump: Pump, deadlineMs: number): readonly FromPump[] {
  const deadline = Date.now() + deadlineMs;
  const messages: FromPump[] = [];

  for (let message = pump.take(deadline); message !== undefined; message = pump.take(deadline)) {
    messages.push(message);

    if (message.kind === 'ended') {
      break;
    }
  }

  return messages;
}

test('the worker pump starts a process, says so, passes its input and output, and says when it ends', () => {
  const pump = workerPump();
  pump.post({
    kind: 'start',
    reader: 7,
    command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    cwd: process.cwd(),
    env: process.env,
  });
  pump.post({ kind: 'write', reader: 7, bytes: 'hi' });
  pump.post({ kind: 'end', reader: 7 });
  const messages = messagesOf(pump, 10_000);
  pump.stop();

  assert.deepEqual(
    messages.map((message) => (message.kind === 'out' ? `out ${Buffer.from(message.chunk).toString()}` : message)),
    [{ kind: 'started', reader: 7 }, 'out hi', { kind: 'ended', reader: 7, code: 0 }],
  );
});

test('the worker pump kills a process on kill, and says nothing more by a deadline that passes', () => {
  const pump = workerPump();
  pump.post({
    kind: 'start',
    reader: 1,
    command: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    cwd: process.cwd(),
    env: process.env,
  });
  const quiet = [pump.take(Date.now() + 10_000), pump.take(Date.now() + 50)];
  pump.post({ kind: 'kill', reader: 1 });
  const messages = messagesOf(pump, 10_000);
  pump.stop();

  assert.deepEqual(
    [quiet, messages],
    [[{ kind: 'started', reader: 1 }, undefined], [{ kind: 'ended', reader: 1, code: null }]],
  );
});

test('the worker pump says why a command could not start', () => {
  const pump = workerPump();
  pump.post({ kind: 'start', reader: 1, command: 'no-such-command-x', args: [], cwd: process.cwd(), env: process.env });
  const messages = messagesOf(pump, 10_000);
  pump.stop();

  assert.deepEqual(messages, [
    { kind: 'started', reader: 1 },
    { kind: 'ended', reader: 1, code: null, error: 'spawn no-such-command-x ENOENT' },
  ]);
});

test('the worker pump says a process ended that ends while a write to it is pending, and keeps working', () => {
  const pump = workerPump();
  const start = (reader: number, script: string): void => {
    pump.post({
      kind: 'start',
      reader,
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: process.env,
    });
  };
  start(1, 'setTimeout(() => undefined, 300)');
  pump.post({ kind: 'write', reader: 1, bytes: 'x'.repeat(1 << 20) });
  const first = messagesOf(pump, 10_000);
  start(2, 'process.stdout.write("ok")');
  const second = messagesOf(pump, 10_000);
  pump.stop();

  assert.deepEqual(
    [
      first,
      second.map((message) => (message.kind === 'out' ? `out ${Buffer.from(message.chunk).toString()}` : message)),
    ],
    [
      [
        { kind: 'started', reader: 1 },
        { kind: 'ended', reader: 1, code: 0 },
      ],
      [{ kind: 'started', reader: 2 }, 'out ok', { kind: 'ended', reader: 2, code: 0 }],
    ],
  );
});

test('a process that stops its worker pump exits', () => {
  const module = new URL('store-git-reader.ts', import.meta.url).href;
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { workerPump } from '${module}'; workerPump().stop();`],
    { encoding: 'utf8', timeout: 20_000 },
  );

  assert.deepEqual([run.status, run.signal, run.stderr], [0, null, '']);
});

test("close returns once its gits have ended, not at the end's deadline", (t) => {
  const reads = readerReads({ startPump: workerPump, envOf: () => process.env, answerMs: 10_000, endMs: 10_000 });
  reads.ids({ cwd: repo(t), overrides: {} }, ['HEAD']);
  const start = Date.now();
  reads.close();

  assert.ok(Date.now() - start < 5000, `close took ${String(Date.now() - start)} ms`);
});
