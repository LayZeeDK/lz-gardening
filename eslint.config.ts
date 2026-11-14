import nx from '@nx/eslint-plugin';
import * as jsoncParser from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.claude/worktrees/**', '.scratch/**', '.stryker-tmp/**', 'reports/**'] },
  {
    files: ['plugins/lz-gardening/skills/*/scripts/**/*.ts', 'tools/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
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
    },
  },
  {
    files: ['plugins/lz-gardening/skills/*/scripts/**/*.ts', 'tools/**/*.ts'],
    ignores: ['plugins/lz-gardening/skills/lz-garden/scripts/log.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration[id.name="isRecord"], VariableDeclarator[id.name="isRecord"]',
          message:
            'isRecord is defined once, in lz-garden/scripts/log.ts: import { isRecord } from it instead of redefining it.',
        },
      ],
    },
  },
  {
    files: ['plugins/lz-gardening/skills/*/scripts/**/*.ts', 'tools/**/*.ts'],
    plugins: { '@nx': nx },
    rules: { '@nx/workspace-shared-console-spawn': 'error' },
  },
  {
    files: ['plugins/*/package.json'],
    languageOptions: { parser: jsoncParser },
    plugins: { '@nx': nx },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['lint'],
          ignoredFiles: ['{projectRoot}/**/*.test.ts', '{projectRoot}/**/test-*.ts'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          includeTransitiveDependencies: false,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSONProperty[key.value=/^(dependencies|optionalDependencies|peerDependencies)$/] > JSONObjectExpression > JSONProperty > JSONLiteral.value[value!=/^\\d+\\.\\d+\\.\\d+$/]',
          message: 'Pin the exact version (npm install --save-exact): the plugin ships the version its lockfile holds.',
        },
      ],
    },
  },
);
