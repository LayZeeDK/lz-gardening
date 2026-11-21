import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvalQuery } from './trigger-cases.ts';
import { optimize } from './trigger-loop.ts';
import type { Results } from './trigger-results.ts';

const train: EvalQuery[] = [
  { query: 'tend the suppressions', should_trigger: true },
  { query: 'explain worktrees', should_trigger: false },
];
const testSet: EvalQuery[] = [{ query: 'make this mistake impossible', should_trigger: true }];

// Each description triggers exactly the queries listed for it.
function evaluator(triggering: Readonly<Record<string, readonly string[]>>) {
  return (description: string, queries: readonly EvalQuery[]): Promise<Results> => {
    const results = queries.map(({ query, should_trigger }) => {
      const fired = triggering[description]?.includes(query) ?? false;

      return {
        query,
        should_trigger,
        triggers: fired ? 3 : 0,
        runs: 3,
        trigger_rate: fired ? 1 : 0,
        pass: fired === should_trigger,
      };
    });
    const passed = results.filter((result) => result.pass).length;

    return Promise.resolve({ results, summary: { passed, failed: results.length - passed, total: results.length } });
  };
}

test('optimize asks once for a shorter rewrite when a description passes 1024 characters', async () => {
  const long = 'x'.repeat(1100);
  const prompts: string[] = [];
  const replies = [`<new_description>${long}</new_description>`, '<new_description>Short.</new_description>'];
  const result = await optimize(
    { skillName: 'lz-tend', skillContent: 'BODY', original: 'A.', train, test: [], maxIterations: 2 },
    {
      evaluate: evaluator({}),
      improve: (prompt) => {
        prompts.push(prompt);

        return Promise.resolve(replies.shift() ?? '');
      },
    },
  );

  assert.deepEqual(
    [
      prompts.length,
      prompts[1]?.includes(`at 1100 characters is over the 1024-character hard limit:\n\n"${long}"`),
      result.final_description,
    ],
    [2, true, 'Short.'],
  );
});

test('optimize stops at the iteration limit and keeps the description with the most test queries passed', async () => {
  const replies = ['<new_description>B.</new_description>', '<new_description>C.</new_description>'];
  const result = await optimize(
    { skillName: 'lz-tend', skillContent: 'BODY', original: 'A.', train, test: testSet, maxIterations: 3 },
    {
      evaluate: evaluator({ 'A.': ['make this mistake impossible'], 'B.': [], 'C.': ['explain worktrees'] }),
      improve: () => Promise.resolve(replies.shift() ?? ''),
    },
  );

  assert.deepEqual(
    [result.exit_reason, result.best_description, result.best_score, result.final_description, result.iterations_run],
    ['max_iterations (3)', 'A.', '1/1', 'C.', 3],
  );
});

test('optimize improves from the train failures until every train query passes, and keeps the best test score', async () => {
  const prompts: string[] = [];
  const result = await optimize(
    { skillName: 'lz-tend', skillContent: 'BODY', original: 'First.', train, test: testSet, maxIterations: 5 },
    {
      evaluate: evaluator({ 'First.': [], 'Second.': ['tend the suppressions', 'make this mistake impossible'] }),
      improve: (prompt) => {
        prompts.push(prompt);

        return Promise.resolve('<new_description>Second.</new_description>');
      },
    },
  );

  assert.deepEqual(
    [
      prompts.length,
      prompts[0]?.includes('"tend the suppressions" (triggered 0/3 times)'),
      prompts[0]?.includes('make this mistake impossible'),
      {
        exit: result.exit_reason,
        best: result.best_description,
        bestTest: result.best_test_score,
        iterations: result.iterations_run,
      },
    ],
    [1, true, false, { exit: 'all_passed (iteration 2)', best: 'Second.', bestTest: '1/1', iterations: 2 }],
  );
});
