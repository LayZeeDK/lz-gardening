import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit } from './test-repo.ts';
import { planted, site } from './test-site.ts';

export const script = join(dirname(fileURLToPath(import.meta.url)), 'weeds.ts');

export const now = new Date('2026-11-07T12:00:00.000Z');

export function cli(
  dir: string,
  args: readonly string[],
  cwd = process.cwd(),
  env = process.env,
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args, '--file', join(dir, '.garden', 'weeds.jsonl')], {
    cwd,
    env,
    encoding: 'utf8',
  });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function recordCensus(garden: string, sha: string): void {
  const census = { rev: 'main', sha, takenAt: now.toISOString(), counts: {}, hits: {}, duplicates: {} };
  writeFileSync(join(garden, '.garden', 'census.json'), JSON.stringify(census));
}

export function eslintConfig(files: string, rules: string): string {
  return `export default [\n  {\n    files: ${files},\n    rules: ${rules},\n  },\n];\n`;
}

export function tendedBed(
  t: TestContext,
  check: Readonly<Record<string, string>>,
  where = Object.keys(check)[0] ?? '',
  before: Readonly<Record<string, string>> = {},
): { readonly dir: string; readonly garden: string; readonly bed: string; readonly tip: string } {
  const { dir, garden } = planted(t);
  commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**']", '{}'), ...before });
  site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  const bed = join(garden, 'beds', 'any-type');
  const tip = commit(bed, check);
  const base = commit(dir, { 'src/b.ts': 'export const b = 1;\n' });
  cli(garden, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'commit:aaa1111'], dir);
  recordCensus(garden, base);
  cli(garden, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', where], dir);

  return { dir, garden, bed, tip };
}

export function editCheckByHand(garden: string, check: string): void {
  const queueFile = join(garden, '.garden', 'weeds.jsonl');
  const checkField = `"check":${JSON.stringify(check)}`;
  writeFileSync(queueFile, readFileSync(queueFile, 'utf8').replace('"check":"checks/any-type.test.mjs"', checkField));
}
