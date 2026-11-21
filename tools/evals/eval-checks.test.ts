import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checks } from './eval-checks.ts';
import type { ToolCall } from './eval-transcript.ts';

function call(name: string, input: unknown, outcome: Partial<ToolCall> = {}): ToolCall {
  return { agent: 'lz-gardening:lz-gardener', name, input, result: '', isError: false, denied: false, ...outcome };
}

function run(id: string, calls: readonly ToolCall[]): { passed: boolean; evidence: string } {
  const check = checks[id];
  assert.ok(check, `no check ${id}`);

  return check(calls);
}

test('no-denials fails on a call the permission rules rejected and names it', () => {
  const calls = [
    call('Bash', { command: 'node --version' }),
    call('Read', { file_path: 'D:/x/weeds.ts' }, { denied: true }),
  ];

  assert.deepEqual(run('no-denials', calls), {
    passed: false,
    evidence: '1 denied: Read {"file_path":"D:/x/weeds.ts"}',
  });
});

function weeds(args: string): ToolCall {
  return call('Bash', { command: `node "D:/plugin/skills/lz-garden/scripts/weeds.ts" ${args}` });
}

test('decline-reads-lines fails on a decline of a pattern class no weeds lines of that class came before', () => {
  const calls = [
    weeds('lines --class eslint-disable --census abc'),
    weeds('decline --class console-call --where a.ts --reason "a log" --census abc --read 0123456789ab'),
  ];

  assert.deepEqual(run('decline-reads-lines', calls), {
    passed: false,
    evidence: '1 of 1 declines unread: console-call (no weeds lines --class console-call before it)',
  });
});

test('decline-reads-lines fails on a decline without --read and passes one read first, duplicate-function aside', () => {
  const calls = [
    weeds('lines --class console-call --census abc'),
    weeds('decline --class console-call --where a.ts --reason "a log" --census abc --read 0123456789ab'),
    weeds('decline --class console-call --where b.ts --reason "a log" --census abc'),
    weeds('decline --class duplicate-function --where c.ts --reason "own job" --census abc'),
  ];

  assert.deepEqual(run('decline-reads-lines', calls), {
    passed: false,
    evidence: '1 of 2 declines unread: console-call (no --read)',
  });
});

test('census-taken passes on a census.ts --rev that exited 0 and fails when each one failed', () => {
  const census = call('Bash', { command: 'node "D:/plugin/skills/lz-garden/scripts/census.ts" --rev main' });

  assert.deepEqual(
    [
      run('census-taken', [{ ...census, isError: true, result: 'Exit code 2\nno site' }]),
      run('census-taken', [census]),
    ],
    [
      { passed: false, evidence: '0 of 1 census.ts --rev runs exited 0' },
      { passed: true, evidence: '1 of 1 census.ts --rev runs exited 0' },
    ],
  );
});

test('tend-closed passes on a close-class that printed closed and fails when none did', () => {
  const refused = weeds('close-class --class console-call --bed abc1234 --check eslint.config.mjs');
  const closed = { ...refused, result: 'closed 4; synced' };

  assert.deepEqual(
    [
      run('tend-closed', [{ ...refused, isError: true, result: 'Exit code 1\nw1 is in no baseline' }]),
      run('tend-closed', [closed]),
    ],
    [
      { passed: false, evidence: 'no close-class printed closed; last: Exit code 1 w1 is in no baseline' },
      { passed: true, evidence: 'closed 4; synced' },
    ],
  );
});

test('garden-commands counts a script call chained, piped or redirected outside its quoted arguments as outside', () => {
  const site = 'node "D:/plugin/skills/lz-garden/scripts/site.ts" open';
  const calls = [
    weeds("decline --class c --where a.ts --reason 'a | b; c > d' --census abc --read t"),
    call('Bash', { command: `cd D:/sample && ${site}` }),
    call('Bash', { command: `${site} | head` }),
    call('Bash', { command: `${site} 2> err.txt` }),
  ];

  assert.deepEqual(run('garden-commands', calls), {
    passed: false,
    evidence: `3 outside the tick: ${calls
      .slice(1)
      .map((outside) => `Bash ${JSON.stringify(outside.input)}`)
      .join('; ')}`,
  });
});

test('garden-commands fails on a command lz-garden does not run and on a file write, and names each', () => {
  const calls = [
    call('Bash', { command: 'node --version' }),
    weeds('decline --class console-call --where a.ts --reason "logs; then | more" --census abc --read t'),
    call('Bash', { command: 'git show main:src/a.ts' }),
    call('Bash', { command: 'git log --no-merges --format=%h%x20%s -n 300 main' }),
    call('Bash', { command: 'rg console src' }),
    call('Bash', { command: 'git show main:a.ts > a.txt' }),
    call('Edit', { file_path: 'src/a.ts' }),
    call('Grep', { pattern: 'console' }),
  ];

  assert.deepEqual(run('garden-commands', calls), {
    passed: false,
    evidence:
      '3 outside the tick: Bash {"command":"rg console src"}; Bash {"command":"git show main:a.ts > a.txt"}; Edit {"file_path":"src/a.ts"}',
  });
});
