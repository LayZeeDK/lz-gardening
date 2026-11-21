import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  copyPlugin,
  improvedText,
  newWorkspaceRefusal,
  recordedIterations,
  resumeRefusal,
} from './trigger-optimize.ts';

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

test('trigger-optimize --resume refuses a workspace whose eval set has changed since the run started', () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const workspace = join(root, 'workspace');
  const plugin = join(root, 'p');
  const evalSet = join(root, 'e.json');
  mkdirSync(join(plugin, 'skills', 's'), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(plugin, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\n');
  writeFileSync(evalSet, '[]');
  const options = { plugin, skill: 's', evalSet, model: 'sonnet', runs: 3, holdout: 0.4, threshold: 0.5, seed: 42 };
  writeFileSync(join(workspace, 'options.json'), JSON.stringify({ ...options, evalSetSha256: 'old' }));
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'LZ_EVAL_RUN_SLIM');
  const flags = ['--plugin', plugin, '--skill', 's', '--eval-set', evalSet, '--workspace', workspace, '--resume'];

  assert.match(
    spawnSync(process.execPath, [script, ...flags], { encoding: 'utf8', env }).stderr,
    /--resume needs the options the workspace started with: evalSetSha256 old, not [0-9a-f]{64}; skillSha256 undefined/,
  );
});

test('newWorkspaceRefusal lets a new run start in a missing or empty workspace and refuses one that holds files', () => {
  const empty = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const used = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(used, 'results.json'), '{}');

  assert.deepEqual(
    [newWorkspaceRefusal(join(empty, 'new')), newWorkspaceRefusal(empty), newWorkspaceRefusal(used)],
    [null, null, `workspace ${used} is not empty; use a new one, or --resume to go on with it`],
  );
});

test('resumeRefusal resumes a workspace with the same options and names each option that differs', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const unstarted = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(workspace, 'options.json'), JSON.stringify({ runs: 3, seed: 7, model: 'sonnet' }));

  assert.deepEqual(
    [
      resumeRefusal(workspace, { runs: 3, seed: 7, model: 'sonnet' }),
      resumeRefusal(workspace, { runs: 5, seed: 7, model: 'opus' }),
      resumeRefusal(unstarted, {}),
    ],
    [
      null,
      '--resume needs the options the workspace started with: runs 3, not 5; model sonnet, not opus',
      `nothing to resume in ${unstarted}: it has no options.json`,
    ],
  );
});

test('improvedText refuses an improve call the usage limit ended, which reports its limit text as the result', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'trigger-optimize-')), 'result.json');
  const result = JSON.stringify({
    type: 'result',
    is_error: false,
    result: "You've hit your 5-hour limit · resets 3pm",
  });
  writeFileSync(out, JSON.stringify({ status: 0, stdout: result }));

  assert.throws(() => improvedText(0, out), /the improve call hit a usage limit; see .*result\.json/);
});

test('improvedText returns the description a finished improve call wrote and refuses a call with no result', () => {
  const folder = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const out = join(folder, 'result.json');
  writeFileSync(out, JSON.stringify({ stdout: JSON.stringify({ type: 'result', result: 'Garden the repo.' }) }));

  assert.equal(improvedText(0, out), 'Garden the repo.');
  assert.throws(() => improvedText(1, out), /the improve call exited 1 with no result/);
  assert.throws(() => improvedText(0, join(folder, 'missing.json')), /exited 0 with no result; see .*missing\.json/);
});

