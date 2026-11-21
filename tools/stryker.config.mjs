// @ts-check
// Mutation testing for the eval tooling in tools/evals, one module at a time or all of them:
//   MUTATE=eval-grade npm exec -- nx mutate tools      (MUTATE names a module of tools/evals; unset, it takes all)
// Every tools/evals spec runs, since several specs cover modules other than their own. The command runner reruns
// them all for every mutant (about 4 seconds each). With LZ_NODE_TEST_RUNNER set to the source entry of an
// @layzee/stryker-node-test-runner checkout, Stryker runs per mutant only the tests that cover it, and the
// checkout's Node.js and numeric-literal mutators run beside Stryker's own, as the plugin's stryker.config.mjs does.
// A module's command-line section has no unit tests by design; a Stryker disable comment where the untested part
// starts says so.
import { globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { MUTATE: selected = '*', LZ_NODE_TEST_RUNNER: nodeTestRunner } = process.env;
const evals = 'tools/evals';
const testFiles = `${evals}/*.test.ts`;
const mutated = [`${evals}/${selected}.ts`];
const notMutated = [testFiles];

// A MUTATE that names no module would mutate nothing, and a run with no mutants reports no survivors.
if (globSync(mutated, { exclude: notMutated }).length === 0) {
  throw new Error(`MUTATE=${selected} names no module in ${evals}`);
}

if (nodeTestRunner !== undefined) {
  const packages = new URL('../../', pathToFileURL(nodeTestRunner));
  const { lzNodeMutators } = await import(new URL('stryker-node-mutators/src/index.ts', packages).href);
  const { lzJsMutators } = await import(new URL('stryker-js-mutators/src/index.ts', packages).href);

  await lzNodeMutators();
  await lzJsMutators({ LzJsNumericLiteral: true });
}

const name = selected === '*' ? 'all' : selected;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const runner =
  nodeTestRunner === undefined
    ? { testRunner: 'command', commandRunner: { command: `node --test "${testFiles}"` } }
    : {
        testRunner: 'lz-node-test',
        appendPlugins: [nodeTestRunner],
        lzNodeTest: { testFiles: [testFiles] },
        coverageAnalysis: 'perTest',
        incrementalFile: `reports/stryker-incremental/tools-evals-${name}.json`,
      };

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...runner,
  checkers: ['typescript'],
  tsconfigFile: 'tools/tsconfig.json',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: `reports/mutation/tools-evals-${name}.html` },
  thresholds: { high: 100, low: 90, break: null },
  mutate: [...mutated, ...notMutated.map((glob) => `!${glob}`)],
};

export default config;
