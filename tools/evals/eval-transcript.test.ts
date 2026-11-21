import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sessionTranscripts, toolCalls } from './eval-transcript.ts';

function projectsWith(cwd: string, session: string, agents: readonly { id: string; agentType: string }[]): string {
  const projects = mkdtempSync(join(tmpdir(), 'eval-transcript-'));
  const folder = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(join(folder, session, 'subagents'), { recursive: true });
  writeFileSync(join(folder, `${session}.jsonl`), '');

  for (const { id, agentType } of agents) {
    writeFileSync(join(folder, session, 'subagents', `agent-${id}.jsonl`), '');
    writeFileSync(join(folder, session, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType }));
  }

  return projects;
}

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

function toolUse(id: string, name: string, input: unknown): string {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id: string, content: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...extra,
  });
}

test('a tool call is paired with its result', () => {
  const lines = [toolUse('t1', 'Bash', { command: 'node --version' }), toolResult('t1', 'v26.13.0')];

  assert.deepEqual(toolCalls(lines, 'main'), [
    {
      agent: 'main',
      name: 'Bash',
      input: { command: 'node --version' },
      result: 'v26.13.0',
      isError: false,
      denied: false,
    },
  ]);
});

test('a call is read once, not again from the request blob that repeats its message', () => {
  const block = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --version' } };
  const message = { role: 'assistant', content: [block] };
  const lines = [
    line({ type: 'assistant', message }),
    line({ type: 'api-request-blob', message }),
    toolResult('t1', 'v26.13.0'),
  ];

  assert.deepEqual(
    toolCalls(lines, 'main').map(({ name, result }) => [name, result]),
    [['Bash', 'v26.13.0']],
  );
});

test('a call the permission rules rejected is denied and an error', () => {
  const lines = [
    toolUse('t1', 'Read', { file_path: 'D:/elsewhere/weeds.ts' }),
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'no', is_error: true }] },
      permissionDecision: { decision: 'reject', source: 'config', reasonCode: 'workingDir' },
    }),
  ];

  assert.deepEqual(
    toolCalls(lines, 'main').map(({ isError, denied }) => ({ isError, denied })),
    [{ isError: true, denied: true }],
  );
});

test("a session's transcripts are its own file and each subagent's, named by agent type", () => {
  const cwd = 'D:\\projects\\sandbox\\lz-node-test-seed8-a-sonnet-sample';
  const projects = projectsWith(cwd, 's1', [{ id: 'a1', agentType: 'lz-gardening:lz-gardener' }]);
  const folder = join(projects, 'D--projects-sandbox-lz-node-test-seed8-a-sonnet-sample');

  assert.deepEqual(sessionTranscripts(projects, cwd, 's1'), [
    { agent: 'main', file: join(folder, 's1.jsonl') },
    { agent: 'lz-gardening:lz-gardener', file: join(folder, 's1', 'subagents', 'agent-a1.jsonl') },
  ]);
});

test('a tool call the session never got a result for, as when it was stopped, has an empty result', () => {
  const [call] = toolCalls([toolUse('t1', 'Bash', { command: 'node --test' })], 'main');

  assert.deepEqual(call, {
    agent: 'main',
    name: 'Bash',
    input: { command: 'node --test' },
    result: '',
    isError: false,
    denied: false,
  });
});
