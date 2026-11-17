import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Io } from './cli.ts';
import { isRecord } from './log.ts';
import { gitStartChannel } from './store-git-reader.ts';
import { mayPointAtARepository } from './store-git.ts';

// A git variable inherited from the shell that may point git at a repository, such as a hook's GIT_DIR, would add the
// scripts' --local-env-vars read to every run, so the tests see what a plain terminal sees.
for (const name of Object.keys(process.env).filter(mayPointAtARepository)) {
  Reflect.deleteProperty(process.env, name);
}

process.env['GIT_CONFIG_GLOBAL'] = fileURLToPath(new URL('test.gitconfig', import.meta.url));
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

export const now = new Date('2026-11-07T12:00:00.000Z');

export function summaryOf(stdout: string): ReadonlyMap<string, unknown> {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  const parsed: unknown = last.startsWith('{') ? JSON.parse(last) : {};

  return new Map(isRecord(parsed) ? Object.entries(parsed) : []);
}

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

// The command of each process this test starts from now on, in order; a reader's git counts as one cat-file.
export function startedCommands(t: TestContext): readonly (string | undefined)[] {
  const commands: (string | undefined)[] = [];
  const original = childProcess.spawnSync;
  const reader = (): void => {
    commands.push('cat-file');
  };
  t.mock.method(childProcess, 'spawnSync', (...args: unknown[]): unknown => {
    const [, commandArgs] = args;
    commands.push(
      Array.isArray(commandArgs)
        ? commandArgs.filter((arg: unknown) => typeof arg === 'string').find((arg) => /^[a-z][a-z-]*$/.test(arg))
        : undefined,
    );

    return Reflect.apply(original, childProcess, args);
  });
  syncBuiltinESMExports();
  subscribe(gitStartChannel, reader);
  t.after(() => {
    unsubscribe(gitStartChannel, reader);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  return commands;
}

export interface StartedGit {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly input: string | undefined;
}

// Each process this test starts through spawnSync from now on, in order: its arguments and what it ran with.
export function startedGits(t: TestContext): () => readonly StartedGit[] {
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  return () =>
    spawned.mock.calls.map(({ arguments: [, args, options] }) => ({
      args: Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [],
      cwd: typeof options?.cwd === 'string' ? options.cwd : undefined,
      env: options?.env,
      input: typeof options?.input === 'string' ? options.input : undefined,
    }));
}

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function scriptRun(
  script: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ScriptRun {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });
}

export async function scriptProcess(
  script: string,
  cwd: string,
  args: readonly string[],
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  const [stdout, status] = await Promise.all([
    text(child.stdout),
    new Promise<number | null>((resolve, reject) => {
      child.on('error', reject).on('close', resolve);
    }),
  ]);

  return { status, stdout };
}

export interface CapturingIo {
  readonly io: Io;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

// The Io a test runs a script's run function with in this process, keeping what it prints.
export function capturingIo(cwd: string, env: Readonly<NodeJS.ProcessEnv>): CapturingIo {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      cwd,
      env,
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function repo(t: TestContext): string {
  const folderWithRoomForSiblings = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(folderWithRoomForSiblings, { recursive: true, force: true });
  });
  const dir = join(folderWithRoomForSiblings, 'repo');
  init(dir);

  return dir;
}

// One repository is initialised per test process, outside every test, and copied for each test, as starting git
// costs 40-100 ms on Windows.
const emptyGitFolder = initialised();

export function init(dir: string): void {
  mkdirSync(dir);
  cpSync(emptyGitFolder, join(dir, '.git'), { recursive: true });
}

function initialised(): string {
  const folder = mkdtempSync(join(tmpdir(), 'garden-empty-'));
  process.once('exit', () => {
    rmSync(folder, { recursive: true, force: true });
  });
  git(folder, ['init', '-q', '-b', 'main', 'repo']);
  appendFileSync(join(folder, 'repo', '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = test\n');

  return join(folder, 'repo', '.git');
}

export function commit(dir: string, files: Readonly<Record<string, string>>): string {
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  });

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'x']);

  return headOf(dir);
}

// The commit HEAD names, read from the files a commit has just written, as starting git costs 40-100 ms on Windows;
// git reads any other layout, such as a worktree's .git file.
function headOf(dir: string): string {
  const gitDir = join(dir, '.git');

  if (!statSync(gitDir).isDirectory()) {
    return git(dir, ['rev-parse', 'HEAD']);
  }

  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  const ref = /^ref: (refs\/heads\/\S+)$/.exec(head)?.[1];

  return ref === undefined ? head : readFileSync(join(gitDir, ref), 'utf8').trim();
}
