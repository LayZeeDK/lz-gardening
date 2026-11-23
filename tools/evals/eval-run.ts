// Runs one eval case of an iteration: each configuration and model on its own sample, through the slim `claude -p`
// runner. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/eval-run.ts scaffold <iteration dir>              a fresh sample and garden site per new run
//   node tools/evals/eval-run.ts run <iteration dir> <eval name> [--concurrency 4] [--evals <dir>]
//   node tools/evals/eval-run.ts resume <iteration dir> <eval name> <run dir>... [--concurrency 4] [--evals <dir>]
//   node tools/evals/eval-run.ts rerun <iteration dir> <eval name> <run dir>... [--concurrency 4] [--evals <dir>]
//
// rerun starts the named runs over and keeps every other run; what it replaces goes to set-aside-<n> folders.
// <iteration dir>/iteration.json names the configs ({name: {plugin}}), the models and the runs per configuration.
// Environment: LZ_EVAL_SAMPLES_ROOT (where samples go, every command), LZ_EVAL_SAMPLE_ORIGIN (the bare origin to
// clone: scaffold, and rerun of a case that starts a sample), LZ_EVAL_RUN_SLIM (run-slim.ts: run, resume and rerun);
// with LZ_EVAL_HEAVY_LOCK (heavy-lock.ts) and LZ_EVAL_LOCK_OWNER, run, resume and rerun wait for and hold the
// machine's heavy-run lock.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
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
import { limitStopped, slimOutput } from './slim-output.ts';

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

function caseEntries(evals: unknown): unknown[] {
  return isRecord(evals) && Array.isArray(evals['evals']) ? evals['evals'] : [];
}

export function findEvalCase(evals: unknown, name: string): EvalCase {
  const named = caseEntries(evals).find((candidate) => isRecord(candidate) && candidate['name'] === name);

  if (named === undefined) {
    throw new Error(`no eval case named ${name} in evals.json`);
  }

  const parsed = evalCase(named);

  if (parsed === null) {
    throw new Error(`eval case ${name} in evals.json is malformed`);
  }

  return parsed;
}

