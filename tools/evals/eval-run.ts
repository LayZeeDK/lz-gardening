// Runs one eval case of an iteration: each configuration and model on its own sample, through the slim `claude -p`
// runner. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/eval-run.ts scaffold <iteration dir>              a fresh sample and garden site per run
//   node tools/evals/eval-run.ts run <iteration dir> <eval name> [--concurrency 4] [--evals <dir>]
//
// <iteration dir>/iteration.json names the configs ({name: {plugin}}), the models and the runs per configuration.
// Environment: LZ_EVAL_SAMPLES_ROOT (where samples go), LZ_EVAL_SAMPLE_ORIGIN (the bare origin to clone, scaffold),
// LZ_EVAL_RUN_SLIM (run-slim.ts, run); with LZ_EVAL_HEAVY_LOCK (heavy-lock.ts) and LZ_EVAL_LOCK_OWNER, run waits for
// and holds the machine's heavy-run lock.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

export interface Assertion {
  readonly text: string;
  readonly check?: string;
}

export interface EvalCase {
  readonly id: number;
  readonly name: string;
  readonly prompt: string;
  readonly after: string | null;
  readonly timeoutMinutes: number;
  readonly allow: string;
  readonly rules: string | null;
  readonly assertions: readonly Assertion[];
}

export interface PlanInput {
  readonly evalCase: EvalCase;
  readonly evalsDir: string;
  readonly iterationDir: string;
  readonly samplesRoot: string;
  readonly configs: Readonly<Record<string, string>>;
  readonly models: readonly string[];
  readonly runs: number;
}

export interface PlannedRun {
  readonly config: string;
  readonly model: string;
  readonly run: number;
  readonly plugin: string;
  readonly sample: string;
  readonly runDir: string;
}

function isAssertion(value: unknown): value is Assertion {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    (value['check'] === undefined || typeof value['check'] === 'string')
  );
}

function evalCase(value: unknown): EvalCase | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, name, prompt, after = null, timeoutMinutes, allow, rules = null, assertions } = value;

  if (
    typeof id !== 'number' ||
    typeof name !== 'string' ||
    typeof prompt !== 'string' ||
    (after !== null && typeof after !== 'string') ||
    typeof timeoutMinutes !== 'number' ||
    typeof allow !== 'string' ||
    (rules !== null && typeof rules !== 'string') ||
    !Array.isArray(assertions) ||
    !assertions.every(isAssertion)
  ) {
    return null;
  }

  return { id, name, prompt, after, timeoutMinutes, allow, rules, assertions };
}

export function findEvalCase(evals: unknown, name: string): EvalCase {
  const cases: unknown[] = isRecord(evals) && Array.isArray(evals['evals']) ? evals['evals'] : [];
  const named = cases.find((candidate) => isRecord(candidate) && candidate['name'] === name);

  if (named === undefined) {
    throw new Error(`no eval case named ${name} in evals.json`);
  }

  const parsed = evalCase(named);

  if (parsed === null) {
    throw new Error(`eval case ${name} in evals.json is malformed`);
  }

  return parsed;
}

