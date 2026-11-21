import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { gradeRunDir, grading, parseGrading, parseTiming, timing } from './eval-grade.ts';
import type { ToolCall } from './eval-transcript.ts';
import { slimOutput } from './slim-output.ts';

interface RunShape {
  readonly transcript?: boolean;
  readonly finished?: boolean;
}

// A tend run folder whose session closed a class, with its transcript under projects/ unless left out, and its result
// line unless the session never finished.
function tendRun({ transcript = true, finished = true }: RunShape = {}): {
  readonly runDir: string;
  readonly projects: string;
} {
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
      stdout: finished
        ? JSON.stringify({
            type: 'result',
            session_id: 's1',
            num_turns: 3,
            total_cost_usd: 0.5,
            result: 'Closed 2.',
          })
        : '',
    }),
  );

  if (!transcript) {
    return { runDir, projects };
  }

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

  return { runDir, projects };
}

test('gradeRunDir refuses a run whose session transcript is missing, which would grade as a run with no calls', () => {
  const { runDir, projects } = tendRun({ transcript: false });

  assert.throws(() => {
    gradeRunDir(runDir, projects);
  }, /no transcript for session s1 /);
});

test('gradeRunDir fails every assertion of a run whose session never finished, as when it timed out', () => {
  const { runDir, projects } = tendRun({ finished: false });

  gradeRunDir(runDir, projects);

  const graded: unknown = JSON.parse(readFileSync(join(runDir, 'grading.json'), 'utf8'));

  assert.deepEqual(isRecord(graded) ? graded['expectations'] : undefined, [
    { text: 'closed', passed: false, evidence: 'The session printed no result: it timed out or crashed.' },
  ]);
});

test('gradeRunDir writes timing.json and grading.json from the run outputs, the eval metadata and the transcripts', () => {
  const { runDir, projects } = tendRun();

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

test('gradeRunDir grades a resumed run from both parts and takes the judges majority from their verdict files', () => {
  const { runDir, projects } = tendRun();
  const evalDir = join(runDir, '..', '..');
  writeFileSync(
    join(evalDir, 'eval_metadata.json'),
    JSON.stringify({ assertions: [{ text: 'closed', check: 'tend-closed' }, { text: 'reported' }] }),
  );
  writeFileSync(
    join(runDir, 'outputs', 'result-resume-1.json'),
    JSON.stringify({
      cwd: 'D:\\sample',
      ms: 1000,
      stdout: JSON.stringify({ type: 'result', session_id: 's1', num_turns: 2, result: 'Resumed.' }),
    }),
  );
  const verdict = (passed: boolean, evidence: string): string =>
    JSON.stringify([{ text: 'reported', passed, evidence }]);
  writeFileSync(join(runDir, 'llm-grades.json'), verdict(true, 'j1'));
  writeFileSync(join(runDir, 'llm-grades-2.json'), verdict(false, 'j2'));
  writeFileSync(join(runDir, 'llm-grades-3.json'), verdict(true, 'j3'));

  gradeRunDir(runDir, projects);

  const graded: unknown = JSON.parse(readFileSync(join(runDir, 'grading.json'), 'utf8'));

  assert.deepEqual(
    [
      JSON.parse(readFileSync(join(runDir, 'timing.json'), 'utf8')),
      isRecord(graded) ? graded['expectations'] : undefined,
      readFileSync(join(runDir, 'outputs', 'final.md'), 'utf8'),
    ],
    [
      { total_tokens: 0, total_duration_seconds: 3, total_cost_usd: 0.5, turns: 5 },
      [
        { text: 'closed', passed: true, evidence: 'closed 2; synced' },
        { text: 'reported', passed: true, evidence: 'j1 | j3' },
      ],
      '## result.json\n\nClosed 2.\n\n## result-resume-1.json\n\nResumed.\n',
    ],
  );
});

test('gradeRunDir refuses a verdict file that is not a list of verdicts', () => {
  const { runDir, projects } = tendRun();
  writeFileSync(join(runDir, 'llm-grades-2.json'), JSON.stringify([{ text: 'closed', passed: 'yes', evidence: 'e' }]));

  assert.throws(() => {
    gradeRunDir(runDir, projects);
  }, /llm-grades-2\.json is not a list of the expected records/);
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

  assert.deepEqual(grading(calls, assertions, [judged]), {
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

test('grading takes the majority of the judges per assertion and sends a split to review for another judge', () => {
  const assertions = [{ text: 'agreed' }, { text: 'split' }, { text: 'outvoted' }];
  const verdict = (text: string, passed: boolean, evidence: string) => ({ text, passed, evidence });
  const first = [verdict('agreed', true, 'a1'), verdict('split', true, 's1'), verdict('outvoted', true, 'o1')];
  const second = [verdict('agreed', true, 'a2'), verdict('split', false, 's2'), verdict('outvoted', false, 'o2')];
  const third = [verdict('outvoted', false, 'o3')];
  const graded = grading([], assertions, [first, second, third]);

  assert.deepEqual(
    [graded.expectations, graded.user_notes_summary.needs_review],
    [[verdict('agreed', true, 'a1 | a2'), verdict('outvoted', false, 'o2 | o3')], ['judges split: split']],
  );
});

test('parseGrading reads back a grading the grader wrote and refuses one with a field missing or of the wrong kind', () => {
  const written: unknown = JSON.parse(
    JSON.stringify(grading([bash('rg x')], [{ text: 'judged' }], [[{ text: 'judged', passed: true, evidence: 'e' }]])),
  );
  const empty = grading([], [], []);
  const { summary, ...noSummary } = empty;
  const metrics = empty.execution_metrics;
  const notes = empty.user_notes_summary;
  const broken = [
    noSummary,
    { ...empty, summary: { ...summary, total: '0' } },
    { ...empty, expectations: [{ text: 'x', passed: 'yes', evidence: 'e' }] },
    { ...empty, execution_metrics: { ...metrics, permission_denials: undefined } },
    { ...empty, execution_metrics: { ...metrics, tool_calls: { Bash: '1' } } },
    { ...empty, user_notes_summary: { ...notes, workarounds: [1] } },
    [],
  ];

  assert.deepEqual(parseGrading(written, 'g.json'), written);
  assert.deepEqual(
    broken.filter((value) => {
      try {
        parseGrading(value, 'g.json');

        return true;
      } catch {
        return false;
      }
    }),
    [],
  );
});

test('parseTiming reads back a timing the grader wrote and refuses one with a field missing', () => {
  const { turns, ...noTurns } = timing([]);

  assert.deepEqual([parseTiming(timing([]), 't.json'), turns], [timing([]), 0]);
  assert.throws(() => parseTiming(noTurns, 't.json'), /t\.json is not a timing/);
});

function slimOut(result: Record<string, unknown>, ms: number): unknown {
  return {
    cwd: 'D:\\sample',
    status: 0,
    ms,
    stdout: [JSON.stringify({ type: 'system' }), JSON.stringify(result)].join('\n'),
  };
}

test('timing sums the seconds and turns of a run and its resume, and takes tokens and cost from the session total', () => {
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

  assert.deepEqual(timing([first, resumed].map(slimOutput)), {
    total_tokens: 400,
    total_duration_seconds: 1454,
    total_cost_usd: 4.5,
    turns: 234,
  });
});