export function evalCases(evals: unknown): EvalCase[] {
  return caseEntries(evals).map((candidate, index) => {
    const parsed = evalCase(candidate);

    if (parsed === null) {
      throw new Error(`eval case ${String(index)} in evals.json is malformed`);
    }

    return parsed;
  });
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

// A sample is its clone, its garden site and the bare origin it was cloned from.
export function sampleFolders(sample: string): readonly [clone: string, site: string, origin: string] {
  return [sample, `${sample}.garden`, `${sample}-origin.git`];
}

// A sample whose folders all exist is kept, so raising an iteration's runs scaffolds only the new runs' samples.
export function unscaffolded(all: readonly Sample[]): Sample[] {
  const found = all.map((sample) => ({
    sample,
    exists: sampleFolders(sample.sample).map((folder) => existsSync(folder)),
  }));
  const partial = found.filter(({ exists }) => exists.some(Boolean) && !exists.every(Boolean));

  if (partial.length > 0) {
    throw new Error(
      `samples are partly there; move them aside first: ${partial.map(({ sample }) => sample.sample).join(', ')}`,
    );
  }

  return found.filter(({ exists }) => !exists.some(Boolean)).map(({ sample }) => sample);
}

export function scaffold(sample: Sample, origin: string, patterns: string): void {
  const [clone, site, bare] = sampleFolders(sample.sample);
  mkdirSync(dirname(bare), { recursive: true });
  runOrThrow('git', ['clone', '-q', '--bare', '--single-branch', '--branch', 'main', origin, bare], dirname(bare));
  runOrThrow('git', ['clone', '-q', bare, clone], dirname(clone));
  runOrThrow(process.execPath, [`${sample.plugin}/skills/lz-garden/scripts/site.ts`, 'open'], clone);
  mkdirSync(`${site}/.garden`, { recursive: true });
  copyFileSync(patterns, `${site}/.garden/patterns.json`);
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

// A run with a result is done; `run` starts the others, so raising an iteration's runs keeps the runs done.
export function newRuns(plan: readonly PlannedRun[]): PlannedRun[] {
  return plan.filter((run) => !existsSync(`${run.runDir}/outputs/result.json`));
}

// Why the planned runs cannot start: none is left, the case they follow has not run on the same samples, or they
// already ran or started.
export function runRefusal(plan: readonly PlannedRun[], iterationDir: string, evalCase: EvalCase): string | null {
  const { after } = evalCase;

  if (plan.length === 0) {
    return `every run of ${evalCase.name} in ${iterationDir} has a result; resume or rerun a stopped one, or raise runs in iteration.json for more`;
  }

  const unseeded = plan.filter(
    (run) =>
      after !== null &&
      !existsSync(`${runFolder(iterationDir, after, run.model, run.config, run.run)}/outputs/result.json`),
  );

  if (unseeded.length > 0) {
    return `run ${String(after)} first: ${unseeded.map((run) => run.runDir).join(', ')}`;
  }

  const done = plan.filter((run) => existsSync(`${run.runDir}/outputs/result.json`));

  if (done.length > 0) {
    return `these runs have results; start them over with rerun on the case their sample starts with: ${done.map((run) => run.runDir).join(', ')}`;
  }

  // slimRun makes the outputs folder as a session starts, so one without a result is a run that died on its sample.
  const started = plan.filter((run) => existsSync(`${run.runDir}/outputs`));

  return started.length > 0
    ? `these runs started and left no result; start them over with rerun on the case their sample starts with: ${started.map((run) => run.runDir).join(', ')}`
    : null;
}

export function staleRuns(
  cases: readonly Pick<EvalCase, 'name' | 'after'>[],
  iterationDir: string,
  name: string,
  run: Pick<Sample, 'model' | 'config' | 'run'>,
): string[] {
  const names = [name];

  for (let index = 0; index < names.length; index += 1) {
    names.push(...cases.filter(({ after }) => after === names[index]).map((follower) => follower.name));
  }

  return names.map((stale) => runFolder(iterationDir, stale, run.model, run.config, run.run));
}

// Moves what a rerun replaces out of the globs the grading scripts read, keeping it for a look later.
export function setAside(root: string, paths: readonly string[]): void {
  let number = 1;

  while (existsSync(`${root}/set-aside-${String(number)}`)) {
    number += 1;
  }

  paths
    .filter((path) => existsSync(path))
    .forEach((path) => {
      const aside = `${root}/set-aside-${String(number)}/${relative(root, path)}`;
      mkdirSync(dirname(aside), { recursive: true });
      renameSync(path, aside);
    });
}

// Each model's eval folder gets eval_metadata.json; a run's outputs folder waits for its session (slimRun).
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
}

// Stryker disable all: the heavy lock, the spawned sessions and the command line below start real processes, which
// no unit test does
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

// A session the usage limit ended still exits 0, so its output file decides: such a run counts as failed.
function slimRun(runSlim: string, args: readonly string[]): Promise<number> {
  const out = args[args.indexOf('--out') + 1] ?? '';
  mkdirSync(dirname(out), { recursive: true });

  return new Promise((done) => {
    const child = spawn(process.execPath, [runSlim, ...args], { stdio: 'inherit' });
    child.on('close', (status) => {
      if (status === 0 && existsSync(out) && limitStopped(slimOutput(readJson(out)))) {
        console.error(`${out}: the usage limit ended the session; start the run again once the limit resets`);
        done(1);
      } else {
        done(status ?? 1);
      }
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
    'usage: eval-run.ts scaffold <iteration dir> | run <iteration dir> <eval name> | resume|rerun <iteration dir> <eval name> <run dir>... [--concurrency n]';

  if (
    iterationDir === undefined ||
    (command === 'scaffold' && evalName !== undefined) ||
    (command === 'run' && (evalName === undefined || runDirs.length > 0)) ||
    ((command === 'resume' || command === 'rerun') && runDirs.length === 0) ||
    !['scaffold', 'run', 'resume', 'rerun'].includes(command ?? '')
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
    unscaffolded(samples(input)).forEach((sample) => {
      scaffold(sample, origin, `${evalsDir}/site-patterns.json`);
      console.log(`scaffolded ${sample.sample}`);
    });
  } else {
    const runSlim = required('LZ_EVAL_RUN_SLIM');
    const concurrency = Number(values.concurrency);

    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`--concurrency must be a whole number of at least 1, not ${values.concurrency}`);
    }

    const evals = readJson(`${evalsDir}/evals.json`);
    const evalCase = findEvalCase(evals, evalName);
    const planned = runPlan({ ...input, evalCase });
    const wanted = runDirs.map((runDir) => resolve(runDir).replaceAll('\\', '/'));
    const plan = command === 'run' ? newRuns(planned) : planned.filter(({ runDir }) => wanted.includes(runDir));
    const unknown = wanted.filter((runDir) => !plan.some((run) => run.runDir === runDir));

    if (unknown.length > 0) {
      throw new Error(`not run folders of ${evalCase.name} in ${iteration}: ${unknown.join(', ')}`);
    }

    // A rerun of a case that starts a sample sets the run aside with every later case's run on that sample, and
    // starts from a fresh sample; a rerun of a later case runs the named runs its sample's first rerun set aside.
    if (command === 'rerun' && evalCase.after === null) {
      const origin = required('LZ_EVAL_SAMPLE_ORIGIN');
      const cases = evalCases(evals);
      setAside(
        iteration,
        plan.flatMap((run) => staleRuns(cases, iteration, evalCase.name, run)),
      );
      setAside(
        input.samplesRoot,
        plan.flatMap((run) => sampleFolders(run.sample)),
      );
      plan.forEach((run) => {
        scaffold(run, origin, `${evalsDir}/site-patterns.json`);
      });
    }

    if (command !== 'resume') {
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
