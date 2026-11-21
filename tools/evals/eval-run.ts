// Runs one eval case of an iteration: each configuration and model on its own sample, through the slim `claude -p`
// runner. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/eval-run.ts scaffold <iteration dir>              a fresh sample and garden site per run
//   node tools/evals/eval-run.ts run <iteration dir> <eval name> [--concurrency 4] [--evals <dir>]
//   node tools/evals/eval-run.ts resume <iteration dir> <eval name> <run dir>... [--concurrency 4] [--evals <dir>]
//
// <iteration dir>/iteration.json names the configs ({name: {plugin}}), the models and the runs per configuration.
// Environment: LZ_EVAL_SAMPLES_ROOT (where samples go, every command), LZ_EVAL_SAMPLE_ORIGIN (the bare origin to
// clone, scaffold), LZ_EVAL_RUN_SLIM (run-slim.ts, run and resume); with LZ_EVAL_HEAVY_LOCK (heavy-lock.ts) and
// LZ_EVAL_LOCK_OWNER, run and resume wait for and hold the machine's heavy-run lock.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import {
  evalFolder,
  isAssertion,
  readIteration,
  readJson,
  runFolder,
  type Assertion,
  type Iteration,
} from './eval-layout.ts';
import { slimOutput } from './slim-output.ts';

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

export interface SampleInput extends Iteration {
  readonly iterationDir: string;
  readonly samplesRoot: string;
}

export interface Sample {
  readonly config: string;
  readonly model: string;
  readonly run: number;
  readonly plugin: string;
  readonly sample: string;
}

export interface PlannedRun extends Sample {
  readonly runDir: string;
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

// A sample's name must not tell a judge its configuration: the sessions' calls and reports are full of its path.
function opaque(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 10);
}

// One sample per configuration, model and run; every case of the iteration runs on the same samples, in order.
export function samples(input: SampleInput): Sample[] {
  const label = basename(input.iterationDir);
  const runs = Array.from({ length: input.runs }, (_, index) => index + 1);

  return Object.entries(input.configs).flatMap(([config, plugin]) =>
    input.models.flatMap((model) =>
      runs.map((run) => ({
        config,
        model,
        run,
        plugin,
        sample: `${input.samplesRoot}/${label}-${opaque(input.iterationDir, config, plugin, model, run)}`,
      })),
    ),
  );
}

export function runPlan(input: SampleInput & { readonly evalCase: EvalCase }): PlannedRun[] {
  return samples(input).map((sample) => ({
    ...sample,
    runDir: runFolder(input.iterationDir, input.evalCase.name, sample.model, sample.config, sample.run),
  }));
}

