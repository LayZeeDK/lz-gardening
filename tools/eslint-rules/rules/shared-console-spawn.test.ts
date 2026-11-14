import { RuleTester } from '@typescript-eslint/rule-tester';
import assert from 'node:assert/strict';
import { after, describe, it, test } from 'node:test';
import { rule, ruleName } from './shared-console-spawn.ts';

RuleTester.afterAll = after;
RuleTester.describe = (text, callback) => {
  describe(text, callback);
};
RuleTester.it = (text, callback) => {
  it(text, callback);
};
RuleTester.itOnly = (text, callback) => {
  it(text, { only: true }, callback);
};

new RuleTester().run(ruleName, rule, {
  valid: [
    `spawnSync('git', ['--version'], { encoding: 'utf8' });`,
    `spawn('node', ['server.js'], { detached: false });`,
    `create({ messages: { windowsHide: 'text', detached: 'text' } });`,
  ],
  invalid: [
    {
      code: `spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });`,
      errors: [{ messageId: 'windowsHide', line: 1, column: 53 }],
    },
    {
      code: `spawn('node', ['server.js'], { detached: true, stdio: 'ignore' });`,
      errors: [{ messageId: 'detached', line: 1, column: 32 }],
    },
    {
      code: `spawn('node', ['server.js'], { detached, stdio: 'ignore' });`,
      errors: [{ messageId: 'detached', line: 1, column: 32 }],
    },
  ],
});

test('the rule is a problem whose reports name the cost and the fix', () => {
  assert.equal(rule.meta.type, 'problem');
  assert.match(rule.meta.docs?.description ?? '', /share the console/);
  assert.match(rule.meta.messages.windowsHide, /extra conhost\.exe per spawn.*Remove it/);
  assert.match(rule.meta.messages.detached, /opens a window.*windowsHide: true/);
});
