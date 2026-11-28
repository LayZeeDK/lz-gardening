// Grades one eval run: `timing.json` from its slim `claude -p` output files, `grading.json` in skill-creator's schema
// (`expectations` of `{text, passed, evidence}`, `summary`, `execution_metrics`) from the script checks and the LLM
// judge's verdicts. Repository-only; nothing here ships with the plugin.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../../plugins/tometo/skills/garden/scripts/cli.ts';
import { isRecord } from '../../plugins/tometo/skills/garden/scripts/log-guard.ts';
import { checks } from './eval-checks.ts';
import { evalFolderOf, isAssertion, readJson, type Assertion } from './eval-layout.ts';
import { sessionTranscripts, toolCalls, type ToolCall } from './eval-transcript.ts';
import { slimOutput, type SlimOutput } from './slim-output.ts';

export interface Timing {
  readonly total_tokens: number;
  readonly total_duration_seconds: number;
  readonly total_cost_usd: number;
  readonly turns: number;
}

function numberAt(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];

  return typeof value === 'number' ? value : 0;
}

// Every token the session's models processed: input, output and both cache kinds, summed over the models it used.
function tokens(result: Readonly<Record<string, unknown>>): number {
  const usage = result['modelUsage'];
  const models: unknown[] = isRecord(usage) ? Object.values(usage) : [];

  return models
    .filter((model) => isRecord(model))
    .flatMap((model) =>
      ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].map((key) =>
        numberAt(model, key),
      ),
    )
    .reduce((sum, count) => sum + count, 0);
}

export interface Expectation {
  readonly text: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface Grading {
  readonly expectations: readonly Expectation[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly total: number;
    readonly pass_rate: number;
  };
  readonly execution_metrics: {
    readonly tool_calls: Readonly<Record<string, number>>;
    readonly total_tool_calls: number;
    readonly errors_encountered: number;
    readonly permission_denials: number;
  };
  readonly user_notes_summary: {
    readonly uncertainties: readonly string[];
    readonly needs_review: readonly string[];
    readonly workarounds: readonly string[];
  };
}

function scripted(calls: readonly ToolCall[], { text, check }: Assertion): Expectation | undefined {
  if (check === undefined) {
    return undefined;
  }

  const run = checks[check];

  if (run === undefined) {
    throw new Error(`no script check named ${check}`);
  }

  return { text, ...run(calls) };
}

// The judges' majority on one assertion, with the agreeing judges' evidence; 'split' when they divide evenly.
function judgedVerdict(text: string, judges: readonly (readonly Expectation[])[]): Expectation | 'split' | undefined {
  const verdicts = judges.flatMap((verdictsOfJudge) => verdictsOfJudge.filter((verdict) => verdict.text === text));
  const passed = verdicts.filter((verdict) => verdict.passed);
  const failed = verdicts.filter((verdict) => !verdict.passed);

  if (verdicts.length === 0) {
    return undefined;
  }

  if (passed.length === failed.length) {
    return 'split';
  }

  const majority = passed.length > failed.length ? passed : failed;

  return { text, passed: majority === passed, evidence: majority.map(({ evidence }) => evidence).join(' | ') };
}

// skill-creator's aggregate_benchmark.py takes tokens from timing.json only when grading.json has no `timing`, so
// grading.json carries none. `judges` holds each judge's verdicts; an assertion goes to the judges' majority.
export function grading(
  calls: readonly ToolCall[],
  assertions: readonly Assertion[],
  judges: readonly (readonly Expectation[])[],
): Grading {
  const graded = assertions.map((assertion) => scripted(calls, assertion) ?? judgedVerdict(assertion.text, judges));
  const expectations = graded.filter((expectation) => expectation !== undefined && expectation !== 'split');
  const passed = expectations.filter((expectation) => expectation.passed).length;
  const toolCalls: Record<string, number> = {};

  for (const { name } of calls) {
    toolCalls[name] = (toolCalls[name] ?? 0) + 1;
  }

  return {
    expectations,
    summary: {
      passed,
      failed: expectations.length - passed,
      total: expectations.length,
      pass_rate: expectations.length === 0 ? 0 : Math.round((passed / expectations.length) * 100) / 100,
    },
    execution_metrics: {
      tool_calls: toolCalls,
      total_tool_calls: calls.length,
      errors_encountered: calls.filter((call) => call.isError).length,
      permission_denials: calls.filter((call) => call.denied).length,
    },
    user_notes_summary: {
      uncertainties: [],
      needs_review: assertions.flatMap(({ text }, index) => {
        const verdict = graded[index];

        return verdict === undefined ? [`not judged: ${text}`] : verdict === 'split' ? [`judges split: ${text}`] : [];
      }),
      workarounds: [],
    },
  };
}

function isExpectation(value: unknown): value is Expectation {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    typeof value['passed'] === 'boolean' &&
    typeof value['evidence'] === 'string'
  );
}

function listed<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  if (!Array.isArray(value) || !value.every(guard)) {
    throw new Error(`${what} is not a list of the expected records`);
  }

  return value;
}

function numbers(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => typeof value[key] === 'number');
}

