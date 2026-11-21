// Grades one eval run: `timing.json` from its slim `claude -p` output files, `grading.json` in skill-creator's schema
// (`expectations` of `{text, passed, evidence}`, `summary`, `execution_metrics`) from the script checks and the LLM
// judge's verdicts. Repository-only; nothing here ships with the plugin.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { checks } from './eval-checks.ts';
import { sessionTranscripts, toolCalls, type ToolCall } from './eval-transcript.ts';

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

// The session's last `result` line of a run-slim `--out` file, or an empty record when the session printed none.
export function resultLine(output: unknown): Readonly<Record<string, unknown>> {
  const stdout = isRecord(output) && typeof output['stdout'] === 'string' ? output['stdout'] : '';
  const results = stdout
    .split('\n')
    .flatMap((line): unknown[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((entry) => isRecord(entry) && entry['type'] === 'result');
  const last: unknown = results.at(-1);

  return isRecord(last) ? last : {};
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

export interface Assertion {
  readonly text: string;
  readonly check?: string;
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

// skill-creator's aggregate_benchmark.py takes tokens from timing.json only when grading.json has no `timing`, so
// grading.json carries none.
export function grading(
  calls: readonly ToolCall[],
  assertions: readonly Assertion[],
  judged: readonly Expectation[],
): Grading {
  const graded = assertions.map(
    (assertion) => scripted(calls, assertion) ?? judged.find(({ text }) => text === assertion.text),
  );
  const expectations = graded.filter((expectation) => expectation !== undefined);
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
      needs_review: assertions
        .filter((_, index) => graded[index] === undefined)
        .map(({ text }) => `not judged: ${text}`),
      workarounds: [],
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isExpectation(value: unknown): value is Expectation {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    typeof value['passed'] === 'boolean' &&
    typeof value['evidence'] === 'string'
  );
}

function isAssertion(value: unknown): value is Assertion {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    (value['check'] === undefined || typeof value['check'] === 'string')
  );
}

function listed<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  if (!Array.isArray(value) || !value.every(guard)) {
    throw new Error(`${what} is not a list of the expected records`);
  }

  return value;
}

// A run folder holds `outputs/*.json` (run-slim `--out` files: the run and each resume), `llm-grades.json` when the
// judge has graded it, and sits two levels below its eval folder's `eval_metadata.json`.
export function gradeRunDir(runDir: string, projects: string): void {
  const names = readdirSync(join(runDir, 'outputs'))
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => (left === 'result.json' ? -1 : right === 'result.json' ? 1 : left.localeCompare(right)));
  const outputs = names.map((name) => readJson(join(runDir, 'outputs', name)));
  const finals = outputs.map((output, index) => {
    const result = resultLine(output)['result'];

    return `## ${names[index] ?? ''}\n\n${typeof result === 'string' ? result : '(no result: the session printed none)'}\n`;
  });
  const metadata = readJson(join(runDir, '..', '..', 'eval_metadata.json'));
  const assertions = listed(
    isRecord(metadata) ? metadata['assertions'] : undefined,
    isAssertion,
    'eval_metadata.json assertions',
  );
  const grades = join(runDir, 'llm-grades.json');
  const judged = existsSync(grades) ? listed(readJson(grades), isExpectation, 'llm-grades.json') : [];
  const sessions = new Map(
    outputs.flatMap((output) => {
      const session = resultLine(output)['session_id'];
      const cwd = isRecord(output) ? output['cwd'] : undefined;

      return typeof session === 'string' && typeof cwd === 'string'
        ? [[`${cwd}\0${session}`, { cwd, session }] as const]
        : [];
    }),
  );
  const calls = [...sessions.values()].flatMap(({ cwd, session }) =>
    sessionTranscripts(projects, cwd, session).flatMap(({ agent, file }) =>
      existsSync(file) ? toolCalls(readFileSync(file, 'utf8').split('\n').filter(Boolean), agent) : [],
    ),
  );

  // The judge reads the calls, not the transcripts: a tend transcript runs to megabytes.
  const callLines = calls.map((call, index) =>
    JSON.stringify({ index: index + 1, ...call, result: call.result.slice(0, 2000) }),
  );

  writeFileSync(join(runDir, 'outputs', 'final.md'), finals.join('\n'));
  writeFileSync(join(runDir, 'outputs', 'calls.jsonl'), callLines.map((line) => `${line}\n`).join(''));
  writeFileSync(join(runDir, 'timing.json'), `${JSON.stringify(timing(outputs), null, 2)}\n`);
  writeFileSync(join(runDir, 'grading.json'), `${JSON.stringify(grading(calls, assertions, judged), null, 2)}\n`);
}

// node tools/evals/eval-grade.ts <run dir>...: grades each run folder against the transcripts in ~/.claude/projects.
if (isMainModule(import.meta.url)) {
  for (const runDir of process.argv.slice(2)) {
    gradeRunDir(runDir, join(homedir(), '.claude', 'projects'));
  }
}

export function timing(outputs: readonly unknown[]): Timing {
  const results = outputs.map(resultLine);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

  return {
    total_tokens: sum(results.map(tokens)),
    total_duration_seconds: Math.round(
      sum(outputs.map((output) => (isRecord(output) ? numberAt(output, 'ms') : 0))) / 1000,
    ),
    total_cost_usd: Math.round(sum(results.map((result) => numberAt(result, 'total_cost_usd'))) * 100) / 100,
    turns: sum(results.map((result) => numberAt(result, 'num_turns'))),
  };
}
