import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainModule, processIo, reasonOf, runCommand } from './cli.ts';
import type { Io } from './cli.ts';

test('a reason is printed in parentheses after a space, and no reason prints nothing', () => {
  assert.deepEqual([reasonOf({ reason: 'timed out' }), reasonOf({})], [' (timed out)', '']);
});

test("the process's own io writes out to stdout and err to stderr", (t) => {
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const io = processIo();

  io.out('to out');
  io.err('to err');

  assert.deepEqual(
    [stdout.mock.calls.map((call) => call.arguments[0]), stderr.mock.calls.map((call) => call.arguments[0])],
    [['to out'], ['to err']],
  );
});

test("a process run with a script's own file runs that script as its main module, and no other", (t) => {
  const argv = process.argv;
  process.argv = [process.execPath, fileURLToPath(import.meta.url)];
  t.after(() => {
    process.argv = argv;
  });

  assert.deepEqual(
    [isMainModule(import.meta.url), isMainModule(new URL('cli.ts', import.meta.url).href)],
    [true, false],
  );
});

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
