// Reads the tool calls of a Claude Code session transcript (`<session>.jsonl`, one JSON entry per line) for the eval
// grader. Repository-only; nothing here ships with the plugin.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

export interface ToolCall {
  readonly agent: string;
  readonly name: string;
  readonly input: unknown;
  readonly result: string;
  readonly isError: boolean;
  readonly denied: boolean;
}

interface Block {
  readonly block: Readonly<Record<string, unknown>>;
  readonly entry: Readonly<Record<string, unknown>>;
}

function blocks(lines: readonly string[]): Block[] {
  return lines.flatMap((line) => {
    const entry: unknown = JSON.parse(line);
    const message = isRecord(entry) ? entry['message'] : undefined;
    const content = isRecord(message) ? message['content'] : undefined;

    return isRecord(entry) && Array.isArray(content)
      ? content.filter((block) => isRecord(block)).map((block) => ({ block, entry }))
      : [];
  });
}

function text(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export interface Transcript {
  readonly agent: string;
  readonly file: string;
}

// Claude Code names a project's transcript folder after its working directory, every character other than a letter or
// digit turned into `-`; a forked agent's transcript sits in `<session>/subagents/` beside a `.meta.json` naming it.
export function sessionTranscripts(projects: string, cwd: string, session: string): Transcript[] {
  const folder = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const subagents = join(folder, session, 'subagents');
  const agents = existsSync(subagents) ? readdirSync(subagents).filter((name) => name.endsWith('.jsonl')) : [];

  return [
    { agent: 'main', file: join(folder, `${session}.jsonl`) },
    ...agents.sort().map((name) => {
      const meta: unknown = JSON.parse(readFileSync(join(subagents, name.replace(/\.jsonl$/, '.meta.json')), 'utf8'));

      return { agent: String(isRecord(meta) ? meta['agentType'] : name), file: join(subagents, name) };
    }),
  ];
}

export function toolCalls(lines: readonly string[], agent: string): ToolCall[] {
  const all = blocks(lines);
  const results = new Map(
    all.filter(({ block }) => block['type'] === 'tool_result').map((found) => [found.block['tool_use_id'], found]),
  );

  return all
    .filter(({ block }) => block['type'] === 'tool_use')
    .map(({ block }) => {
      const found = results.get(block['id']);
      const decision = found?.entry['permissionDecision'];

      return {
        agent,
        name: String(block['name']),
        input: block['input'],
        result: text(found?.block['content']),
        isError: found?.block['is_error'] === true,
        denied: isRecord(decision) && decision['decision'] === 'reject',
      };
    });
}
