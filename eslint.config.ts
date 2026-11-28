import nx from '@nx/eslint-plugin';
import * as jsoncParser from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

const scriptsAndTools = ['plugins/tometo/skills/*/scripts/**/*.ts', 'tools/**/*.ts'];

export default tseslint.config(
  { ignores: ['node_modules/**', '.claude/worktrees/**', '.scratch/**', '.stryker-tmp/**', 'reports/**'] },
  {
    files: scriptsAndTools,
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { '@nx': nx },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', name: ['describe', 'it', 'suite', 'test'], package: 'node:test' },
          ],
        },
      ],
      '@nx/workspace-shared-console-spawn': 'error',
    },
  },
  {
    files: scriptsAndTools,
    ignores: ['plugins/tometo/skills/garden/scripts/log-guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration[id.name="isRecord"], VariableDeclarator[id.name="isRecord"]',
          message: 'isRecord is defined once, in garden/scripts/log-guard.ts: import it instead of redefining it.',
        },
      ],
    },
  },
  {
    files: ['plugins/tometo/skills/garden/scripts/log-guard.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration, ImportExpression, ExportAllDeclaration, ExportNamedDeclaration[source]',
          message:
            "log-guard.ts imports nothing: the workspace's Nx plugin loads it on every nx command, without the plugin's packages.",
        },
      ],
    },
  },
  {
    files: ['plugins/*/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nx },
    rules: {
      '@nx/dependency-checks': [
        'error',
        // The rule skips a project that has none of these targets.
        { buildTargets: ['lint'], ignoredFiles: ['{projectRoot}/**/*.test.ts', '{projectRoot}/**/test-*.ts'] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSONProperty[key.value=/^(dependencies|optionalDependencies|peerDependencies)$/] > JSONObjectExpression > JSONProperty > JSONLiteral.value[value!=/^\\d+\\.\\d+\\.\\d+(-[\\w.-]+)?$/]',
          message: 'Pin the exact version (npm install --save-exact): the plugin ships the version its lockfile holds.',
        },
      ],
    },
  },
);
