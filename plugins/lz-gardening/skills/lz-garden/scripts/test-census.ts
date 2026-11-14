import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, takeCensus } from './census.ts';
import type { PatternSet } from './census.ts';
import { gitEnv, inRun } from './store-git.ts';
import { openSite } from './store-log.ts';
import type { Census } from './store-census.ts';
import { sync } from './store-sync.ts';
import { capturingIo, now, scriptRun, summaryOf } from './test-repo.ts';
import type { ScriptRun } from './test-repo.ts';

export const script = join(import.meta.dirname, 'census.ts');

export function censusCli(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ScriptRun {
  return scriptRun(script, dir, args, env);
}

export async function census(dir: string, args: readonly string[]): Promise<ScriptRun> {
  const captured = capturingIo(dir, process.env);
  const status = await run(args, captured.io);

  return { status, stdout: captured.stdout(), stderr: captured.stderr() };
}

export const set: PatternSet = {
  exclude: ['**/*.md'],
  patterns: [
    { id: 'eslint-disable', regex: 'eslint-disable', paths: [], note: '' },
    { id: 'any-type', regex: '(: any\\b|\\bas any\\b)', paths: ['**/*.ts'], note: '' },
  ],
};

/** A census taken as census.ts takes it: in the run's git environment for the checkout. */
export function takeCensusInRun(cwd: string, rev: string, patterns: PatternSet, at: Date): Promise<Census> {
  return takeCensus(
    cwd,
    rev,
    patterns,
    at,
    inRun(process.env, () => gitEnv(cwd)),
    (id) => id,
  );
}

export function censusOf(
  hits: Readonly<Record<string, readonly string[]>>,
  duplicates: Readonly<Record<string, readonly string[]>> = {},
): Census {
  return {
    rev: 'main',
    sha: 'a'.repeat(40),
    takenAt: now.toISOString(),
    counts: Object.fromEntries(Object.entries(hits).map(([id, list]) => [id, list.length])),
    hits,
    duplicates,
  };
}

export function censusText(sha: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const census = {
    rev: 'main',
    sha,
    takenAt: '2026-11-13T00:00:00.000Z',
    counts: {},
    hits: {},
    duplicates: {},
    ...extra,
  };

  return `${JSON.stringify(census, null, 2)}\n`;
}

export async function takeAndRecord(dir: string, args: readonly string[] = []): Promise<ScriptRun> {
  const result = await census(dir, ['--rev', 'HEAD', ...args]);
  assert.equal(result.status, 0, result.stderr);
  const sha = summaryOf(result.stdout).get('sha');
  assert.equal(typeof sha, 'string');
  sync(openSite(dir), { attempts: 1, census: String(sha) });

  return result;
}

export const todoPatterns = `${JSON.stringify({ patterns: [{ id: 'todo', regex: 'TODO' }] })}\n`;

export function writeSitePatterns(garden: string, text = todoPatterns): void {
  mkdirSync(join(garden, '.garden'), { recursive: true });
  writeFileSync(join(garden, '.garden', 'patterns.json'), text);
}
