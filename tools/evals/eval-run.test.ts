import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, git, repo } from '../../plugins/lz-gardening/skills/lz-garden/scripts/test-repo.ts';
import {
  findEvalCase,
  prepareRuns,
  runPlan,
  runRefusal,
  scaffold,
  slimArgs,
  type EvalCase,
  type PlannedRun,
} from './eval-run.ts';

function gardenCase(): EvalCase {
  return {
    id: 0,
    name: 'garden-seed',
    prompt: 'prompts/garden.md',
    after: null,
    timeoutMinutes: 14,
    allow: 'Edit Write',
    rules: null,
    assertions: [{ text: 'A census ran.', check: 'census-taken' }],
  };
}

test('runPlan gives each configuration, model and run its own sample and run folder', () => {
  const plan = runPlan({
    evalCase: gardenCase(),
    iterationDir: 'W:/iteration-2',
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new', old_skill: 'P:/old' },
    models: ['sonnet'],
    runs: 2,
  });

  assert.deepEqual(
    plan.map(({ sample, runDir, plugin }) => ({ sample, runDir, plugin })),
    [
      {
        sample: 'S:/samples/iteration-2-new_skill-sonnet-1',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/new_skill/run-1',
        plugin: 'P:/new',
      },
      {
        sample: 'S:/samples/iteration-2-new_skill-sonnet-2',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/new_skill/run-2',
        plugin: 'P:/new',
      },
      {
        sample: 'S:/samples/iteration-2-old_skill-sonnet-1',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/old_skill/run-1',
        plugin: 'P:/old',
      },
      {
        sample: 'S:/samples/iteration-2-old_skill-sonnet-2',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/old_skill/run-2',
        plugin: 'P:/old',
      },
    ],
  );
});

test('slimArgs runs the case prompt on the sample with its site, plugin, model, limit, allow list and rules', () => {
  const evalCase = { ...gardenCase(), rules: 'rules' };
  const [run] = runPlan({
    evalCase,
    iterationDir: 'W:/iteration-2',
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new' },
    models: ['opus'],
    runs: 1,
  });

  assert.deepEqual(run === undefined ? [] : slimArgs(evalCase, 'E:/evals', run), [
    '--cwd',
    'S:/samples/iteration-2-new_skill-opus-1',
    '--prompt-file',
    'E:/evals/prompts/garden.md',
    '--add-dir',
    'S:/samples/iteration-2-new_skill-opus-1.garden',
    '--out',
    'W:/iteration-2/eval-garden-seed-opus/new_skill/run-1/outputs/result.json',
    '--plugin-dir',
    'P:/new',
    '--model',
    'opus',
    '--timeout-min',
    '14',
    '--allow',
    'Edit Write',
    '--rules',
    'E:/evals/rules',
  ]);
});

test('findEvalCase reads the named case from evals.json, with no rules unless it names some, and refuses an unknown name', () => {
  const { rules, ...garden } = gardenCase();
  const evals = { plugin: 'lz-gardening', evals: [garden, { ...garden, id: 1, name: 'tend', rules: 'rules' }] };

  assert.deepEqual(
    [findEvalCase(evals, 'garden-seed'), findEvalCase(evals, 'tend').rules, rules],
    [gardenCase(), 'rules', null],
  );
  assert.throws(() => findEvalCase(evals, 'prune'), /no eval case named prune/);
});

test('findEvalCase refuses a named case whose fields are malformed', () => {
  const evals = { evals: [{ ...gardenCase(), timeoutMinutes: '14' }] };

  assert.throws(() => findEvalCase(evals, 'garden-seed'), /eval case garden-seed in evals.json is malformed/);
});

function iterationFor(evalCase: EvalCase): { iteration: string; plan: PlannedRun[] } {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-run-')).replaceAll('\\', '/');
  const plan = runPlan({
    evalCase,
    iterationDir: iteration,
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new' },
    models: ['sonnet'],
    runs: 1,
  });

  return { iteration, plan };
}

test('runRefusal sends a case to the case it follows until that case has a result on every sample', () => {
  const tend = { ...gardenCase(), id: 1, name: 'tend', after: 'garden-seed' };
  const { iteration, plan } = iterationFor(tend);
  const seed = `${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`;
  const before = runRefusal(plan, iteration, tend);
  mkdirSync(seed, { recursive: true });
  writeFileSync(`${seed}/result.json`, '{}');

  assert.deepEqual(
    [before, runRefusal(plan, iteration, tend)],
    [`run garden-seed first: ${iteration}/eval-tend-sonnet/new_skill/run-1`, null],
  );
});

test('runRefusal refuses runs that already have a result', () => {
  const { iteration, plan } = iterationFor(gardenCase());
  const outputs = `${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`;
  mkdirSync(outputs, { recursive: true });
  writeFileSync(`${outputs}/result.json`, '{}');

  assert.equal(
    runRefusal(plan, iteration, gardenCase()),
    `move these runs aside first: ${iteration}/eval-garden-seed-sonnet/new_skill/run-1`,
  );
});

test('prepareRuns writes the eval metadata per model and an outputs folder per run', () => {
  const { iteration, plan } = iterationFor(gardenCase());

  prepareRuns(plan, iteration, gardenCase(), 'Seed the garden.\n');

  assert.deepEqual(
    [
      JSON.parse(readFileSync(`${iteration}/eval-garden-seed-sonnet/eval_metadata.json`, 'utf8')),
      existsSync(`${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`),
    ],
    [
      {
        eval_id: 0,
        eval_name: 'garden-seed',
        prompt: 'Seed the garden.\n',
        assertions: [{ text: 'A census ran.', check: 'census-taken' }],
      },
      true,
    ],
  );
});

test('scaffold clones main alone into a bare origin and a sample, opens its garden site and gives it the patterns', (t) => {
  const origin = repo(t);
  const head = commit(origin, { 'a.ts': 'export const a = 1;\n' });
  git(origin, ['branch', 'other']);
  const root = dirname(origin);
  writeFileSync(join(root, 'patterns.json'), '{"patterns":[]}\n');
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = test\n\temail = test@example.com\n');
  const testConfig = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = join(root, 'gitconfig');
  t.after(() => {
    if (testConfig === undefined) {
      Reflect.deleteProperty(process.env, 'GIT_CONFIG_GLOBAL');
    } else {
      process.env['GIT_CONFIG_GLOBAL'] = testConfig;
    }
  });
  const sample = {
    config: 'new_skill',
    model: 'sonnet',
    run: 1,
    plugin: fileURLToPath(new URL('../../plugins/lz-gardening', import.meta.url)),
    sample: `${root}/sample`,
  };

  scaffold(sample, origin, join(root, 'patterns.json'));

  assert.deepEqual(
    [
      git(`${root}/sample-origin.git`, ['for-each-ref', '--format=%(refname)']),
      git(`${root}/sample`, ['rev-parse', 'HEAD']),
      existsSync(`${root}/sample.garden`),
      readFileSync(`${root}/sample.garden/.garden/patterns.json`, 'utf8'),
    ],
    ['refs/garden/log\nrefs/heads/main', head, true, '{"patterns":[]}\n'],
  );
});