function runOrThrow(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

export function scaffold(sample: Sample, origin: string, patterns: string): void {
  const bare = `${sample.sample}-origin.git`;
  runOrThrow('git', ['clone', '-q', '--bare', '--single-branch', '--branch', 'main', origin, bare], dirname(bare));
  runOrThrow('git', ['clone', '-q', bare, sample.sample], dirname(sample.sample));
  runOrThrow(process.execPath, [`${sample.plugin}/skills/lz-garden/scripts/site.ts`, 'open'], sample.sample);
  mkdirSync(`${sample.sample}.garden/.garden`, { recursive: true });
  copyFileSync(patterns, `${sample.sample}.garden/.garden/patterns.json`);
}

export function slimArgs(evalCase: EvalCase, evalsDir: string, run: PlannedRun): string[] {
  return [
    ...['--cwd', run.sample, '--prompt-file', `${evalsDir}/${evalCase.prompt}`, '--add-dir', `${run.sample}.garden`],
    ...['--out', `${run.runDir}/outputs/result.json`, '--plugin-dir', run.plugin, '--model', run.model],
    ...['--timeout-min', String(evalCase.timeoutMinutes), '--allow', evalCase.allow],
    ...(evalCase.rules === null ? [] : ['--rules', `${evalsDir}/${evalCase.rules}`]),
  ];
}

// A stopped run goes on in its own session, from its latest output file, into result-resume-<n>.json beside it.
export function resumeRun(evalCase: EvalCase, evalsDir: string, run: PlannedRun): { readonly args: string[] } {
  const outputs = `${run.runDir}/outputs`;
  const resumes = existsSync(outputs)
    ? readdirSync(outputs).flatMap((name) => /^result-resume-(\d+)\.json$/.exec(name)?.[1] ?? [])
    : [];
  const last = Math.max(0, ...resumes.map(Number));
  const latest = `${outputs}/${last === 0 ? 'result.json' : `result-resume-${String(last)}.json`}`;
  const { session } = existsSync(latest) ? slimOutput(readJson(latest)) : { session: null };

  if (session === null) {
    throw new Error(`${latest} names no session to resume`);
  }

  const args = slimArgs({ ...evalCase, prompt: 'prompts/resume.md' }, evalsDir, run);
  args[args.indexOf('--out') + 1] = `${outputs}/result-resume-${String(last + 1)}.json`;

  return { args: [...args, '--resume', session] };
}

// Why the planned runs cannot start: the case they follow has not run on the same samples, or they already ran.
export function runRefusal(plan: readonly PlannedRun[], iterationDir: string, evalCase: EvalCase): string | null {
  const { after } = evalCase;
  const unseeded = plan.filter(
    (run) =>
      after !== null &&
      !existsSync(`${runFolder(iterationDir, after, run.model, run.config, run.run)}/outputs/result.json`),
  );

  if (unseeded.length > 0) {
    return `run ${String(after)} first: ${unseeded.map((run) => run.runDir).join(', ')}`;
  }

  const done = plan.filter((run) => existsSync(`${run.runDir}/outputs/result.json`));

  return done.length > 0 ? `move these runs aside first: ${done.map((run) => run.runDir).join(', ')}` : null;
}

// Each model's eval folder gets eval_metadata.json, and each run its outputs folder.
export function prepareRuns(
  plan: readonly PlannedRun[],
  iterationDir: string,
  evalCase: EvalCase,
  prompt: string,
): void {
  new Set(plan.map((run) => run.model)).forEach((model) => {
    const folder = evalFolder(iterationDir, evalCase.name, model);
    const metadata = { eval_id: evalCase.id, eval_name: evalCase.name, prompt, assertions: evalCase.assertions };
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${folder}/eval_metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  });
  plan.forEach((run) => {
    mkdirSync(`${run.runDir}/outputs`, { recursive: true });
  });
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`set ${name}`);
  }

  return value;
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
  const [command, iterationDir, evalName, ...runDirs] = positionals;
  const usage =
    'usage: eval-run.ts scaffold <iteration dir> | run <iteration dir> <eval name> | resume <iteration dir> <eval name> <run dir>... [--concurrency n]';

  if (
    iterationDir === undefined ||
    (command === 'scaffold' && evalName !== undefined) ||
    (command === 'run' && (evalName === undefined || runDirs.length > 0)) ||
    (command === 'resume' && runDirs.length === 0) ||
    !['scaffold', 'run', 'resume'].includes(command ?? '')
  ) {
    throw new Error(usage);
  }

  const evalsDir = resolve(values.evals).replaceAll('\\', '/');
  const iteration = resolve(iterationDir).replaceAll('\\', '/');
  const input = {
    iterationDir: iteration,
    samplesRoot: required('LZ_EVAL_SAMPLES_ROOT').replaceAll('\\', '/'),
    ...readIteration(iteration),
  };

  if (evalName === undefined) {
    const origin = required('LZ_EVAL_SAMPLE_ORIGIN');
    const all = samples(input);
    const refused = all.filter(({ sample }) => existsSync(sample) || existsSync(`${sample}.garden`));

    if (refused.length > 0) {
      throw new Error(`samples exist; move them aside first: ${refused.map(({ sample }) => sample).join(', ')}`);
    }

    all.forEach((sample) => {
      scaffold(sample, origin, `${evalsDir}/site-patterns.json`);
      console.log(`scaffolded ${sample.sample}`);
    });
  } else {
    const runSlim = required('LZ_EVAL_RUN_SLIM');
    const concurrency = Number(values.concurrency);

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`--concurrency must be a whole number of at least 1, not ${values.concurrency}`);
    }

    const evalCase = findEvalCase(readJson(`${evalsDir}/evals.json`), evalName);
    const planned = runPlan({ ...input, evalCase });
    const wanted = runDirs.map((runDir) => resolve(runDir).replaceAll('\\', '/'));
    const plan = command === 'resume' ? planned.filter(({ runDir }) => wanted.includes(runDir)) : planned;
    const unknown = wanted.filter((runDir) => !plan.some((run) => run.runDir === runDir));

    if (unknown.length > 0) {
      throw new Error(`not run folders of ${evalCase.name} in ${iteration}: ${unknown.join(', ')}`);
    }

    if (command === 'run') {
      const refusal = runRefusal(plan, iteration, evalCase);

      if (refusal !== null) {
        throw new Error(refusal);
      }

      prepareRuns(plan, iteration, evalCase, readFileSync(`${evalsDir}/${evalCase.prompt}`, 'utf8'));
    }

    const argsOf = (run: PlannedRun): string[] =>
      command === 'resume' ? resumeRun(evalCase, evalsDir, run).args : slimArgs(evalCase, evalsDir, run);
    // A run with no session to resume refuses here, before the lock is taken.
    plan.forEach(argsOf);
    const waves = Math.ceil(plan.length / concurrency);
    const failed = await withHeavyLock(
      `lz-gardening eval ${String(command)} ${evalCase.name} ${basename(iteration)}: ${String(plan.length)} slim claude -p runs, ${String(concurrency)} at a time`,
      waves * (evalCase.timeoutMinutes + 2),
      () => runAll(plan, concurrency, (run) => slimRun(runSlim, argsOf(run))),
    );

    if (failed.length > 0) {
      console.error(`failed runs: ${failed.join(', ')}`);
      process.exitCode = 1;
    }
  }
}
