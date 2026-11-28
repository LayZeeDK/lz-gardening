import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commit, git, repo } from '../../plugins/tometo/skills/garden/scripts/test-repo.ts';
import {
  evalCases,
  findEvalCase,
  newRuns,
  prepareRuns,
  resumeRun,
  runPlan,
  runRefusal,
  sampleFolders,
  samples,
  scaffold,
  unscaffolded,
  setAside,
  slimArgs,
  staleRuns,
  type EvalCase,
  type PlannedRun,
  type Sample,
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
        sample: 'S:/samples/iteration-2-bf90177a8a',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/new_skill/run-1',
        plugin: 'P:/new',
      },
      {
        sample: 'S:/samples/iteration-2-6bc5f66122',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/new_skill/run-2',
        plugin: 'P:/new',
      },
      {
        sample: 'S:/samples/iteration-2-2ace49ecac',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/old_skill/run-1',
        plugin: 'P:/old',
      },
      {
        sample: 'S:/samples/iteration-2-499d060b65',
        runDir: 'W:/iteration-2/eval-garden-seed-sonnet/old_skill/run-2',
        plugin: 'P:/old',
      },
    ],
  );
});

test('samples hide the configuration from the sample paths a judge sees, and give each run its own', () => {
  const input = {
    iterationDir: 'W:/iteration-2',
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new', old_skill: 'P:/old' },
    models: ['sonnet'],
    runs: 2,
  };
  const names = samples(input).map(({ sample }) => sample);

  assert.deepEqual(
    [
      names.filter((name) => /new_skill|old_skill|P:/.test(name)),
      new Set(names).size,
      names.every((name) => name.startsWith('S:/samples/iteration-2-')),
      samples(input).map(({ sample }) => sample),
    ],
    [[], 4, true, names],
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
    'S:/samples/iteration-2-39dc3c8c34',
    '--prompt-file',
    'E:/evals/prompts/garden.md',
    '--add-dir',
    'S:/samples/iteration-2-39dc3c8c34.garden',
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

test('resume continues the run session with the resume prompt and the case settings, into the next resume file', () => {
  const { iteration, plan } = iterationFor(gardenCase());
  const [run] = plan;
  const sample = run?.sample ?? '';
  const outputs = `${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`;
  mkdirSync(outputs, { recursive: true });
  writeFileSync(`${outputs}/result.json`, JSON.stringify({ stdout: '{"type":"system","session_id":"s1"}' }));
  const first = run === undefined ? null : resumeRun(gardenCase(), 'E:/evals', run);
  writeFileSync(`${outputs}/result-resume-1.json`, JSON.stringify({ stdout: '{"type":"result","session_id":"s2"}' }));
  const second = run === undefined ? null : resumeRun(gardenCase(), 'E:/evals', run);

  assert.deepEqual(
    [first, second?.args.slice(-2), second?.args.slice(2, 4)],
    [
      {
        args: [
          ...['--cwd', sample, '--prompt-file', 'E:/evals/prompts/resume.md', '--add-dir', `${sample}.garden`],
          ...['--out', `${outputs}/result-resume-1.json`, '--plugin-dir', 'P:/new', '--model', 'sonnet'],
          ...['--timeout-min', '14', '--allow', 'Edit Write', '--resume', 's1'],
        ],
      },
      ['--resume', 's2'],
      ['--prompt-file', 'E:/evals/prompts/resume.md'],
    ],
  );
  assert.equal(second?.args[7], `${outputs}/result-resume-2.json`);
});

test('findEvalCase reads the named case from evals.json, with no rules unless it names some, and refuses an unknown name', () => {
  const { rules, ...garden } = gardenCase();
  const evals = { plugin: 'tometo', evals: [garden, { ...garden, id: 1, name: 'tend', rules: 'rules' }] };

  assert.deepEqual(
    [findEvalCase(evals, 'garden-seed'), findEvalCase(evals, 'tend').rules, rules],
    [gardenCase(), 'rules', null],
  );
  assert.throws(() => findEvalCase(evals, 'prune'), /no eval case named prune/);
});

test('evalCases reads every case of evals.json in order', () => {
  const tend = { ...gardenCase(), id: 1, name: 'tend', after: 'garden-seed' };

  assert.deepEqual(evalCases({ evals: [gardenCase(), tend] }), [gardenCase(), tend]);
});

test('evalCases reads no case from a file with no evals list', () => {
  assert.deepEqual([evalCases({}), evalCases({ evals: 'garden-seed' })], [[], []]);
});

test('evalCases refuses evals.json when any case is malformed, naming its place', () => {
  assert.throws(
    () => evalCases({ evals: [gardenCase(), { ...gardenCase(), after: 3 }] }),
    /eval case 1 in evals.json is malformed/,
  );
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
    `these runs have results; start them over with rerun on the case their sample starts with: ${iteration}/eval-garden-seed-sonnet/new_skill/run-1`,
  );
});

test('runRefusal refuses a run that started and left no result, whose sample the session may have changed', () => {
  const { iteration, plan } = iterationFor(gardenCase());
  mkdirSync(`${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`, { recursive: true });

  assert.equal(
    runRefusal(plan, iteration, gardenCase()),
    `these runs started and left no result; start them over with rerun on the case their sample starts with: ${iteration}/eval-garden-seed-sonnet/new_skill/run-1`,
  );
});

test('runRefusal refuses a plan with no run left, saying how to add runs', () => {
  const { iteration } = iterationFor(gardenCase());

  assert.equal(
    runRefusal([], iteration, gardenCase()),
    `every run of garden-seed in ${iteration} has a result; resume or rerun a stopped one, or raise runs in iteration.json for more`,
  );
});

test('newRuns keeps the planned runs with no result, so raising the runs of an iteration keeps the runs done', () => {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-run-')).replaceAll('\\', '/');
  const plan = runPlan({
    evalCase: gardenCase(),
    iterationDir: iteration,
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new' },
    models: ['sonnet'],
    runs: 2,
  });
  const outputs = `${iteration}/eval-garden-seed-sonnet/new_skill/run-1/outputs`;
  mkdirSync(outputs, { recursive: true });
  writeFileSync(`${outputs}/result.json`, '{}');

  assert.deepEqual(
    newRuns(plan).map((run) => run.runDir),
    [`${iteration}/eval-garden-seed-sonnet/new_skill/run-2`],
  );
});

test('unscaffolded gives the samples that do not exist yet and keeps every sample that does', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-run-')).replaceAll('\\', '/');
  const [kept, fresh] = [sampleAt(`${root}/kept`), sampleAt(`${root}/fresh`)];
  sampleFolders(kept.sample).forEach((folder) => {
    mkdirSync(folder);
  });

  assert.deepEqual(unscaffolded([kept, fresh]), [fresh]);
});

test('unscaffolded refuses a sample of which only some folders exist, naming it', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-run-')).replaceAll('\\', '/');
  const partial = sampleAt(`${root}/partial`);
  mkdirSync(partial.sample);

  assert.throws(() => unscaffolded([partial]), {
    message: `samples are partly there; move them aside first: ${root}/partial`,
  });
});

