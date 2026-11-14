import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { weedId } from './log.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import { capturingIo, commit, git } from './test-repo.ts';
import { planted, writeCensus } from './test-site.ts';
import { run } from './weeds.ts';
import type { SyncSeams } from './weeds.ts';

export const script = join(dirname(fileURLToPath(import.meta.url)), 'weeds.ts');

export const now = new Date('2026-11-07T12:00:00.000Z');

export interface WeedsRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function cli(cwd: string, args: readonly string[], env = process.env, at?: Date): WeedsRun {
  return cliWith(cwd, args, {}, env, at ?? new Date());
}

// The claim tests that pass sync seams plan against the fixed now.
export function cliWith(cwd: string, args: readonly string[], seams: SyncSeams, env = process.env, at = now): WeedsRun {
  const captured = capturingIo(cwd, env);
  const code = run(args, captured.io, at, seams);

  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

export function addWeed(dir: string, where: string, weedClass = 'any-type'): string {
  const added = cli(dir, ['add', '--class', weedClass, '--where', where, '--source', 'census:x']);
  assert.equal(added.code, 0, added.stderr);

  return weedId(weedClass, where, 'census:x');
}

export function cliProcess(cwd: string, args: readonly string[], env = process.env): WeedsRun {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function eslintConfig(files: string, rules: string): string {
  return `export default [\n  {\n    files: ${files},\n    rules: ${rules},\n  },\n];\n`;
}

// The any-type bed made by hand: a worktree of the site on bed/any-type at the checkout's main.
export function anyTypeBedFromMain(garden: string): string {
  const bed = join(garden, 'beds', 'any-type');
  git(garden, ['fetch', '-q', 'origin', 'main']);
  git(garden, ['worktree', 'add', '-q', '-b', 'bed/any-type', bed, 'FETCH_HEAD']);

  return bed;
}

export function tendedBed(
  t: TestContext,
  check: Readonly<Record<string, string>>,
  where = Object.keys(check)[0] ?? '',
  before: Readonly<Record<string, string>> = {},
): { readonly dir: string; readonly garden: string; readonly bed: string; readonly tip: string } {
  const { dir, garden } = planted(t);
  commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**']", '{}'), ...before });
  const bed = anyTypeBedFromMain(garden);
  const tip = commit(bed, check);
  const base = commit(dir, { 'src/b.ts': 'export const b = 1;\n' });
  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);
  assert.equal(added.code, 0, added.stderr);
  writeCensus(garden, base);
  assert.equal(cli(dir, ['claim', '--class', 'any-type']).code, 0);
  const closed = cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', where]);
  assert.equal(closed.code, 0, closed.stderr);

  return { dir, garden, bed, tip };
}

export function editCheckByHand(garden: string, check: string): void {
  [...logFiles(garden)]
    .filter(([, event]) => event['kind'] === 'tended')
    .forEach(([path, event]) => {
      writeToLogByHand(garden, path, JSON.stringify({ ...event, check }));
    });
}

export function homeAt(t: TestContext, folder: string): void {
  ['HOME', 'USERPROFILE'].forEach((name) => {
    const was = process.env[name];
    t.after(() => {
      if (was === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = was;
      }
    });
    process.env[name] = folder;
  });
}