function runOrThrow(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

export function scaffold(run: PlannedRun, origin: string, patterns: string): void {
  const bare = `${run.sample}-origin.git`;
  runOrThrow('git', ['clone', '-q', '--bare', '--single-branch', '--branch', 'main', origin, bare], dirname(bare));
  runOrThrow('git', ['clone', '-q', bare, run.sample], dirname(run.sample));
  runOrThrow(process.execPath, [`${run.plugin}/skills/lz-garden/scripts/site.ts`, 'open'], run.sample);
  mkdirSync(`${run.sample}.garden/.garden`, { recursive: true });
  copyFileSync(patterns, `${run.sample}.garden/.garden/patterns.json`);
}

export function slimArgs(evalCase: EvalCase, evalsDir: string, run: PlannedRun): string[] {
  return [
    ...['--cwd', run.sample, '--prompt-file', `${evalsDir}/${evalCase.prompt}`, '--add-dir', `${run.sample}.garden`],
    ...['--out', `${run.runDir}/outputs/result.json`, '--plugin-dir', run.plugin, '--model', run.model],
    ...['--timeout-min', String(evalCase.timeoutMinutes), '--allow', evalCase.allow],
    ...(evalCase.rules === null ? [] : ['--rules', `${evalsDir}/${evalCase.rules}`]),
  ];
}

export function runPlan(input: PlanInput): PlannedRun[] {
  const label = basename(input.iterationDir);
  const runs = Array.from({ length: input.runs }, (_, index) => index + 1);

  return Object.entries(input.configs).flatMap(([config, plugin]) =>
    input.models.flatMap((model) =>
      runs.map((run) => ({
        config,
        model,
        run,
        plugin,
        sample: `${input.samplesRoot}/${label}-${config}-${model}-${String(run)}`,
        runDir: `${input.iterationDir}/eval-${input.evalCase.name}-${model}/${config}/run-${String(run)}`,
      })),
    ),
  );
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`set ${name}`);
  }

  return value;
}

interface Iteration {
  readonly configs: Readonly<Record<string, string>>;
  readonly models: readonly string[];
  readonly runs: number;
}

function readIteration(iterationDir: string): Iteration {
  const file = `${iterationDir}/iteration.json`;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const configs = isRecord(parsed) && isRecord(parsed['configs']) ? Object.entries(parsed['configs']) : [];
  const plugins = configs.flatMap(([name, config]) =>
    isRecord(config) && typeof config['plugin'] === 'string' ? [[name, config['plugin']] as const] : [],
  );
  const models = isRecord(parsed) && Array.isArray(parsed['models']) ? parsed['models'] : [];
  const runs = isRecord(parsed) ? parsed['runs'] : undefined;

  if (
    plugins.length === 0 ||
    plugins.length !== configs.length ||
    models.length === 0 ||
    !models.every((model) => typeof model === 'string') ||
    typeof runs !== 'number'
  ) {
    throw new Error(`${file} needs configs (name -> {plugin}), models and runs`);
  }

  const absolute = plugins.map(([name, plugin]) => [name, resolve(plugin).replaceAll('\\', '/')] as const);

  return { configs: Object.fromEntries(absolute), models, runs };
}

function heavyLock(args: readonly string[]): number {
  return spawnSync(process.execPath, [required('LZ_EVAL_HEAVY_LOCK'), ...args], { stdio: 'inherit' }).status ?? 1;
}

async function withHeavyLock<T>(task: string, minutes: number, work: () => Promise<T>): Promise<T> {
  if (process.env['LZ_EVAL_HEAVY_LOCK'] === undefined) {
    return work();
  }

  const owner = required('LZ_EVAL_LOCK_OWNER');
  const slot = ['--owner', owner, '--task', task, '--minutes', String(minutes)];
  heavyLock(['wait', ...slot]);

  for (let code = heavyLock(['acquire', ...slot, '--pid', String(process.pid)]); code !== 0;) {
    if (code === 4) {
      heavyLock(['wait', ...slot]);
    } else if (code !== 2) {
      throw new Error(`heavy-lock acquire exited ${String(code)}`);
    }

    await new Promise((done) => setTimeout(done, 30_000));
    code = heavyLock(['acquire', ...slot, '--pid', String(process.pid)]);
  }

  try {
    return await work();
  } finally {
    heavyLock(['release', '--owner', owner]);
  }
}

function slimRun(runSlim: string, args: readonly string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [runSlim, ...args], { stdio: 'inherit' });
    child.on('close', (status) => {
      done(status ?? 1);
    });
  });
}

// Starts the runs, `concurrency` at a time, and gives back the run folders whose session exited with a failure.
async function runAll(
  runs: readonly PlannedRun[],
  concurrency: number,
  start: (run: PlannedRun) => Promise<number>,
): Promise<string[]> {
  const queue = [...runs];
  const failed: string[] = [];
  const worker = async (): Promise<void> => {
    for (let run = queue.shift(); run !== undefined; run = queue.shift()) {
      const status = await start(run);
      console.log(`${run.runDir} exit ${String(status)}`);

      if (status !== 0) {
        failed.push(run.runDir);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, runs.length) }, worker));

  return failed;
}