test('setAside moves the paths that exist into the first free set-aside folder of the root, keeping their place', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-run-')).replaceAll('\\', '/');
  mkdirSync(`${root}/set-aside-1`);
  mkdirSync(`${root}/eval-seed-sonnet/new_skill/run-1/outputs`, { recursive: true });
  writeFileSync(`${root}/eval-seed-sonnet/new_skill/run-1/outputs/result.json`, '{}');

  setAside(root, [`${root}/eval-seed-sonnet/new_skill/run-1`, `${root}/eval-tend-sonnet/new_skill/run-1`]);

  assert.deepEqual(
    [
      existsSync(`${root}/eval-seed-sonnet/new_skill/run-1`),
      readFileSync(`${root}/set-aside-2/eval-seed-sonnet/new_skill/run-1/outputs/result.json`, 'utf8'),
      existsSync(`${root}/set-aside-2/eval-tend-sonnet`),
    ],
    [false, '{}', false],
  );
});

test('staleRuns gives a rerun its own run folder and those of every case that followed it on the same sample', () => {
  const [run] = runPlan({
    evalCase: gardenCase(),
    iterationDir: 'W:/iteration-2',
    samplesRoot: 'S:/samples',
    configs: { new_skill: 'P:/new' },
    models: ['sonnet'],
    runs: 1,
  });
  const cases = [
    { name: 'garden-seed', after: null },
    { name: 'tend', after: 'garden-seed' },
    { name: 'other-seed', after: null },
    { name: 'retend', after: 'tend' },
  ];

  assert.deepEqual(run === undefined ? [] : staleRuns(cases, 'W:/iteration-2', 'garden-seed', run), [
    'W:/iteration-2/eval-garden-seed-sonnet/new_skill/run-1',
    'W:/iteration-2/eval-tend-sonnet/new_skill/run-1',
    'W:/iteration-2/eval-retend-sonnet/new_skill/run-1',
  ]);
});

test('prepareRuns writes the eval metadata per model and leaves the outputs folder to the session', () => {
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
      false,
    ],
  );
});

// An origin with one commit on main, a patterns file and a git identity for the site, all in one temporary folder.
function scaffoldSetup(t: TestContext): { readonly origin: string; readonly head: string; readonly root: string } {
  const origin = repo(t);
  const head = commit(origin, { 'a.ts': 'export const a = 1;\n' });
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

  return { origin, head, root };
}

function sampleAt(path: string): Sample {
  return {
    config: 'new_skill',
    model: 'sonnet',
    run: 1,
    plugin: fileURLToPath(new URL('../../plugins/tometo', import.meta.url)),
    sample: path,
  };
}

test('scaffold clones main alone into a bare origin and a sample, opens its garden site and gives it the patterns', (t) => {
  const { origin, head, root } = scaffoldSetup(t);
  git(origin, ['branch', 'other']);

  scaffold(sampleAt(`${root}/sample`), origin, join(root, 'patterns.json'));

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

test('scaffold makes the samples folder of a first run, which does not exist yet', (t) => {
  const { origin, head, root } = scaffoldSetup(t);

  scaffold(sampleAt(`${root}/samples/sample`), origin, join(root, 'patterns.json'));

  assert.equal(git(`${root}/samples/sample`, ['rev-parse', 'HEAD']), head);
});
