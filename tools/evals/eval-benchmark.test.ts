import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { benchmark, benchmarkMarkdown, stats, writeBenchmark } from './eval-benchmark.ts';

function iterationWith(runs: readonly { config: string; passed: number }[]): string {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-benchmark-'));
  const evalDir = join(iteration, 'eval-tend-opus');
  mkdirSync(evalDir);
  writeFileSync(
    join(iteration, 'iteration.json'),
    JSON.stringify({ configs: { new_skill: { plugin: 'b' }, old_skill: { plugin: 'a' } }, models: ['opus'] }),
  );
  writeFileSync(join(evalDir, 'eval_metadata.json'), JSON.stringify({ eval_id: 11, assertions: [] }));

  for (const [index, { config, passed }] of runs.entries()) {
    const runDir = join(evalDir, config, `run-${String(index + 1)}`);
    mkdirSync(runDir, { recursive: true });
    const { grading, timing } = graded(passed, 1, 60, 1000);
    writeFileSync(join(runDir, 'grading.json'), JSON.stringify({ ...grading, user_notes_summary: {} }));
    writeFileSync(join(runDir, 'timing.json'), JSON.stringify(timing));
  }

  return iteration;
}

test('writeBenchmark writes benchmark.json, benchmark.md and summary.md, configurations in iteration.json order', () => {
  const iteration = iterationWith([
    { config: 'old_skill', passed: 0 },
    { config: 'new_skill', passed: 1 },
  ]);

  writeBenchmark(iteration, 'lz-gardening', 't');

  const written: unknown = JSON.parse(readFileSync(join(iteration, 'benchmark.json'), 'utf8'));
  const summary = isRecord(written) ? written['run_summary'] : undefined;

  assert.deepEqual(
    [
      isRecord(summary) ? [Object.keys(summary), summary['delta']] : undefined,
      readFileSync(join(iteration, 'benchmark.md'), 'utf8').split('\n')[2],
      readFileSync(join(iteration, 'summary.md'), 'utf8').split('\n').slice(-3),
    ],
    [
      [['new_skill', 'old_skill', 'delta'], { pass_rate: '+1.00', time_seconds: '+0.0', tokens: '+0' }],
      '**Model**: opus',
      [
        '| overall | new_skill | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |',
        '| overall | old_skill | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |',
        '',
      ],
    ],
  );
});

test('benchmarkMarkdown tables the two configurations and their delta', () => {
  const result = benchmark(
    [
      { evalId: 2, config: 'new_skill', runNumber: 1, ...graded(1, 2, 10, 100) },
      { evalId: 1, config: 'old_skill', runNumber: 1, ...graded(2, 2, 30.25, 400) },
    ],
    {
      configs: ['new_skill', 'old_skill'],
      skillName: 'lz-gardening',
      skillPath: 'p',
      executorModel: 'opus',
      timestamp: 't',
    },
  );

  assert.equal(
    benchmarkMarkdown(result),
    [
      '# Skill Benchmark: lz-gardening',
      '',
      '**Model**: opus',
      '**Date**: t',
      '**Evals**: 1, 2 (1 run each per configuration)',
      '',
      '## Summary',
      '',
      '| Metric | New Skill | Old Skill | Delta |',
      '|--------|------------|---------------|-------|',
      '| Pass Rate | 50% ± 0% | 100% ± 0% | -0.50 |',
      '| Time | 10.0s ± 0.0s | 30.3s ± 0.0s | -20.3s |',
      '| Tokens | 100 ± 0 | 400 ± 0 | -300 |',
      '',
    ].join('\n'),
  );
});

function graded(passed: number, total: number, seconds: number, tokens: number) {
  return {
    grading: {
      expectations: [{ text: 'closed', passed: passed > 0, evidence: 'closed 2;' }],
      summary: { passed, failed: total - passed, total, pass_rate: passed / total },
      execution_metrics: { total_tool_calls: 7, errors_encountered: 1 },
      user_notes_summary: { uncertainties: [], needs_review: ['not judged: x'], workarounds: [] },
    },
    timing: { total_tokens: tokens, total_duration_seconds: seconds },
  };
}

test('benchmark summarises each configuration, gives the first minus the second as the delta, and lists every run', () => {
  const result = benchmark(
    [
      { evalId: 1, config: 'new_skill', runNumber: 1, ...graded(2, 2, 10, 100) },
      { evalId: 1, config: 'new_skill', runNumber: 2, ...graded(1, 2, 20, 300) },
      { evalId: 1, config: 'old_skill', runNumber: 1, ...graded(0, 2, 30, 100) },
    ],
    {
      configs: ['new_skill', 'old_skill'],
      skillName: 'lz-gardening',
      skillPath: 'p',
      executorModel: 'opus',
      timestamp: 't',
    },
  );

  assert.deepEqual(result, {
    metadata: {
      skill_name: 'lz-gardening',
      skill_path: 'p',
      executor_model: 'opus',
      analyzer_model: '<model-name>',
      timestamp: 't',
      evals_run: [1],
      runs_per_configuration: 2,
    },
    runs: [
      {
        eval_id: 1,
        configuration: 'new_skill',
        run_number: 1,
        result: {
          pass_rate: 1,
          passed: 2,
          failed: 0,
          total: 2,
          time_seconds: 10,
          tokens: 100,
          tool_calls: 7,
          errors: 1,
        },
        expectations: [{ text: 'closed', passed: true, evidence: 'closed 2;' }],
        notes: ['not judged: x'],
      },
      {
        eval_id: 1,
        configuration: 'new_skill',
        run_number: 2,
        result: {
          pass_rate: 0.5,
          passed: 1,
          failed: 1,
          total: 2,
          time_seconds: 20,
          tokens: 300,
          tool_calls: 7,
          errors: 1,
        },
        expectations: [{ text: 'closed', passed: true, evidence: 'closed 2;' }],
        notes: ['not judged: x'],
      },
      {
        eval_id: 1,
        configuration: 'old_skill',
        run_number: 1,
        result: {
          pass_rate: 0,
          passed: 0,
          failed: 2,
          total: 2,
          time_seconds: 30,
          tokens: 100,
          tool_calls: 7,
          errors: 1,
        },
        expectations: [{ text: 'closed', passed: false, evidence: 'closed 2;' }],
        notes: ['not judged: x'],
      },
    ],
    run_summary: {
      new_skill: {
        pass_rate: { mean: 0.75, stddev: 0.3536, min: 0.5, max: 1 },
        time_seconds: { mean: 15, stddev: 7.0711, min: 10, max: 20 },
        tokens: { mean: 200, stddev: 141.4214, min: 100, max: 300 },
      },
      old_skill: {
        pass_rate: { mean: 0, stddev: 0, min: 0, max: 0 },
        time_seconds: { mean: 30, stddev: 0, min: 30, max: 30 },
        tokens: { mean: 100, stddev: 0, min: 100, max: 100 },
      },
      delta: { pass_rate: '+0.75', time_seconds: '-15.0', tokens: '+100' },
    },
    notes: [],
  });
});

test('stats gives the mean, the sample standard deviation, the minimum and the maximum, and zeros for no values', () => {
  assert.deepEqual(
    [stats([1, 2, 4]), stats([0.5]), stats([])],
    [
      { mean: 2.3333, stddev: 1.5275, min: 1, max: 4 },
      { mean: 0.5, stddev: 0, min: 0.5, max: 0.5 },
      { mean: 0, stddev: 0, min: 0, max: 0 },
    ],
  );
});
