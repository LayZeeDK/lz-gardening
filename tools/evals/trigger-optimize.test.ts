import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workspaceRefusal } from './trigger-optimize.ts';

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

test('trigger-optimize --resume refuses a workspace started with other options, naming each one', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const started = { plugin: 'p', skill: 's', evalSet: 'e.json', model: 'sonnet', runs: 3, holdout: 0.4 };
  writeFileSync(join(workspace, 'options.json'), JSON.stringify({ ...started, threshold: 0.5, seed: 7 }));

  assert.match(
    optimize(['--resume', '--runs', '5'], workspace),
    /--resume needs the options the workspace started with: runs 3, not 5; seed 7, not 42/,
  );
});

test('trigger-optimize --resume refuses a workspace no run started', () => {
  assert.match(optimize(['--resume']), /nothing to resume in .*: it has no options.json/);
});

test('workspaceRefusal lets a new run start in a missing or empty workspace and refuses one that holds files', () => {
  const empty = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const used = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(used, 'results.json'), '{}');

  assert.deepEqual(
    [
      workspaceRefusal(join(empty, 'new'), {}, false),
      workspaceRefusal(empty, {}, false),
      workspaceRefusal(used, {}, false),
    ],
    [null, null, `workspace ${used} is not empty; use a new one, or --resume to go on with it`],
  );
});

test('workspaceRefusal resumes a workspace with the same options and names each option that differs', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const unstarted = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(workspace, 'options.json'), JSON.stringify({ runs: 3, seed: 7, model: 'sonnet' }));

  assert.deepEqual(
    [
      workspaceRefusal(workspace, { runs: 3, seed: 7, model: 'sonnet' }, true),
      workspaceRefusal(workspace, { runs: 5, seed: 7, model: 'opus' }, true),
      workspaceRefusal(unstarted, {}, true),
    ],
    [
      null,
      '--resume needs the options the workspace started with: runs 3, not 5; model sonnet, not opus',
      `nothing to resume in ${unstarted}: it has no options.json`,
    ],
  );
});

test('trigger-optimize refuses a holdout that leaves no training set', () => {
  assert.match(optimize(['--holdout', '1']), /--holdout must be a number from 0 to below 1, not 1/);
});