// A workspace whose iterations evaluated these descriptions; a finished one holds its results and the marker.
function stoppedWorkspace(iterations: readonly { description: string; finished: boolean }[]): string {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  iterations.forEach(({ description, finished }, index) => {
    const folder = join(workspace, `iteration-${String(index + 1)}`);
    mkdirSync(join(folder, 'plugin', 'skills', 's'), { recursive: true });
    writeFileSync(
      join(folder, 'plugin', 'skills', 's', 'SKILL.md'),
      `---\nname: s\ndescription: ${description}\n---\n`,
    );
    writeFileSync(
      join(folder, 'plugin-eval.json'),
      JSON.stringify({
        cases: [{ name: 'q01', arms: { with: [{ turns: 2, graders: [{ name: 'invoked', passed: true }] }] } }],
      }),
    );

    if (finished) {
      writeFileSync(join(folder, 'finished'), '');
    }
  });

  return workspace;
}

test('recordedIterations keeps each finished iteration and sets the first unfinished one aside with its description', () => {
  const workspace = stoppedWorkspace([
    { description: 'A', finished: true },
    { description: 'B', finished: false },
    { description: 'C', finished: true },
  ]);
  const split = { train: [{ query: 'tend it', should_trigger: true }], test: [] };

  const { recorded, aside } = recordedIterations(workspace, 's', split, 0.5, 7);

  assert.deepEqual(
    [recorded.map(({ description, all }) => [description, all?.summary.passed]), aside, readdirSync(workspace).sort()],
    [
      [
        ['A', 1],
        ['B', undefined],
      ],
      join(workspace, 'iteration-2-stopped-7'),
      ['iteration-1', 'iteration-2-stopped-7', 'iteration-3'],
    ],
  );
});

test('recordedIterations keeps every iteration of a workspace whose evaluations all finished and moves none', () => {
  const workspace = stoppedWorkspace([
    { description: 'A', finished: true },
    { description: 'B', finished: true },
  ]);
  const split = { train: [], test: [{ query: 'tend it', should_trigger: true }] };

  const { recorded, aside } = recordedIterations(workspace, 's', split, 0.5, 7);

  assert.deepEqual(
    [recorded.map(({ description }) => description), aside, readdirSync(workspace).sort()],
    [['A', 'B'], null, ['iteration-1', 'iteration-2']],
  );
});

test('resumeRefusal names an option that alone differs', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  writeFileSync(join(workspace, 'options.json'), JSON.stringify({ runs: 3, seed: 7 }));

  assert.equal(
    resumeRefusal(workspace, { runs: 3, seed: 8 }),
    '--resume needs the options the workspace started with: seed 7, not 8',
  );
});

test('copyPlugin copies the plugin without node_modules or evals, with the description, and leaves no partial copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const plugin = join(root, 'plugin');
  ['skills/s', 'node_modules/x', 'evals/q01', 'scripts'].forEach((folder) => {
    mkdirSync(join(plugin, folder), { recursive: true });
  });
  writeFileSync(join(plugin, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: old\n---\nbody\n');
  writeFileSync(join(plugin, 'scripts', 'a.ts'), 'export {};\n');
  const copy = join(root, 'iteration-1', 'plugin');
  mkdirSync(join(root, 'iteration-1', 'plugin.partial', 'stale'), { recursive: true });

  copyPlugin(plugin, copy, 's', 'new');

  assert.deepEqual(
    [
      readdirSync(copy).sort(),
      readFileSync(join(copy, 'skills', 's', 'SKILL.md'), 'utf8'),
      readdirSync(join(root, 'iteration-1')),
    ],
    [['scripts', 'skills'], '---\nname: s\ndescription: "new"\n---\nbody\n', ['plugin']],
  );
});

test('copyPlugin makes a first copy where no partial copy was left', () => {
  const root = mkdtempSync(join(tmpdir(), 'trigger-optimize-'));
  const plugin = join(root, 'plugin');
  mkdirSync(join(plugin, 'skills', 's'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: old\n---\n');

  copyPlugin(plugin, join(root, 'copy'), 's', 'new');

  assert.deepEqual(readdirSync(join(root, 'copy')), ['skills']);
});

test('trigger-optimize refuses a holdout that leaves no training set', () => {
  assert.match(optimize(['--holdout', '1']), /--holdout must be a number from 0 to below 1, not 1/);
});
