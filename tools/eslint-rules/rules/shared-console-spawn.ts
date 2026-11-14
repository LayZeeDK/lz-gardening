import { ESLintUtils } from '@typescript-eslint/utils';

// Stryker disable next-line StringLiteral: eslint.config.ts enables the rule by this name, so any other name fails every lint run
export const ruleName = 'shared-console-spawn';

// Stryker disable next-line ArrowFunction: the docs URL only links the rule's file in an editor
export const rule = ESLintUtils.RuleCreator(() => import.meta.filename)({
  name: ruleName,
  meta: {
    type: 'problem',
    docs: {
      description: 'Child processes share the console of the process that starts them.',
    },
    schema: [],
    messages: {
      windowsHide:
        'windowsHide gives a child with piped stdio a hidden console of its own, an extra conhost.exe per spawn, and hides nothing where the parent has a console. Remove it.',
      detached:
        'A detached child has no console, so every console program it starts without windowsHide opens a window. Keep the child attached; if it must run detached, give the spawns in that program windowsHide: true and disable this rule, with the reason, here and on each windowsHide: true.',
    },
    defaultOptions: [],
  },
  create(context) {
    return {
      'CallExpression > ObjectExpression.arguments > Property[key.name="windowsHide"]:not([value.value=false])'(node) {
        context.report({ node, messageId: 'windowsHide' });
      },
      'CallExpression > ObjectExpression.arguments > Property[key.name="detached"]:not([value.value=false])'(node) {
        context.report({ node, messageId: 'detached' });
      },
    };
  },
});
