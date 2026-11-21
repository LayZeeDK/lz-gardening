import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryResults } from './trigger-results.ts';

function run(invoked: boolean | undefined) {
  return {
    error: invoked === undefined ? 'API error' : null,
    graders: invoked === undefined ? [] : [{ name: 'invoked', passed: invoked }],
  };
}

function pluginEval(cases: Record<string, readonly (boolean | undefined)[]>) {
  return {
    cases: Object.entries(cases).map(([name, runs]) => ({ name, arms: { with: runs.map(run) } })),
  };
}

test('queryResults gives each query its trigger rate over the graded runs and passes it by the threshold', () => {
  const queries = [
    { query: 'tend it', should_trigger: true },
    { query: 'explain worktrees', should_trigger: false },
  ];

  assert.deepEqual(
    queryResults(
      pluginEval({ q01: [true, false, undefined], q02: [true, false, false] }),
      { q01: 'tend it', q02: 'explain worktrees' },
      queries,
      0.5,
    ),
    {
      results: [
        { query: 'tend it', should_trigger: true, triggers: 1, runs: 2, trigger_rate: 0.5, pass: true },
        { query: 'explain worktrees', should_trigger: false, triggers: 1, runs: 3, trigger_rate: 0.3333, pass: true },
      ],
      summary: { passed: 2, failed: 0, total: 2 },
    },
  );
});

test('queryResults refuses a query with no graded run, since its rate is unknown', () => {
  assert.throws(
    () =>
      queryResults(
        pluginEval({ q01: [undefined] }),
        { q01: 'tend it' },
        [{ query: 'tend it', should_trigger: true }],
        0.5,
      ),
    /q01 \(tend it\) has no graded run/,
  );
});
