// Optimizes one skill's description for triggering: skill-creator's run_loop.py method, measured with
// `claude plugin eval` on a copy of the plugin per iteration. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/trigger-optimize.ts --plugin <dir> --skill <name> --eval-set <json> --workspace <dir>
//     [--model sonnet] [--improve-model opus] [--runs 3] [--max-iterations 5] [--holdout 0.4] [--threshold 0.5]
//     [--concurrency 4] [--seed 42] [--resume]
//
// --resume goes on with a stopped run in the same workspace and options: it keeps each finished iteration's results
// and description, and runs the first unfinished iteration again.
//
// Environment: LZ_EVAL_RUN_SLIM, the slim `claude -p` runner (run-slim.ts) that writes each improved description;
// LZ_EVAL_CLAUDE, the claude executable when `claude` on PATH is a shell shim Node.js cannot start (default: claude).
// Writes into a new or empty <workspace>: options.json, iteration-N/ (the plugin copy, its cases, plugin-eval.json),
// improve-<ms>/ (each improve call's prompt and output) and results.json. The plugin's own SKILL.md is never changed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { slimOutput } from './slim-output.ts';
import { skillParts, splitEvalSet, withDescription, writeCases, type EvalQuery } from './trigger-cases.ts';
import { optimize, type Recorded } from './trigger-loop.ts';
import { queryResults } from './trigger-results.ts';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
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
function copyPlugin(plugin: string, destination: string, skill: string, description: string): void {
  cpSync(plugin, destination, {
    recursive: true,
    filter: (source) =>
      !relative(plugin, source)
        .split(sep)
        .some((part) => part === 'node_modules' || part === 'evals'),
  });

  const skillFile = join(destination, 'skills', skill, 'SKILL.md');
  writeFileSync(skillFile, withDescription(readFileSync(skillFile, 'utf8'), description));
}

// A resumed run reuses recorded results, which only hold for the options and split that produced them.
export function workspaceRefusal(
  workspace: string,
  options: Readonly<Record<string, unknown>>,
  resume: boolean,
): string | null {
  const optionsFile = join(workspace, 'options.json');

  if (!resume) {
    return existsSync(workspace) && readdirSync(workspace).length > 0
      ? `workspace ${workspace} is not empty; use a new one, or --resume to go on with it`
      : null;
  }

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

  const options = { plugin, skill, evalSet, model: values.model, runs, holdout, threshold, seed };
  const optionsFile = join(workspace, 'options.json');
  const refusal = workspaceRefusal(workspace, options, values.resume);

  if (refusal !== null) {
    throw new Error(refusal);
  }

  // Stryker disable all: from here the command line runs the slim runner and `claude plugin eval`, which no unit test
  // starts
  const runSlim = required('LZ_EVAL_RUN_SLIM');
  const claude = process.env['LZ_EVAL_CLAUDE'] ?? 'claude';
  const queries: unknown = readJson(evalSet);

  if (!Array.isArray(queries) || !queries.every(isQuery)) {
    throw new Error(`${evalSet} is not a list of {query, should_trigger}`);
  }

  const { name, description, body } = skillParts(readFileSync(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8'));
  const split = splitEvalSet(queries, holdout, seed);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(optionsFile, `${JSON.stringify(options, null, 2)}\n`);
  // Each finished iteration keeps its results; the first unfinished one keeps only its description and moves aside,
  // so its evaluation runs again.
  const recorded: Recorded[] = [];

  for (let iteration = 1; ; iteration += 1) {
    const folder = resolve(workspace, `iteration-${String(iteration)}`);
    const copy = join(folder, 'plugin');
    const skillFile = join(copy, 'skills', skill, 'SKILL.md');

    if (!existsSync(skillFile)) {
      break;
    }

    const evaluated = skillParts(readFileSync(skillFile, 'utf8')).description;
    const json = join(folder, 'plugin-eval.json');

    try {
      const names = writeCases(join(copy, 'evals'), skill, split);
      recorded.push({ description: evaluated, all: queryResults(readJson(json), names, queries, threshold) });
    } catch (error) {
      const aside = `${folder}-stopped-${String(Date.now())}`;
      renameSync(folder, aside);
      process.stderr.write(`iteration ${String(iteration)} runs again (${String(error)}); its files are in ${aside}\n`);
      recorded.push({ description: evaluated });
      break;
    }
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
        const folder = resolve(workspace, `iteration-${String(iteration)}`);
        const copy = join(folder, 'plugin');
        const json = join(folder, 'plugin-eval.json');
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

        return Promise.resolve(queryResults(readJson(json), names, all, threshold));
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
        const text = existsSync(out) ? slimOutput(readJson(out)).result['result'] : undefined;

        if (status !== 0 || typeof text !== 'string') {
          throw new Error(`the improve call exited ${String(status)} with no result; see ${out}`);
        }

        return Promise.resolve(text);
      },
    },
    recorded,
  );

  writeFileSync(join(workspace, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${result.exit_reason}; best ${result.best_score} (train ${result.best_train_score}):\n${result.best_description}\n`,
  );
}
