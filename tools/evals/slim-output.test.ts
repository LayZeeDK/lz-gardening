import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slimOutput } from './slim-output.ts';

test('slimOutput takes the session id from the init line when the session was stopped before its result line', () => {
  const stopped = {
    cwd: 'S:/sample',
    ms: 5,
    stdout: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's9' }), 'not json'].join('\n'),
  };

  assert.deepEqual(slimOutput(stopped), { cwd: 'S:/sample', ms: 5, result: {}, session: 's9' });
});
