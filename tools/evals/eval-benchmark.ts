// benchmark.json and benchmark.md for an eval iteration, in the schema of skill-creator's aggregate_benchmark.py, so
// its analyst instructions (agents/analyzer.md) apply unchanged. Repository-only; nothing here ships with the plugin.
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { summaryTable } from './eval-summary.ts';

export interface Stats {
  readonly mean: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
}

export interface GradedRun {
  readonly evalId: number;
  readonly config: string;
  readonly runNumber: number;
  readonly grading: unknown;
  readonly timing: unknown;
}

export interface BenchmarkOptions {
  readonly configs: readonly [string, string];
  readonly skillName: string;
  readonly skillPath: string;
  readonly executorModel: string;
  readonly timestamp: string;
}

function field(record: unknown, ...path: readonly string[]): unknown {
  return path.reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), record);
}

function numberField(record: unknown, ...path: readonly string[]): number {
  const value = field(record, ...path);

  return typeof value === 'number' ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function runEntry({ evalId, config, runNumber, grading, timing }: GradedRun) {
  const notes = ['uncertainties', 'needs_review', 'workarounds'].flatMap((key) =>
    strings(field(grading, 'user_notes_summary', key)),
  );
  const expectations = field(grading, 'expectations');

  return {
    eval_id: evalId,
    configuration: config,
    run_number: runNumber,
    result: {
      pass_rate: numberField(grading, 'summary', 'pass_rate'),
      passed: numberField(grading, 'summary', 'passed'),
      failed: numberField(grading, 'summary', 'failed'),
      total: numberField(grading, 'summary', 'total'),
      time_seconds: numberField(timing, 'total_duration_seconds'),
      tokens: numberField(timing, 'total_tokens'),
      tool_calls: numberField(grading, 'execution_metrics', 'total_tool_calls'),
      errors: numberField(grading, 'execution_metrics', 'errors_encountered'),
    },
    expectations: Array.isArray(expectations) ? expectations : [],
    notes,
  };
}

// The delta is the first configuration's means minus the second's, in the order `configs` names them.
export function benchmark(runs: readonly GradedRun[], options: BenchmarkOptions) {
  const entries = runs.map(runEntry);
  const summaries = options.configs.map((config) => {
    const own = entries.filter((entry) => entry.configuration === config).map((entry) => entry.result);

    return {
      pass_rate: stats(own.map((result) => result.pass_rate)),
      time_seconds: stats(own.map((result) => result.time_seconds)),
      tokens: stats(own.map((result) => result.tokens)),
    };
  });
  const [primary, baseline] = summaries;
  const counts = new Map<string, number>();

  for (const { evalId, config } of runs) {
    const key = `${String(evalId)}\0${config}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    metadata: {
      skill_name: options.skillName,
      skill_path: options.skillPath,
      executor_model: options.executorModel,
      analyzer_model: '<model-name>',
      timestamp: options.timestamp,
      evals_run: [...new Set(runs.map((run) => run.evalId))].sort((left, right) => left - right),
      runs_per_configuration: Math.max(0, ...counts.values()),
    },
    runs: entries,
    run_summary: {
      ...Object.fromEntries(options.configs.map((config, index) => [config, summaries[index]])),
      delta: {
        pass_rate: signed((primary?.pass_rate.mean ?? 0) - (baseline?.pass_rate.mean ?? 0), 2),
        time_seconds: signed((primary?.time_seconds.mean ?? 0) - (baseline?.time_seconds.mean ?? 0), 1),
        tokens: signed((primary?.tokens.mean ?? 0) - (baseline?.tokens.mean ?? 0), 0),
      },
    },
    notes: [],
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readOptional(path: string): unknown {
  return existsSync(path) ? readJson(path) : {};
}

// A run passes in full when it has graded expectations, every one passed, and none waits for the judge.
function fullyPassed(grading: unknown): boolean {
  return (
    numberField(grading, 'summary', 'failed') === 0 &&
    numberField(grading, 'summary', 'total') > 0 &&
    strings(field(grading, 'user_notes_summary', 'needs_review')).length === 0
  );
}

// iteration.json names the two configurations, the one under test first; its `models` name the executors.
export function writeBenchmark(iteration: string, skillName: string, timestamp: string): void {
  const description = readJson(join(iteration, 'iteration.json'));
  const named = field(description, 'configs');
  const configs = isRecord(named) ? Object.keys(named) : [];
  const [first, second] = configs;

  if (configs.length !== 2 || first === undefined || second === undefined) {
    throw new Error(`iteration.json in ${iteration} must name two configs; it names ${String(configs.length)}`);
  }

  const runs = globSync(join('eval-*', '*', 'run-*', 'grading.json'), { cwd: iteration })
    .sort()
    .map((path) => {
      const [evalName = '', config = '', run = ''] = path.split(sep);

      return {
        evalName,
        evalId: numberField(readOptional(join(iteration, evalName, 'eval_metadata.json')), 'eval_id'),
        config,
        runNumber: Number(run.replace('run-', '')),
        grading: readJson(join(iteration, path)),
        timing: readOptional(join(iteration, evalName, config, run, 'timing.json')),
      };
    });
  const result = benchmark(runs, {
    configs: [first, second],
    skillName,
    skillPath: strings([field(description, 'configs', first, 'plugin')]).join(''),
    executorModel: strings(field(description, 'models')).join(', '),
    timestamp,
  });

  writeFileSync(join(iteration, 'benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(iteration, 'benchmark.md'), benchmarkMarkdown(result));
  writeFileSync(
    join(iteration, 'summary.md'),
    `${summaryTable(runs.map((run) => ({ evalName: run.evalName, config: run.config, fullyPassed: fullyPassed(run.grading) })))}\n`,
  );
}

// node tools/evals/eval-benchmark.ts <iteration dir> <skill name>
if (isMainModule(import.meta.url)) {
  const [iteration = '', skillName = ''] = process.argv.slice(2);

  if (!existsSync(join(iteration, 'iteration.json')) || skillName === '') {
    throw new Error('usage: eval-benchmark.ts <iteration dir with iteration.json> <skill name>');
  }

  writeBenchmark(iteration, skillName, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

function titled(config: string): string {
  return config
    .split('_')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export function benchmarkMarkdown(result: ReturnType<typeof benchmark>): string {
  const { metadata, run_summary: summary } = result;
  const [first = '', second = ''] = Object.keys(summary).filter((key) => key !== 'delta');
  const measure = (config: string, metric: string, format: (value: number) => string): string =>
    `${format(numberField(summary, config, metric, 'mean'))} ± ${format(numberField(summary, config, metric, 'stddev'))}`;
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
  const seconds = (value: number): string => `${value.toFixed(1)}s`;
  const count = (value: number): string => value.toFixed(0);
  const runs = metadata.runs_per_configuration;

  return [
    `# Skill Benchmark: ${metadata.skill_name}`,
    '',
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${metadata.evals_run.join(', ')} (${String(runs)} run${runs === 1 ? '' : 's'} each per configuration)`,
    '',
    '## Summary',
    '',
    `| Metric | ${titled(first)} | ${titled(second)} | Delta |`,
    '|--------|------------|---------------|-------|',
    `| Pass Rate | ${measure(first, 'pass_rate', percent)} | ${measure(second, 'pass_rate', percent)} | ${summary.delta.pass_rate} |`,
    `| Time | ${measure(first, 'time_seconds', seconds)} | ${measure(second, 'time_seconds', seconds)} | ${summary.delta.time_seconds}s |`,
    `| Tokens | ${measure(first, 'tokens', count)} | ${measure(second, 'tokens', count)} | ${summary.delta.tokens} |`,
    '',
  ].join('\n');
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function stats(values: readonly number[]): Stats {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const stddev = values.length > 1 ? Math.sqrt(squares / (values.length - 1)) : 0;

  return {
    mean: rounded(mean),
    stddev: rounded(stddev),
    min: rounded(Math.min(...values)),
    max: rounded(Math.max(...values)),
  };
}
