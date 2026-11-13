import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from './log.ts';
import { logRef } from './store.ts';
import { git } from './test-repo.ts';

export function logFiles(garden: string): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  return new Map(
    git(garden, ['ls-tree', '-r', '--name-only', logRef])
      .split('\n')
      .filter((path) => path.startsWith('events/'))
      .flatMap((path) => {
        const event: unknown = JSON.parse(git(garden, ['show', `${logRef}:${path}`]));

        return isRecord(event) ? [[path, event] as const] : [];
      }),
  );
}

export function writeToLogByHand(garden: string, path: string, text: string): void {
  const hashed = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: garden,
    input: text,
    encoding: 'utf8',
  });
  assert.equal(hashed.status, 0, hashed.stderr);
  writeEntriesToLogByHand(garden, [`100644 ${hashed.stdout.trim()}\t${path}`]);
}

export function writeEntriesToLogByHand(garden: string, entries: readonly string[]): void {
  const scratch = mkdtempSync(join(tmpdir(), 'by-hand-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  const run = (args: readonly string[], input?: string): string => {
    const result = spawnSync('git', args, { cwd: garden, env, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    return result.stdout.trim();
  };

  try {
    run(['read-tree', logRef]);
    run(['update-index', '--index-info'], entries.map((entry) => `${entry}\n`).join(''));
    run(['update-ref', logRef, run(['commit-tree', run(['write-tree', '--missing-ok']), '-p', logRef, '-m', 'x'])]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