if (isMainModule(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      evals: { type: 'string', default: '.claude/evals/lz-gardening' },
      concurrency: { type: 'string', default: '4' },
    },
  });
  const [command, iterationDir, evalName] = positionals;
  const evalsDir = resolve(values.evals).replaceAll('\\', '/');

  if (iterationDir === undefined || (command === 'run' ? evalName === undefined : command !== 'scaffold')) {
    throw new Error('usage: eval-run.ts scaffold <iteration dir> | run <iteration dir> <eval name> [--concurrency n]');
  }

  const iteration = resolve(iterationDir).replaceAll('\\', '/');
  const evals: unknown = JSON.parse(readFileSync(`${evalsDir}/evals.json`, 'utf8'));
  const cases: unknown[] = isRecord(evals) && Array.isArray(evals['evals']) ? evals['evals'] : [];
  const [first] = cases;
  const evalCase = findEvalCase(evals, evalName ?? (isRecord(first) ? String(first['name']) : ''));
  const plan = runPlan({
    evalCase,
    evalsDir,
    iterationDir: iteration,
    samplesRoot: required('LZ_EVAL_SAMPLES_ROOT').replaceAll('\\', '/'),
    ...readIteration(iteration),
  });

  if (command === 'scaffold') {
    const origin = required('LZ_EVAL_SAMPLE_ORIGIN');
    const refused = plan.filter((run) => existsSync(run.sample) || existsSync(`${run.sample}.garden`));

    if (refused.length > 0) {
      throw new Error(`samples exist; move them aside first: ${refused.map((run) => run.sample).join(', ')}`);
    }

    plan.forEach((run) => {
      scaffold(run, origin, `${evalsDir}/site-patterns.json`);
      console.log(`scaffolded ${run.sample}`);
    });
  } else {
    const runSlim = required('LZ_EVAL_RUN_SLIM');
    const concurrency = Number(values.concurrency);

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`--concurrency must be a whole number of at least 1, not ${values.concurrency}`);
    }

    const { after } = evalCase;
    const unseeded = plan.filter(
      (run) =>
        after !== null &&
        !existsSync(`${iteration}/eval-${after}-${run.model}/${run.config}/run-${String(run.run)}/outputs/result.json`),
    );

    if (unseeded.length > 0) {
      throw new Error(`run ${String(after)} first: ${unseeded.map((run) => run.runDir).join(', ')}`);
    }

    const done = plan.filter((run) => existsSync(`${run.runDir}/outputs/result.json`));

    if (done.length > 0) {
      throw new Error(`move these runs aside first: ${done.map((run) => run.runDir).join(', ')}`);
    }

    const evalFolders = new Set(plan.map((run) => dirname(dirname(run.runDir))));
    evalFolders.forEach((folder) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        `${folder}/eval_metadata.json`,
        `${JSON.stringify(
          {
            eval_id: evalCase.id,
            eval_name: evalCase.name,
            prompt: readFileSync(`${evalsDir}/${evalCase.prompt}`, 'utf8'),
            assertions: evalCase.assertions,
          },
          null,
          2,
        )}\n`,
      );
    });
    plan.forEach((run) => {
      mkdirSync(`${run.runDir}/outputs`, { recursive: true });
    });
    const waves = Math.ceil(plan.length / concurrency);
    const failed = await withHeavyLock(
      `lz-gardening eval ${evalCase.name} ${basename(iteration)}: ${String(plan.length)} slim claude -p runs, ${String(concurrency)} at a time`,
      waves * (evalCase.timeoutMinutes + 2),
      () => runAll(plan, concurrency, (run) => slimRun(runSlim, slimArgs(evalCase, evalsDir, run))),
    );

    if (failed.length > 0) {
      console.error(`failed runs: ${failed.join(', ')}`);
      process.exitCode = 1;
    }
  }
}
