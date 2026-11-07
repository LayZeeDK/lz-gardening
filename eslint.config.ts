import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.stryker-tmp/**', 'reports/**'] },
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
);
