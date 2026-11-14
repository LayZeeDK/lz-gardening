import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Io } from './cli.ts';
import { isRecord } from './log.ts';

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

export function scriptProcess(
  script: string,
  cwd: string,
  args: readonly string[],
): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject).on('close', (status) => {
      resolve({ status, stdout });
    });
  });
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

export function init(dir: string): void {
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  appendFileSync(join(dir, '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = test\n');
}

export function commit(dir: string, files: Readonly<Record<string, string>>): string {
  Object.entries(files).forEach(([path, content]) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  });

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'x']);

  return git(dir, ['rev-parse', 'HEAD']);
}
