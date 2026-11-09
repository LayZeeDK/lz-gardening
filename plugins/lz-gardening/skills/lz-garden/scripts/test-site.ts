import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, repo } from './test-repo.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), 'site.ts');

export interface SiteRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly summary: ReadonlyMap<string, unknown>;
}

export function site(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env });
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  const parsed: unknown = last.startsWith('{') ? JSON.parse(last) : {};
  const summary = new Map(typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []);

  return { status: result.status, stderr: result.stderr, summary };
}

// A repository with one commit on main and its site, planted.
export function planted(t: TestContext): { readonly dir: string; readonly garden: string } {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const opened = site(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  return { dir, garden: join(dirname(dir), 'repo.garden') };
}

export function queueOneWeed(garden: string): void {
  mkdirSync(join(garden, '.garden'), { recursive: true });
  writeFileSync(join(garden, '.garden', 'weeds.jsonl'), '{"op":"add"}\n');
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
