import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { gradeRunDir, grading, timing } from './eval-grade.ts';
import type { ToolCall } from './eval-transcript.ts';

test('gradeRunDir writes timing.json and grading.json from the run outputs, the eval metadata and the transcripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-grade-'));
  const projects = join(root, 'projects');
  const evalDir = join(root, 'iteration-1', 'eval-tend-opus');
  const runDir = join(evalDir, 'new_skill', 'run-1');
  const cwd = 'D:\\sample';
  mkdirSync(join(runDir, 'outputs'), { recursive: true });
  mkdirSync(join(projects, 'D--sample'), { recursive: true });
  writeFileSync(
    join(evalDir, 'eval_metadata.json'),
    JSON.stringify({
      eval_id: 1,
      eval_name: 'tend-opus',
      prompt: 'tend',
      assertions: [{ text: 'closed', check: 'tend-closed' }],
    }),
  );
  writeFileSync(
    join(runDir, 'outputs', 'result.json'),
    JSON.stringify({
      cwd,
      ms: 2000,
      stdout: JSON.stringify({
        type: 'result',
        session_id: 's1',
        num_turns: 3,
        total_cost_usd: 0.5,
        result: 'Closed 2.',
      }),
    }),
  );
  writeFileSync(
    join(projects, 'D--sample', 's1.jsonl'),
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't',
              name: 'Bash',
              input: { command: 'node "x/scripts/weeds.ts" close-class --class c' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'closed 2; synced' }] },
      }),
    ].join('\n'),
  );

  gradeRunDir(runDir, projects);

  const graded: unknown = JSON.parse(readFileSync(join(runDir, 'grading.json'), 'utf8'));

  assert.deepEqual(
    [
      JSON.parse(readFileSync(join(runDir, 'timing.json'), 'utf8')),
      isRecord(graded) ? graded['expectations'] : undefined,
      readFileSync(join(runDir, 'outputs', 'calls.jsonl'), 'utf8'),
      readFileSync(join(runDir, 'outputs', 'final.md'), 'utf8'),
    ],
    [
      { total_tokens: 0, total_duration_seconds: 2, total_cost_usd: 0.5, turns: 3 },
      [{ text: 'closed', passed: true, evidence: 'closed 2; synced' }],
      `${JSON.stringify({
        index: 1,
        agent: 'main',
        name: 'Bash',
        input: { command: 'node "x/scripts/weeds.ts" close-class --class c' },
        result: 'closed 2; synced',
        isError: false,
        denied: false,
      })}\n`,
      '## result.json\n\nClosed 2.\n',
    ],
  );
});

function bash(command: string, outcome: Partial<ToolCall> = {}): ToolCall {
  return { agent: 'main', name: 'Bash', input: { command }, result: '', isError: false, denied: false, ...outcome };
}

test('grading scores script checks and judged assertions, lists unjudged ones for review, and counts the calls', () => {
  const calls = [
    bash('node "D:/p/scripts/census.ts" --rev main'),
    bash('npm --prefix bed test', { isError: true }),
    { ...bash('rg x'), name: 'Read', input: {}, denied: true, isError: true },
  ];
  const assertions = [
    { text: 'The census was taken', check: 'census-taken' },
    { text: 'No call was denied', check: 'no-denials' },
    { text: 'The report names the root cause' },
    { text: 'The close holds only proved weeds' },
  ];
  const judged = [{ text: 'The report names the root cause', passed: true, evidence: 'line 3' }];

  assert.deepEqual(grading(calls, assertions, judged), {
    expectations: [
      { text: 'The census was taken', passed: true, evidence: '1 of 1 census.ts --rev runs exited 0' },
      { text: 'No call was denied', passed: false, evidence: '1 denied: Read {}' },
      { text: 'The report names the root cause', passed: true, evidence: 'line 3' },
    ],
    summary: { passed: 2, failed: 1, total: 3, pass_rate: 0.67 },
    execution_metrics: {
      tool_calls: { Bash: 2, Read: 1 },
      total_tool_calls: 3,
      errors_encountered: 2,
      permission_denials: 1,
    },
    user_notes_summary: {
      uncertainties: [],
      needs_review: ['not judged: The close holds only proved weeds'],
      workarounds: [],
    },
  });
});

function slimOut(result: Record<string, unknown>, ms: number): unknown {
  return {
    cwd: 'D:\\sample',
    status: 0,
    ms,
    stdout: [JSON.stringify({ type: 'system' }), JSON.stringify(result)].join('\n'),
  };
}

test('timing sums a run and its resume: seconds, cost, turns and every token the models processed', () => {
  const usage = (tokens: number, cost: number): unknown => ({
    'claude-sonnet-5-5': {
      inputTokens: tokens,
      outputTokens: tokens,
      cacheReadInputTokens: tokens,
      cacheCreationInputTokens: tokens,
      costUSD: cost,
    },
  });
  const first = slimOut(
    { type: 'result', session_id: 's1', num_turns: 77, total_cost_usd: 1.25, modelUsage: usage(10, 1.25) },
    300_000,
  );
  const resumed = slimOut(
    { type: 'result', session_id: 's1', num_turns: 157, total_cost_usd: 4.5, modelUsage: usage(100, 4.5) },
    1_154_000,
  );

  assert.deepEqual(timing([first, resumed]), {
    total_tokens: 440,
    total_duration_seconds: 1454,
    total_cost_usd: 5.75,
    turns: 234,
  });
});
