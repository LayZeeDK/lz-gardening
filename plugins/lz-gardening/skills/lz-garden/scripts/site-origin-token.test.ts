import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { run } from './site.ts';
import { logRef } from './store-log.ts';
import { httpRemote } from './test-http-remote.ts';
import { git } from './test-repo.ts';
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
  let output = '';

  const status = run(['sync'], {
    cwd: dir,
    env: process.env,
    out: (text) => {
      output += text;
    },
    err: (text) => {
      output += text;
    },
  });

  const summary: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? '');
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
