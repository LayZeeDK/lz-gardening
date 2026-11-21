// Optimizes one skill's description for triggering: skill-creator's run_loop.py method, measured with
// `claude plugin eval` on a copy of the plugin per iteration. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/trigger-optimize.ts --plugin <dir> --skill <name> --eval-set <json> --workspace <dir>
//     [--model sonnet] [--improve-model opus] [--runs 3] [--max-iterations 5] [--holdout 0.4] [--threshold 0.5]
//     [--concurrency 4] [--seed 42] [--resume]
//
// --resume goes on with a stopped run in the same workspace, with the same options, eval set and SKILL.md: it keeps
// each finished iteration's results and description, and runs the first unfinished iteration again.
//
// Environment: LZ_EVAL_RUN_SLIM, the slim `claude -p` runner (run-slim.ts) that writes each improved description;
// LZ_EVAL_CLAUDE, the claude executable when `claude` on PATH is a shell shim Node.js cannot start (default: claude).
// Writes into a new or empty <workspace>: options.json (with the eval set's and SKILL.md's SHA-256), iteration-N/ (the
// plugin copy, its cases, plugin-eval.json, and `finished` once its evaluation exited 0 with results), improve-<ms>/
// (each improve call's prompt and output) and results.json. The plugin's own SKILL.md is never changed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { limitStopped, slimOutput } from './slim-output.ts';
import {
  caseNames,
  skillParts,
  splitEvalSet,
  withDescription,
  writeCases,
  type EvalQuery,
  type Split,
} from './trigger-cases.ts';
import { optimize, type Recorded } from './trigger-loop.ts';
import { queryResults } from './trigger-results.ts';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isQuery(value: unknown): value is EvalQuery {
  return isRecord(value) && typeof value['query'] === 'string' && typeof value['should_trigger'] === 'boolean';
}

function required(env: string): string {
  const value = process.env[env];

  if (value === undefined || value === '') {
    throw new Error(`${env} is not set; see the header of trigger-optimize.ts`);
  }

  return value;
}

function wholeNumber(name: string, raw: string, least: number): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < least) {
    throw new Error(`--${name} must be a whole number of at least ${String(least)}, not ${raw}`);
  }

  return value;
}

function share(name: string, raw: string, upTo: 'below 1' | '1'): number {
  const value = Number(raw);

  if (raw.trim() === '' || !(value >= 0 && (upTo === '1' ? value <= 1 : value < 1))) {
    throw new Error(`--${name} must be a number from 0 to ${upTo}, not ${raw}`);
  }

  return value;
}

function ran(command: string, args: readonly string[], what: string): number {
  const child = spawnSync(command, args, { stdio: 'inherit' });

  if (child.error !== undefined) {
    throw new Error(`${what} could not start ${command}: ${child.error.message}`);
  }

  return child.status ?? 1;
}

// The plugin without node_modules (a trigger run starts no script) and without an evals folder of its own.
// The copy is made under another name and renamed once it holds the description, so a stop in between never leaves a
// copy with the original description for a resume to read as this iteration's.
export function copyPlugin(plugin: string, destination: string, skill: string, description: string): void {
  const partial = `${destination}.partial`;
  rmSync(partial, { recursive: true, force: true });
  cpSync(plugin, partial, {
    recursive: true,
    filter: (source) =>
      !relative(plugin, source)
        .split(sep)
        .some((part) => part === 'node_modules' || part === 'evals'),
  });

  const skillFile = join(partial, 'skills', skill, 'SKILL.md');
  writeFileSync(skillFile, withDescription(readFileSync(skillFile, 'utf8'), description));
  renameSync(partial, destination);
}

export interface Resumed {
  readonly recorded: readonly Recorded[];
  readonly aside: string | null;
}

export interface IterationPaths {
  readonly folder: string;
  readonly copy: string;
  readonly skillFile: string;
  readonly json: string;
  // Written once the iteration's evaluation exited 0 with its results, which a resume then keeps.
  readonly finished: string;
}

