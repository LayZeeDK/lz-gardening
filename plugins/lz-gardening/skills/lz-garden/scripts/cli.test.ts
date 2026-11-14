import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMainModule, processIo, runCommand } from './cli.ts';
import type { Io } from './cli.ts';

test('a command whose folder cannot be read, as after the folder was deleted, exits 2 naming the error', () => {
  let stderr = '';
  const io = {
    get cwd(): string {
      throw new Error('ENOENT: no such file or directory, uv_cwd');
    },
    env: process.env,
    out: () => {},
    err: (text: string) => {
      stderr += text;
    },
  } satisfies Io;

  const code = runCommand('weeds', io, () => io.cwd.length);

  assert.deepEqual([code, stderr], [2, 'weeds: ENOENT: no such file or directory, uv_cwd\n']);
});

test("the process's own io reads the folder only when the command asks for it", (t) => {
  t.mock.method(process, 'cwd', () => {
    throw new Error('ENOENT: no such file or directory, uv_cwd');
  });

  const io = processIo();

  assert.throws(() => io.cwd, /uv_cwd/);
});

test('a process whose argument names no file, as under node -e, runs no script as its main module', (t) => {
  const argv = process.argv;
  process.argv = [process.execPath, 'no-such-file'];
  t.after(() => {
    process.argv = argv;
  });

  assert.equal(isMainModule(import.meta.url), false);
});
