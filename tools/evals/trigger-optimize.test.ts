import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('trigger-optimize.ts', import.meta.url));

// Runs the command with the required flags and the extra ones given, with no runner set, so nothing can start.
function optimize(extra: readonly string[], workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'))): string {
  const required = ['--plugin', 'p', '--skill', 's', '--eval-set', 'e.json', '--workspace', workspace];
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'LZ_EVAL_RUN_SLIM');

  return spawnSync(process.execPath, [script, ...required, ...extra], { encoding: 'utf8', env }).stderr;
}

test('trigger-optimize refuses a numeric option that is not a number, before it runs anything', () => {
  assert.match(
    optimize(['--max-iterations', 'five']),
    /--max-iterations must be a whole number of at least 1, not five/,
  );
});

test('trigger-optimize refuses a workspace that already holds files, whose old cases a run would pick up', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(workspace, 'results.json'), '{}');

  assert.match(optimize([], workspace), /workspace .* is not empty; use a new one/);
});

test('trigger-optimize refuses a holdout that leaves no training set', () => {
  assert.match(optimize(['--holdout', '1']), /--holdout must be a number from 0 to below 1, not 1/);
});
