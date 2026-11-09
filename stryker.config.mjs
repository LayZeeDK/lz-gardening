// @ts-check
// The command runner reruns its whole command for every mutant, and the site and census tests build git repositories
// (about a minute a run each), so mutate one script at a time against its own tests:
//   MUTATE=weeds npm run test:mutation      (weeds, site or census; every script when unset)
const { MUTATE: script = '*' } = process.env;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'command',
  commandRunner: { command: `node --test "plugins/lz-gardening/skills/*/scripts/${script}*.test.ts"` },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: { high: 100, low: 100, break: 100 },
  mutate: [
    `plugins/lz-gardening/skills/*/scripts/${script}.ts`,
    '!plugins/lz-gardening/skills/*/scripts/*.test.ts',
    '!plugins/lz-gardening/skills/*/scripts/test-*.ts',
  ],
};

export default config;
