// @ts-check
// The site and census tests build git repositories (about a minute a run each), so mutate one script at a time
// against its own tests:
//   npm exec -- nx mutate-weeds tometo      (one mutate-<script> target per script; mutate runs them all)
// A script split into modules mutates each of them: MUTATE=store mutates store-git.ts, store-log.ts and the rest.
// The command runner reruns every test of the script for every mutant. With LZ_NODE_TEST_RUNNER set to the source
// entry of an @layzee/stryker-node-test-runner checkout, Stryker runs per mutant only the tests that cover it, and
// the checkout's Node.js and numeric-literal mutators run beside Stryker's own:
//   LZ_NODE_TEST_RUNNER=<checkout>/packages/stryker-node-test-runner/src/index.ts MUTATE=weeds \
//     node --conditions=@layzee/source node_modules/@stryker-mutator/core/bin/stryker.js run
// While iterating with that runner, add --incremental (and --mutate "<file>:<from>-<to>" for the changed lines) to
// rerun only the mutants whose code or covering tests changed. Run once without it before calling a change done: an
// incremental run copies older results into the report, and it misses changes to test utilities, fixtures and config.
import { globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { MUTATE: script = '*', LZ_NODE_TEST_RUNNER: nodeTestRunner } = process.env;
const scripts = 'plugins/tometo/skills/*/scripts';
const testFiles = `${scripts}/${script}*.test.ts`;
const mutated = [`${scripts}/${script}.ts`, `${scripts}/${script}-*.ts`];
const notMutated = [`${scripts}/*.test.ts`, `${scripts}/test-*.ts`];

// A MUTATE that names no script would mutate nothing, and a run with no mutants passes the 100% threshold.
if (globSync(mutated, { exclude: notMutated }).length === 0) {
  throw new Error(`MUTATE=${script} names no script in ${scripts}`);
}

if (nodeTestRunner !== undefined) {
  const packages = new URL('../../', pathToFileURL(nodeTestRunner));
  const { lzNodeMutators } = await import(new URL('stryker-node-mutators/src/index.ts', packages).href);
  const { lzJsMutators } = await import(new URL('stryker-js-mutators/src/index.ts', packages).href);

  await lzNodeMutators();
  await lzJsMutators({ LzJsNumericLiteral: true });
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const runner =
  nodeTestRunner === undefined
    ? { testRunner: 'command', commandRunner: { command: `node --test "${testFiles}"` } }
    : {
        testRunner: 'lz-node-test',
        appendPlugins: [nodeTestRunner],
        lzNodeTest: { testFiles: [testFiles] },
        coverageAnalysis: 'perTest',
        incrementalFile: `reports/stryker-incremental/${script === '*' ? 'all' : script}.json`,
      };

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...runner,
  checkers: ['typescript'],
  tsconfigFile: 'plugins/tometo/tsconfig.json',
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: { high: 100, low: 100, break: 100 },
  mutate: [...mutated, ...notMutated.map((glob) => `!${glob}`)],
};

export default config;