function strings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isGrading(value: unknown): value is Grading {
  if (!isRecord(value)) {
    return false;
  }

  const { expectations, summary, execution_metrics: metrics, user_notes_summary: notes } = value;

  return (
    Array.isArray(expectations) &&
    expectations.every(isExpectation) &&
    numbers(summary, ['passed', 'failed', 'total', 'pass_rate']) &&
    numbers(metrics, ['total_tool_calls', 'errors_encountered', 'permission_denials']) &&
    isRecord(metrics) &&
    isRecord(metrics['tool_calls']) &&
    Object.values(metrics['tool_calls']).every((count) => typeof count === 'number') &&
    isRecord(notes) &&
    ['uncertainties', 'needs_review', 'workarounds'].every((key) => strings(notes[key]))
  );
}

function isTiming(value: unknown): value is Timing {
  return numbers(value, ['total_tokens', 'total_duration_seconds', 'total_cost_usd', 'turns']);
}

export function parseGrading(value: unknown, file: string): Grading {
  if (!isGrading(value)) {
    throw new Error(`${file} is not a grading in the grader's schema; grade the run again`);
  }

  return value;
}

export function parseTiming(value: unknown, file: string): Timing {
  if (!isTiming(value)) {
    throw new Error(`${file} is not a timing in the grader's schema; grade the run again`);
  }

  return value;
}

// Seconds and turns are each part's own; tokens and cost are running totals of the session every resume continues.
export function timing(outputs: readonly SlimOutput[]): Timing {
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const results = outputs.map(({ result }) => result);

  return {
    total_tokens: Math.max(0, ...results.map(tokens)),
    total_duration_seconds: Math.round(sum(outputs.map(({ ms }) => ms)) / 1000),
    total_cost_usd: Math.round(Math.max(0, ...results.map((result) => numberAt(result, 'total_cost_usd'))) * 100) / 100,
    turns: sum(results.map((result) => numberAt(result, 'num_turns'))),
  };
}

// The verdict files of the first, second and third judge of a run.
export const judgeFiles = ['llm-grades.json', 'llm-grades-2.json', 'llm-grades-3.json'] as const;

// A run folder holds `outputs/*.json` (run-slim `--out` files: the run and each resume), a verdict file per judge
// that has graded it, and sits in its eval folder beside `eval_metadata.json`.
export function gradeRunDir(runDir: string, projects: string): void {
  const names = readdirSync(join(runDir, 'outputs'))
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => (left === 'result.json' ? -1 : right === 'result.json' ? 1 : left.localeCompare(right)));
  const outputs = names.map((name) => slimOutput(readJson(join(runDir, 'outputs', name))));
  const finals = outputs.map(({ result: { result } }, index) => {
    return `## ${names[index] ?? ''}\n\n${typeof result === 'string' ? result : '(no result: the session printed none)'}\n`;
  });
  const metadata = readJson(join(evalFolderOf(runDir), 'eval_metadata.json'));
  const assertions = listed(
    isRecord(metadata) ? metadata['assertions'] : undefined,
    isAssertion,
    'eval_metadata.json assertions',
  );
  const judges = judgeFiles
    .map((name) => join(runDir, name))
    .filter((file) => existsSync(file))
    .map((file) => listed(readJson(file), isExpectation, file));
  const sessions = new Map(
    outputs.flatMap(({ cwd, result }) => {
      const session = result['session_id'];

      return typeof session === 'string' && cwd !== null ? [[`${cwd}\0${session}`, { cwd, session }] as const] : [];
    }),
  );
  const calls = [...sessions.values()].flatMap(({ cwd, session }) =>
    sessionTranscripts(projects, cwd, session).flatMap(({ agent, file }) => {
      if (!existsSync(file)) {
        throw new Error(`no transcript for session ${session} at ${file}`);
      }

      return toolCalls(readFileSync(file, 'utf8').split('\n').filter(Boolean), agent);
    }),
  );

  // The judge reads the calls, not the transcripts: a tend transcript runs to megabytes.
  const callLines = calls.map((call, index) =>
    JSON.stringify({ index: index + 1, ...call, result: call.result.slice(0, 2000) }),
  );

  writeFileSync(join(runDir, 'outputs', 'final.md'), finals.join('\n'));
  writeFileSync(join(runDir, 'outputs', 'calls.jsonl'), callLines.map((line) => `${line}\n`).join(''));
  writeFileSync(join(runDir, 'timing.json'), `${JSON.stringify(timing(outputs), null, 2)}\n`);
  const unfinished = assertions.map(({ text }) => ({
    text,
    passed: false,
    evidence: 'The session printed no result: it timed out or crashed.',
  }));
  const graded = sessions.size === 0 ? grading([], unfinished, [unfinished]) : grading(calls, assertions, judges);
  writeFileSync(join(runDir, 'grading.json'), `${JSON.stringify(graded, null, 2)}\n`);
}

// node tools/evals/eval-grade.ts <run dir>...: grades each run folder against the transcripts in ~/.claude/projects.
// Stryker disable all: the command line has no unit tests; it reads Claude Code's own transcript folder
if (isMainModule(import.meta.url)) {
  for (const runDir of process.argv.slice(2)) {
    gradeRunDir(runDir, join(homedir(), '.claude', 'projects'));
  }
}