export function iterationPaths(workspace: string, skill: string, iteration: number): IterationPaths {
  const folder = resolve(workspace, `iteration-${String(iteration)}`);
  const copy = join(folder, 'plugin');

  return {
    folder,
    copy,
    skillFile: join(copy, 'skills', skill, 'SKILL.md'),
    json: join(folder, 'plugin-eval.json'),
    finished: join(folder, 'finished'),
  };
}

// Each finished iteration keeps its results; the first unfinished one keeps only its description and moves aside to
// iteration-<n>-stopped-<stamp>, so its evaluation runs again.
export function recordedIterations(
  workspace: string,
  skill: string,
  split: Split,
  threshold: number,
  stamp: number,
): Resumed {
  const names = caseNames(split);
  const queries = [...split.train, ...split.test];
  const recorded: Recorded[] = [];

  for (let iteration = 1; ; iteration += 1) {
    const paths = iterationPaths(workspace, skill, iteration);

    if (!existsSync(paths.skillFile)) {
      return { recorded, aside: null };
    }

    const description = skillParts(readFileSync(paths.skillFile, 'utf8')).description;

    if (!existsSync(paths.finished)) {
      const aside = `${paths.folder}-stopped-${String(stamp)}`;
      renameSync(paths.folder, aside);

      return { recorded: [...recorded, { description }], aside };
    }

    recorded.push({ description, all: queryResults(readJson(paths.json), names, queries, threshold) });
  }
}

// The description an improve call wrote. A usage limit ends the call with status 0 and its limit text as the result,
// which would otherwise be evaluated as the next description.
export function improvedText(status: number, out: string): string {
  const output = existsSync(out) ? slimOutput(readJson(out)) : null;
  const text = output?.result['result'];

  if (output !== null && limitStopped(output)) {
    throw new Error(`the improve call hit a usage limit; see ${out}`);
  }

  if (status !== 0 || typeof text !== 'string') {
    throw new Error(`the improve call exited ${String(status)} with no result; see ${out}`);
  }

  return text;
}

// A new run would read an old run's cases and results as its own.
export function newWorkspaceRefusal(workspace: string): string | null {
  return existsSync(workspace) && readdirSync(workspace).length > 0
    ? `workspace ${workspace} is not empty; use a new one, or --resume to go on with it`
    : null;
}

