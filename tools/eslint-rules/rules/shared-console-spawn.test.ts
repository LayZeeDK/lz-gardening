import { RuleTester } from '@typescript-eslint/rule-tester';
import { after, describe, it } from 'node:test';
import { rule, RULE_NAME } from './shared-console-spawn.ts';

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

new RuleTester().run(RULE_NAME, rule, {
  valid: [`const example = true;`],
  invalid: [],
});
