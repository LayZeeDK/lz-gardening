// benchmark.json and benchmark.md for an eval iteration, in the schema of skill-creator's aggregate_benchmark.py, so
// its analyst instructions (agents/analyzer.md) apply unchanged. Repository-only; nothing here ships with the plugin.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { parseGrading, parseTiming, type Grading, type Timing } from './eval-grade.ts';
import { evalFolderOf, gradedRuns, readIteration, readJson } from './eval-layout.ts';
import { summaryTable } from './eval-summary.ts';

export interface Stats {
  readonly mean: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
}

interface ConfigSummary {
  readonly pass_rate: Stats;
  readonly time_seconds: Stats;
  readonly tokens: Stats;
}

export interface GradedRun {
  // The eval folder's name: each model's runs of one case have a folder of their own and share its eval id.
  readonly evalName: string;
  readonly evalId: number;
  readonly config: string;
  readonly runNumber: number;
  readonly grading: Grading;
  readonly timing: Timing;
}

export interface BenchmarkOptions {
  readonly configs: readonly [string, string];
  readonly skillName: string;
  readonly skillPath: string;
  readonly executorModel: string;
  readonly timestamp: string;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function runEntry({ evalId, config, runNumber, grading, timing }: GradedRun) {
  const { summary, execution_metrics: metrics, user_notes_summary: notes } = grading;

  return {
    eval_id: evalId,
    configuration: config,
    run_number: runNumber,
    result: {
      pass_rate: summary.pass_rate,
      passed: summary.passed,
      failed: summary.failed,
      total: summary.total,
      time_seconds: timing.total_duration_seconds,
      tokens: timing.total_tokens,
      tool_calls: metrics.total_tool_calls,
      errors: metrics.errors_encountered,
    },
    expectations: grading.expectations,
    notes: [...notes.uncertainties, ...notes.needs_review, ...notes.workarounds],
  };
}

function configSummary(entries: readonly ReturnType<typeof runEntry>[], config: string): ConfigSummary {
  const own = entries.filter((entry) => entry.configuration === config).map((entry) => entry.result);

  return {
    pass_rate: stats(own.map((result) => result.pass_rate)),
    time_seconds: stats(own.map((result) => result.time_seconds)),
    tokens: stats(own.map((result) => result.tokens)),
  };
}

// The delta is the first configuration's means minus the second's, in the order `configs` names them.
export function benchmark(runs: readonly GradedRun[], options: BenchmarkOptions) {
  const entries = runs.map(runEntry);
  const perConfig = Object.fromEntries(
    options.configs.map((config) => [config, configSummary(entries, config)] as const),
  );
  const [primary, baseline] = options.configs.map((config) => configSummary(entries, config));
  const counts = new Map<string, number>();

  for (const { evalName, config } of runs) {
    const key = `${evalName}\0${config}`;
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
      ...perConfig,
      delta: {
        pass_rate: signed((primary?.pass_rate.mean ?? 0) - (baseline?.pass_rate.mean ?? 0), 2),
        time_seconds: signed((primary?.time_seconds.mean ?? 0) - (baseline?.time_seconds.mean ?? 0), 1),
        tokens: signed((primary?.tokens.mean ?? 0) - (baseline?.tokens.mean ?? 0), 0),
      },
    },
    notes: [],
  };
}

// A run passes in full when it has graded expectations, every one passed, and none waits for the judge.
function fullyPassed({ summary, user_notes_summary: notes }: Grading): boolean {
  return summary.failed === 0 && summary.total > 0 && notes.needs_review.length === 0;
}

function evalId(evalFolder: string): number {
  const file = join(evalFolder, 'eval_metadata.json');
  const metadata = readJson(file);
  const id = isRecord(metadata) ? metadata['eval_id'] : undefined;

  if (typeof id !== 'number') {
    throw new Error(`${file} has no eval_id`);
  }

  return id;
}

// iteration.json names the two configurations, the one under test first; its `models` name the executors.
export function writeBenchmark(iteration: string, skillName: string, timestamp: string): void {
  const { configs, models } = readIteration(iteration);
  const [first, second] = Object.keys(configs);

  if (Object.keys(configs).length !== 2 || first === undefined || second === undefined) {
    throw new Error(
      `iteration.json in ${iteration} must name two configs; it names ${String(Object.keys(configs).length)}`,
    );
  }

  const runs = gradedRuns(iteration).map(({ evalName, config, run, runDir }) => ({
    evalName,
    evalId: evalId(evalFolderOf(runDir)),
    config,
    runNumber: run,
    grading: parseGrading(readJson(join(runDir, 'grading.json')), join(runDir, 'grading.json')),
    timing: parseTiming(readJson(join(runDir, 'timing.json')), join(runDir, 'timing.json')),
  }));
  const result = benchmark(runs, {
    configs: [first, second],
    skillName,
    skillPath: configs[first] ?? '',
    executorModel: models.join(', '),
    timestamp,
  });

  writeFileSync(join(iteration, 'benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(iteration, 'benchmark.md'), benchmarkMarkdown(result));
  writeFileSync(
    join(iteration, 'summary.md'),
    `${summaryTable(runs.map((run) => ({ evalName: run.evalName, config: run.config, fullyPassed: fullyPassed(run.grading) })))}\n`,
  );
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
  const measure = (
    config: string,
    metric: 'pass_rate' | 'time_seconds' | 'tokens',
    format: (value: number) => string,
  ): string => {
    const { mean, stddev } = configSummary(result.runs, config)[metric];

    return `${format(mean)} ± ${format(stddev)}`;
  };
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

// node tools/evals/eval-benchmark.ts <iteration dir> <skill name>
// Stryker disable all: the command line has no unit tests; it only reads the arguments and writes the benchmark
if (isMainModule(import.meta.url)) {
  const [iteration = '', skillName = ''] = process.argv.slice(2);

  if (!existsSync(join(iteration, 'iteration.json')) || skillName === '') {
    throw new Error('usage: eval-benchmark.ts <iteration dir with iteration.json> <skill name>');
  }

  writeBenchmark(iteration, skillName, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
}
