import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { weedId } from './log.ts';
import { openSite } from './store-log.ts';
import { logFiles, writeToLogByHand } from './test-log.ts';
import { capturingIo, commit, git, now, scriptRun } from './test-repo.ts';
import type { ScriptRun } from './test-repo.ts';
import { planted, writeCensus } from './test-site.ts';
import type { Planted } from './test-site.ts';
import { run } from './weeds.ts';
import type { SyncSeams } from './weeds.ts';

export const script = join(import.meta.dirname, 'weeds.ts');

export function cli(cwd: string, args: readonly string[], env = process.env, at?: Date): ScriptRun {
  return cliWith(cwd, args, {}, env, at ?? new Date());
}

// The claim tests that pass sync seams plan against the fixed now.
export function cliWith(
  cwd: string,
  args: readonly string[],
  seams: SyncSeams,
  env = process.env,
  at = now,
): ScriptRun {
  const captured = capturingIo(cwd, env);
  const status = run(args, captured.io, at, seams);

  return { status, stdout: captured.stdout(), stderr: captured.stderr() };
}

export function addWeed(dir: string, where: string, weedClass = 'any-type'): string {
  const added = cli(dir, ['add', '--class', weedClass, '--where', where, '--source', 'census:x']);
  assert.equal(added.status, 0, added.stderr);

  return weedId(weedClass, where, 'census:x');
}

export function cliProcess(cwd: string, args: readonly string[], env = process.env): ScriptRun {
  return scriptRun(script, cwd, args, env);
}

export function eslintConfig(files: string, rules: string): string {
  return `export default [\n  {\n    files: ${files},\n    rules: ${rules},\n  },\n];\n`;
}

// A bed made by hand: a worktree of the site on bed/<class> at the checkout's main.
export function bedFromMain(garden: string, weedClass: string): string {
  const bed = join(garden, 'beds', weedClass);
  git(garden, ['fetch', '-q', 'origin', 'main']);
  git(garden, ['worktree', 'add', '-q', '-b', `bed/${weedClass}`, bed, 'FETCH_HEAD']);

  return bed;
}

// A bed of the class that commits `check` on the checkout's main, named as --tended takes it.
export function tendedBy(dir: string, weedClass: string, check: Readonly<Record<string, string>>): string {
  const tip = commit(bedFromMain(openSite(dir).path, weedClass), check);

  return `bed/${weedClass}@${tip.slice(0, 7)}`;
}

export function tendedBed(
  t: TestContext,
  check: Readonly<Record<string, string>>,
  where: readonly string[] = [Object.keys(check)[0] ?? ''],
  before: Readonly<Record<string, string>> = {},
): Planted & { readonly bed: string; readonly tip: string } {
  const checkFlags = where.flatMap((path) => ['--check', path]);
  const { dir, garden } = planted(t);
  commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**']", '{}'), ...before });
  const bed = bedFromMain(garden, 'any-type');
  const tip = commit(bed, check);
  const base = commit(dir, { 'src/b.ts': 'export const b = 1;\n' });
  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111']);
  assert.equal(added.status, 0, added.stderr);
  writeCensus(garden, base);
  assert.equal(cli(dir, ['claim', '--class', 'any-type']).status, 0);
  const closed = cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, ...checkFlags]);
  assert.equal(closed.status, 0, closed.stderr);

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
