// The eval cases' script assertions: each reads a run's tool calls (every agent of the session) and returns whether it
// held, with the calls that show it. Repository-only; nothing here ships with the plugin.
import { isRecord } from '../../plugins/tometo/skills/garden/scripts/log-guard.ts';
import type { ToolCall } from './eval-transcript.ts';

export interface CheckResult {
  readonly passed: boolean;
  readonly evidence: string;
}

export type Check = (calls: readonly ToolCall[]) => CheckResult;

function described(call: ToolCall): string {
  return `${call.name} ${JSON.stringify(call.input)}`;
}

function noDenials(calls: readonly ToolCall[]): CheckResult {
  const denied = calls.filter((call) => call.denied);

  return {
    passed: denied.length === 0,
    evidence: `${String(denied.length)} denied: ${denied.map(described).join('; ')}`,
  };
}

function command(call: ToolCall): string | undefined {
  const input: unknown = call.input;

  return call.name === 'Bash' && isRecord(input) && typeof input['command'] === 'string' ? input['command'] : undefined;
}

interface ScriptRun {
  readonly script: string;
  readonly subcommand: string;
  readonly args: string;
}

function scriptRun(call: ToolCall): ScriptRun | undefined {
  const match = /scripts[\\/](site|census|weeds|diffs)\.ts"?\s+(\S+)(.*)$/s.exec(command(call) ?? '');

  return match ? { script: match[1] ?? '', subcommand: match[2] ?? '', args: match[3] ?? '' } : undefined;
}

function flag(args: string, name: string): string | undefined {
  return new RegExp(`--${name}\\s+(\\S+)`).exec(args)?.[1];
}

function declineReadsLines(calls: readonly ToolCall[]): CheckResult {
  const runs = calls.flatMap((call) => scriptRun(call) ?? []).filter(({ script }) => script === 'weeds');
  const read = new Set<string>();
  const unread: string[] = [];
  let declines = 0;

  for (const { subcommand, args } of runs) {
    const weedClass = flag(args, 'class') ?? '';

    if (subcommand === 'lines') {
      read.add(weedClass);
    } else if (subcommand === 'decline' && weedClass !== 'duplicate-function') {
      declines += 1;

      if (!read.has(weedClass)) {
        unread.push(`${weedClass} (no weeds lines --class ${weedClass} before it)`);
      } else if (flag(args, 'read') === undefined) {
        unread.push(`${weedClass} (no --read)`);
      }
    }
  }

  return {
    passed: unread.length === 0,
    evidence: `${String(unread.length)} of ${String(declines)} declines unread: ${unread.join('; ')}`,
  };
}

const fileWrites = new Set(['Edit', 'Write', 'NotebookEdit']);

const chained = /[|;&<>`]|\$\(/;

// A command's text with its literal quoted arguments taken out, which may hold any character. A double-quoted
// argument with a $ or a backtick stays, since bash still substitutes inside it.
function unquoted(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => {
    // Stryker disable next-line MethodExpression: every match ends with the quote it starts with
    const substituted = quoted.startsWith('"') && /[$`]/.test(quoted);

    // Stryker disable next-line StringLiteral: only the chain test reads the result, which no text without a chain character trips
    const literal = '';

    return substituted ? quoted : literal;
  });
}

// The garden skill's allowed-tools and its read-only git forms, each one command with no chain, pipe or redirect.
function inTick(call: ToolCall): boolean {
  const text = command(call);

  if (text === undefined) {
    return !fileWrites.has(call.name);
  }

  const allowed =
    (/^node /.test(text) && scriptRun(call) !== undefined) || /^git (ls-tree|rev-parse|log|show) /.test(text);

  return text === 'node --version' || (allowed && !chained.test(unquoted(text)));
}

function gardenCommands(calls: readonly ToolCall[]): CheckResult {
  const outside = calls.filter((call) => !inTick(call));

  return {
    passed: outside.length === 0,
    evidence: `${String(outside.length)} outside the tick: ${outside.map(described).join('; ')}`,
  };
}

function censusTaken(calls: readonly ToolCall[]): CheckResult {
  const runs = calls.filter((call) => {
    const run = scriptRun(call);

    return run?.script === 'census' && run.subcommand === '--rev';
  });
  const exited = runs.filter((call) => !call.isError).length;

  return { passed: exited > 0, evidence: `${String(exited)} of ${String(runs.length)} census.ts --rev runs exited 0` };
}

function tendClosed(calls: readonly ToolCall[]): CheckResult {
  const closes = calls.filter((call) => scriptRun(call)?.subcommand === 'close-class');
  const closed = closes.find((call) => /^closed \d+;/m.test(call.result));
  const last = closes.at(-1)?.result.replace(/\s+/g, ' ').trim() ?? 'none ran';

  return closed
    ? { passed: true, evidence: /^closed \d+;.*$/m.exec(closed.result)?.[0] ?? '' }
    : { passed: false, evidence: `no close-class printed closed; last: ${last}` };
}

export const checks: Readonly<Record<string, Check>> = {
  'no-denials': noDenials,
  'decline-reads-lines': declineReadsLines,
  'garden-commands': gardenCommands,
  'tend-closed': tendClosed,
  'census-taken': censusTaken,
};
