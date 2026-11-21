import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitStopped, slimOutput } from './slim-output.ts';

test('slimOutput takes the session id from the init line when the session was stopped before its result line', () => {
  const stopped = {
    cwd: 'S:/sample',
    ms: 5,
    stdout: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's9' }), 'not json'].join('\n'),
  };

  assert.deepEqual(slimOutput(stopped), { cwd: 'S:/sample', ms: 5, result: {}, session: 's9' });
});

test('limitStopped tells a session the usage limit ended at once from one that reported its work', () => {
  const ended = (text: string): ReturnType<typeof slimOutput> =>
    slimOutput({ stdout: JSON.stringify({ type: 'result', is_error: false, result: text }) });

  assert.deepEqual(
    [
      limitStopped(ended("You've hit your 5-hour limit · resets 3:30pm (Europe/Copenhagen)")),
      limitStopped(ended('garden: seeded main at aa3bc1b')),
    ],
    [true, false],
  );
});

test('slimOutput takes the last result line and session id, and no cwd or time from a file without them', () => {
  const result = (session: string): string => JSON.stringify({ type: 'result', session_id: session, result: session });

  assert.deepEqual(slimOutput({ stdout: [result('s1'), result('s2')].join('\n') }), {
    cwd: null,
    ms: 0,
    result: { type: 'result', session_id: 's2', result: 's2' },
    session: 's2',
  });
});
