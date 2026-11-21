// Optimizes one skill's description for triggering: skill-creator's run_loop.py method, measured with
// `claude plugin eval` on a copy of the plugin per iteration. Repository-only; nothing here ships with the plugin.
//
//   node tools/evals/trigger-optimize.ts --plugin <dir> --skill <name> --eval-set <json> --workspace <dir>
//     [--model sonnet] [--improve-model opus] [--runs 3] [--max-iterations 5] [--holdout 0.4] [--threshold 0.5]
//     [--concurrency 4] [--seed 42]
//
// Environment: LZ_EVAL_RUN_SLIM, the slim `claude -p` runner (run-slim.ts) that writes each improved description;
// LZ_EVAL_CLAUDE, the claude executable when `claude` on PATH is a shell shim Node.js cannot start (default: claude).
// Writes <workspace>/iteration-N/ (the plugin copy, its cases, plugin-eval.json, the improve call) and
// <workspace>/results.json. The plugin's own SKILL.md is never changed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { resultLine } from './eval-grade.ts';
import { skillParts, splitEvalSet, withDescription, writeCases, type EvalQuery } from './trigger-cases.ts';
import { optimize } from './trigger-loop.ts';
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
    },
  });
  const { plugin, skill, workspace } = values;
  const evalSet = values['eval-set'];

  if (plugin === undefined || skill === undefined || evalSet === undefined || workspace === undefined) {
    throw new Error('usage: trigger-optimize.ts --plugin <dir> --skill <name> --eval-set <json> --workspace <dir>');
  }

  const runSlim = required('LZ_EVAL_RUN_SLIM');
  const claude = process.env['LZ_EVAL_CLAUDE'] ?? 'claude';
  const queries: unknown = readJson(evalSet);

  if (!Array.isArray(queries) || !queries.every(isQuery)) {
    throw new Error(`${evalSet} is not a list of {query, should_trigger}`);
  }

  const { name, description, body } = skillParts(readFileSync(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8'));
  const split = splitEvalSet(queries, Number(values.holdout), Number(values.seed));
  const threshold = Number(values.threshold);
  const result = await optimize(
    {
      skillName: name,
      skillContent: body,
      original: description,
      train: split.train,
      test: split.test,
      maxIterations: Number(values['max-iterations']),
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
            values.runs,
            '--ablation',
            'none',
            '--model',
            values.model,
            '-j',
            values.concurrency,
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
        const text = existsSync(out) ? resultLine(readJson(out))['result'] : undefined;

        if (status !== 0 || typeof text !== 'string') {
          throw new Error(`the improve call exited ${String(status)} with no result; see ${out}`);
        }

        return Promise.resolve(text);
      },
    },
  );

  writeFileSync(join(workspace, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${result.exit_reason}; best ${result.best_score} (train ${result.best_train_score}):\n${result.best_description}\n`,
  );
}
