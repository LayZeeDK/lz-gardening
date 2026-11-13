import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isRecord } from './log.ts';
import { run } from './site.ts';
import { censusRef, pendingCensusRef, writePendingCensus } from './store.ts';
import { commit, git, init } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'site.ts');

export interface SiteRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly summary: ReadonlyMap<string, unknown>;
}

function siteRun(status: number | null, stdout: string, stderr: string): SiteRun {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  const parsed: unknown = last.startsWith('{') ? JSON.parse(last) : {};
  const summary = new Map(isRecord(parsed) ? Object.entries(parsed) : []);

  return { status, stderr, summary };
}

export function site(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  let stdout = '';
  let stderr = '';
  const status = run(args, {
    cwd,
    env,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });

  return siteRun(status, stdout, stderr);
}

export function siteProcess(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });

  return siteRun(result.status, result.stdout, result.stderr);
}

// A repository with one commit on main and its site, planted once per test process and outside every test. A child
// process plants it, so a mutation-test runner does not count what site.ts open reaches as reached by every test.
// Each test plants a copy.
const template = plantTemplate();

function plantTemplate(): string {
  const folder = mkdtempSync(join(tmpdir(), 'garden-'));
  process.once('exit', () => {
    rmSync(folder, { recursive: true, force: true });
  });
  const dir = join(folder, 'repo');
  init(dir);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const opened = siteProcess(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  return folder;
}

export function planted(t: TestContext): { readonly dir: string; readonly garden: string } {
  const folder = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  cpSync(template, folder, { recursive: true });
  const dir = join(folder, 'repo');
  const garden = join(folder, 'repo.garden');
  const config = join(garden, '.git', 'config');
  const origin = (folderOfRepo: string): string =>
    `url = ${join(realpathSync.native(folderOfRepo), 'repo').replaceAll('\\', '\\\\')}\n`;
  const text = readFileSync(config, 'utf8');
  assert.ok(text.includes(origin(template)), `${config} names its origin as ${origin(template)}`);
  assert.match(text, /^\twriter = /m);
  writeFileSync(
    config,
    // Replacer functions, as a replacement string would expand a $& or $1 in the path.
    text
      .replace(origin(template), () => origin(folder))
      .replace(/^\twriter = .*$/m, () => `\twriter = ${randomUUID()}`),
  );

  return { dir, garden };
}

export function bareRemote(dir: string): string {
  const remote = join(dirname(dir), 'remote.git');
  git(dirname(dir), ['init', '-q', '--bare', remote]);
  git(dir, ['remote', 'add', 'origin', remote]);

  return remote;
}

export function sharedPair(t: TestContext): {
  readonly first: { readonly dir: string; readonly garden: string };
  readonly second: { readonly dir: string; readonly garden: string };
  readonly remote: string;
} {
  const first = planted(t);
  const remote = bareRemote(first.dir);
  const second = planted(t);
  git(second.dir, ['remote', 'add', 'origin', remote]);

  return { first, second, remote };
}

export function writeCensusText(garden: string, text: string): void {
  writePendingCensus(garden, 'fixture', text);
  git(garden, ['update-ref', censusRef, pendingCensusRef('fixture')]);
  git(garden, ['update-ref', '-d', pendingCensusRef('fixture')]);
}

export function writeCensus(garden: string, sha = 'a'.repeat(40), rev = 'main'): void {
  const census = { rev, sha, takenAt: '2026-11-07T00:00:00.000Z', counts: {}, hits: {}, duplicates: {} };
  writeCensusText(garden, JSON.stringify(census));
}

// The process environment plus git settings, as a user passes them to git through GIT_CONFIG_COUNT.
export function configEnv(settings: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
  };
}