// A resumed run reuses recorded results, which only hold for the options, eval set and skill that produced them.
export function resumeRefusal(workspace: string, options: Readonly<Record<string, unknown>>): string | null {
  const optionsFile = join(workspace, 'options.json');
  const started: unknown = existsSync(optionsFile) ? readJson(optionsFile) : null;

  if (!isRecord(started)) {
    return `nothing to resume in ${workspace}: it has no options.json`;
  }

  const differing = Object.entries(options)
    .filter(([key, value]) => started[key] !== value)
    .map(([key, value]) => `${key} ${String(started[key])}, not ${String(value)}`);

  return differing.length > 0 ? `--resume needs the options the workspace started with: ${differing.join('; ')}` : null;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      plugin: { type: 'string' },
      skill: { type: 'string' },
      'eval-set': { type: 'string' },
      workspace: { type: 'string' },
      model: { type: 'string', default: 'sonnet' },
      'improve-model': { type: 'string', default: 'opus' },
      runs: { type: 'string', default: '3' },
      'max-iterations': { type: 'string', default: '5' },
      holdout: { type: 'string', default: '0.4' },
      threshold: { type: 'string', default: '0.5' },
      concurrency: { type: 'string', default: '4' },
      seed: { type: 'string', default: '42' },
      resume: { type: 'boolean', default: false },
    },
  });
  const { plugin, skill, workspace } = values;
  const evalSet = values['eval-set'];

  if (plugin === undefined || skill === undefined || evalSet === undefined || workspace === undefined) {
    throw new Error('usage: trigger-optimize.ts --plugin <dir> --skill <name> --eval-set <json> --workspace <dir>');
  }

  const runs = wholeNumber('runs', values.runs, 1);
  const maxIterations = wholeNumber('max-iterations', values['max-iterations'], 1);
  const concurrency = wholeNumber('concurrency', values.concurrency, 1);
  const seed = wholeNumber('seed', values.seed, 0);
  const holdout = share('holdout', values.holdout, 'below 1');
  const threshold = share('threshold', values.threshold, '1');

  const fresh = values.resume ? null : newWorkspaceRefusal(workspace);

  if (fresh !== null) {
    throw new Error(fresh);
  }

  const evalSetText = readFileSync(evalSet, 'utf8');
  const skillText = readFileSync(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8');
  const options = {
    plugin,
    skill,
    evalSet,
    model: values.model,
    runs,
    holdout,
    threshold,
    seed,
    evalSetSha256: sha256(evalSetText),
    skillSha256: sha256(skillText),
  };
  const resumed = values.resume ? resumeRefusal(workspace, options) : null;

  if (resumed !== null) {
    throw new Error(resumed);
  }

  // Stryker disable all: from here the command line runs the slim runner and `claude plugin eval`, which no unit test
  // starts
  const runSlim = required('LZ_EVAL_RUN_SLIM');
  const claude = process.env['LZ_EVAL_CLAUDE'] ?? 'claude';
  const optionsFile = join(workspace, 'options.json');
  const queries: unknown = JSON.parse(evalSetText);

  if (!Array.isArray(queries) || !queries.every(isQuery)) {
    throw new Error(`${evalSet} is not a list of {query, should_trigger}`);
  }

  const { name, description, body } = skillParts(skillText);
  const split = splitEvalSet(queries, holdout, seed);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(optionsFile, `${JSON.stringify(options, null, 2)}\n`);
  const { recorded, aside } = recordedIterations(workspace, skill, split, threshold, Date.now());

  if (aside !== null) {
    process.stderr.write(`iteration ${String(recorded.length)} runs again; its files are in ${aside}\n`);
  }

  const result = await optimize(
    {
      skillName: name,
      skillContent: body,
      original: description,
      train: split.train,
      test: split.test,
      maxIterations,
    },
    {
      evaluate: (candidate, all, iteration) => {
        const { folder, copy, json, finished } = iterationPaths(workspace, skill, iteration);
        copyPlugin(plugin, copy, skill, candidate);
        const names = writeCases(join(copy, 'evals'), skill, split);
        const status = ran(
          claude,
          [
            'plugin',
            'eval',
            copy,
            '--json',
            json,
            '--runs',
            String(runs),
            '--ablation',
            'none',
            '--model',
            values.model,
            '-j',
            String(concurrency),
            '--threshold',
            '0',
            '--trust-plugin',
            '--no-publish',
            '--output-dir',
            join(folder, 'results'),
          ],
          'claude plugin eval',
        );

        if (status !== 0 || !existsSync(json)) {
          throw new Error(
            `claude plugin eval exited ${String(status)} for iteration ${String(iteration)}; see ${json}`,
          );
        }

        const results = queryResults(readJson(json), names, all, threshold);
        writeFileSync(finished, '');

        return Promise.resolve(results);
      },
      improve: (prompt) => {
        const folder = resolve(workspace, `improve-${String(Date.now())}`);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, 'prompt.md'), prompt);
        const out = join(folder, 'result.json');
        const status = ran(
          process.execPath,
          [
            runSlim,
            '--cwd',
            folder,
            '--prompt-file',
            join(folder, 'prompt.md'),
            '--out',
            out,
            '--model',
            values['improve-model'],
            '--offline',
          ],
          'the slim runner',
        );
        return Promise.resolve(improvedText(status, out));
      },
    },
    recorded,
  );

  writeFileSync(join(workspace, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${result.exit_reason}; best ${result.best_score} (train ${result.best_train_score}):\n${result.best_description}\n`,
  );
}
