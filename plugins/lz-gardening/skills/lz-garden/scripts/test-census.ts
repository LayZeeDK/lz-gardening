// The census tests' shared utilities: the command line run in this process or as a child, the patterns and censuses
// the tests build, and a census recorded by a sync.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, takeCensus } from './census.ts';
import type { PatternSet } from './census.ts';
import { gitEnv, inRun } from './store-git.ts';
import { openSite } from './store-log.ts';
import type { Census } from './store-census.ts';
import { sync } from './store-sync.ts';
import { capturingIo, now, summaryOf } from './test-repo.ts';

export const script = join(import.meta.dirname, 'census.ts');

export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function censusCli(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Ran {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env });
}

export async function census(dir: string, args: readonly string[]): Promise<Ran> {
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

/** A census.json text of a commit with no hits, as census.ts writes it; extra replaces its fields. */
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

export async function takeAndRecord(dir: string, args: readonly string[] = []): Promise<Ran> {
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
