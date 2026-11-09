// @ts-check
// The site and census tests build git repositories (about a minute a run each), so mutate one script at a time
// against its own tests:
//   MUTATE=weeds npm run test:mutation      (weeds, site or census; every script when unset)
// The command runner reruns every test of the script for every mutant. With LZ_NODE_TEST_RUNNER set to the source
// entry of an @layzee/stryker-node-test-runner checkout, Stryker runs per mutant only the tests that cover it:
//   LZ_NODE_TEST_RUNNER=<checkout>/packages/stryker-node-test-runner/src/index.ts MUTATE=weeds \
//     node --conditions=@layzee/source node_modules/@stryker-mutator/core/bin/stryker.js run
const { MUTATE: script = '*', LZ_NODE_TEST_RUNNER: nodeTestRunner } = process.env;
const testFiles = `plugins/lz-gardening/skills/*/scripts/${script}*.test.ts`;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const runner =
  nodeTestRunner === undefined
    ? { testRunner: 'command', commandRunner: { command: `node --test "${testFiles}"` } }
    : {
        testRunner: 'lz-node-test',
        appendPlugins: [nodeTestRunner],
        lzNodeTest: { testFiles: [testFiles] },
        coverageAnalysis: 'perTest',
      };

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...runner,
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
