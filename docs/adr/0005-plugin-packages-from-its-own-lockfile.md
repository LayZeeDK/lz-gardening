# The plugin's npm packages come from its own lockfile, which a local Nx plugin adds to the project graph

Claude Code installs a marketplace plugin's packages only from a `package.json` and a matching `package-lock.json` in
the plugin's own folder, so the plugin keeps its runtime packages there and nowhere else. Nx builds its package nodes
from the root lockfile only, so `tools/nx/claude-plugin.ts` adds the plugin lockfile's packages to the project graph
and draws each import's edge to the version that lockfile holds. `@nx/dependency-checks` then checks the plugin
against the lockfile that ships, and a package is bumped in one place.

The local plugin also infers the plugin's `test`, `lockfile` and `mutate` targets, and one `mutate-<name>` target per
script name, where the modules a script is split into (`store-*.ts`) share their name's target. The `lockfile` target
fails when the dependency sections of `package.json` and of the lockfile's root entry are not equal, version specs
included. That is stricter than npm on purpose: Claude Code skips the install when the two "list different
dependencies", and an exact comparison is the reading of that message that never lets a skip through. `npm ci
--dry-run` alone passes two mismatches the target catches: a range the lockfile satisfies, and an extra lockfile
entry.

## Considered Options

- **Install under the plugin and mirror each package in the root `package.json`.** Every bump touches two files. The
  rule would read the mirror's version as installed, and its fixer takes the root range first, so `lint --fix` could
  write an old version back into the plugin.
- **The plugin as an npm workspace member, with its lockfile pruned from the root one.** One install, but a generator
  to own, `nx sync` after every package change, an npm cache warm enough for an offline prune in CI, and development
  that resolves root-only packages users never get.
- **A sync generator that writes the root mirror.** Keeps the mirror's churn and adds a sync check. The rule reads the
  graph, so feeding the graph directly removes the copy.

## Consequences

- Nx's own import analysis is off for the whole workspace (`analyzeSourceFiles: false`); the local plugin reads
  imports with TypeScript's `preProcessFile`. Nx's analysis resolved imports through `node_modules` and cached the
  result, so a graph built before an install or a bump kept reading the new package as unused until `nx reset` or a
  daemon restart.
- The repository has a second `node_modules`, under the plugin. The root `postinstall` fills it with a frozen install,
  so tests and `claude --plugin-dir` run on the layout Claude Code builds in its cache. `npm install <pkg>` at the root
  does not run `postinstall`; `npm ci` does.
- The plugin folder ships a `tsconfig.json` whose `extends` points outside the folder, so that Nx can infer the
  `typecheck` target. Claude Code is not known to read that file.
