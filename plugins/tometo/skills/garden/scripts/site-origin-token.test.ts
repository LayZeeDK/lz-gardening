import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { run } from './site.ts';
import { logRef } from './store-log.ts';
import { httpRemote } from './test-http-remote.ts';
import { capturingIo, git, summaryOf } from './test-repo.ts';
import { planted } from './test-site.ts';
import { cli } from './test-weeds.ts';

function filesHolding(folder: string, needles: readonly string[]): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => {
      const text = readFileSync(path, 'latin1');

      return needles.some((needle) => text.includes(needle));
    });
}

// The CI recipe's layout: the action writes the job's token into the checkout's origin URL, and every sync reads it.
test('a sync through an origin URL holding a token pushes the queue, and prints and stores none of the token', async (t) => {
  const { dir, garden } = planted(t);
  const token = randomUUID();
  const credentials = `x-access-token:${token}`;
  git(dirname(dir), ['clone', '-q', '--bare', dir, 'remote.git']);
  const port = await httpRemote(t, dirname(dir), credentials);
  git(dir, ['remote', 'add', 'origin', `http://${credentials}@127.0.0.1:${port}/remote.git`]);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);
  const captured = capturingIo(dir, process.env);

  const status = run(['sync'], captured.io);

  const output = captured.stdout() + captured.stderr();
  const summary = Object.fromEntries(summaryOf(captured.stdout()));
  const needles = [token, Buffer.from(credentials).toString('base64')];
  assert.deepEqual(
    [status, summary, git(join(dirname(dir), 'remote.git'), ['for-each-ref', '--format=%(objectname)', logRef])],
    [0, { shared: 'synced', events: 1 }, git(garden, ['rev-parse', logRef])],
    output,
  );
  assert.deepEqual(
    [needles.filter((needle) => output.includes(needle)), filesHolding(join(garden, '.git'), needles)],
    [[], []],
  );
  // The scan finds the token where it is: in the checkout's config.
  assert.deepEqual(filesHolding(join(dir, '.git'), needles), [join(dir, '.git', 'config')]);
});

test("a sync through an origin URL whose token origin refuses, with git's tracing on, prints git's reason and none of the token", async (t) => {
  const { dir } = planted(t);
  const token = randomUUID();
  const credentials = `x-access-token:${token}`;
  git(dirname(dir), ['clone', '-q', '--bare', dir, 'remote.git']);
  const port = await httpRemote(t, dirname(dir), `x-access-token:${randomUUID()}`);
  git(dir, ['remote', 'add', 'origin', `http://${credentials}@127.0.0.1:${port}/remote.git`]);
  const captured = capturingIo(dir, {
    ...process.env,
    GIT_TRACE: '1',
    GIT_TRACE2: '1',
    GIT_TRACE_CURL: '1',
    GIT_CURL_VERBOSE: '1',
    GIT_TRACE_REDACT: 'false',
  });

  run(['sync'], captured.io);

  const output = captured.stdout() + captured.stderr();
  const needles = [token, Buffer.from(credentials).toString('base64')];
  assert.deepEqual(
    [Object.fromEntries(summaryOf(captured.stdout())), needles.filter((needle) => output.includes(needle))],
    [
      {
        shared: 'offline',
        events: 0,
        reason: `fatal: Authentication failed for 'http://127.0.0.1:${port}/remote.git/'`,
      },
      [],
    ],
    output,
  );
});
