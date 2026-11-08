# Checks

Read in a tend pass when choosing the check for a class. Rows name checks that commonly hold a class, strongest
layer first. Check the repository's installed versions before relying on a rule or flag; prefer what is installed
over adding a dependency, and the tool's own way over a custom one.

A good check prints a message that names the fix ("use `isRecord` from `@app/util`"), so the next agent that trips
it learns the paved road from the error, not from a document.

## Any codebase (layer 1)

| Class                                       | Change the codebase                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duplicate-helper`, `second-implementation` | Keep one implementation in the place every caller can import, delete the others, then ban redefinition (ESLint `no-restricted-syntax` on `FunctionDeclaration[id.name="<name>"]` outside the owning file, message naming the import). |
| `copied-workaround`                         | Fix the root cause the workaround hides, delete every copy. When the cause is outside the repository (a dependency bug), move the workaround into one named helper and ban the raw form.                                              |
| `dead-code`                                 | Delete it. Knip or the compiler's unused checks keep it gone.                                                                                                                                                                         |
| `speculative-abstraction`                   | Inline it into its one caller or implementation and delete the layer. Rarely lint-able; deleting every example is what stops the copying.                                                                                             |
| `reinvented-stdlib`                         | Replace it with the built-in and delete the helper or dependency, then ban the import (`no-restricted-imports` with a message naming the built-in).                                                                                   |
| `boundary-breach`                           | Make the boundary a rule: Nx module boundaries, ESLint `no-restricted-imports` with a message, or a package `exports` map that hides internals.                                                                                       |
| `repeated-lesson`                           | Find the class the lesson is about and tend that class; the lesson itself is the evidence.                                                                                                                                            |

## TypeScript and ESLint (layer 2)

| Class                                                   | Check                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `any-type`                                              | `@typescript-eslint/no-explicit-any`, the `no-unsafe-*` family, compiler `strict`. At a boundary, a parser or type guard that narrows `unknown`.                                                                                                                       |
| `double-cast`                                           | `@typescript-eslint/consistent-type-assertions` with `assertionStyle: 'never'` (allows `as const`), plus the guard or parser that proves the type.                                                                                                                     |
| `ts-suppress`                                           | `@typescript-eslint/ban-ts-comment` (`ts-expect-error: 'allow-with-description'` at most).                                                                                                                                                                             |
| `eslint-disable`                                        | `linterOptions.reportUnusedDisableDirectives: 'error'`; the ESLint comments plugin's `require-description` and `no-unlimited-disable`. For a backlog, ESLint's bulk suppressions file (`--suppress-all`, then `--prune-suppressions`) is a baseline that only shrinks. |
| `defensive-noise`                                       | `@typescript-eslint/no-unnecessary-condition`, `no-unnecessary-type-assertion`, `prefer-optional-chain` only where the type allows it; `strictNullChecks` must be on for these to see anything.                                                                        |
| `swallowed-error`                                       | `no-empty` (with `allowEmptyCatch: false`), `@typescript-eslint/only-throw-error`, `no-restricted-syntax` on `CatchClause` bodies that only log.                                                                                                                       |
| `narrating-comment`, `style-drift`                      | Formatter in CI (`prettier --check`), naming via `@typescript-eslint/naming-convention`. Comments rarely have a rule; a census pattern in `.garden/patterns.json` for the narrating words keeps the count visible.                                                     |
| `prettier-ignore`, `coverage-ignore`, `stryker-disable` | ESLint `no-warning-comments` with those terms and `location: 'anywhere'`, or a census pattern whose count only shrinks.                                                                                                                                                |

## Tests (layer 2)

| Class                                              | Check                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focused-or-skipped-test`                          | Vitest: the Vitest ESLint plugin's `no-focused-tests`, `no-disabled-tests`. Playwright: `forbidOnly: !!process.env.CI` in the config and the Playwright ESLint plugin's `no-focused-test`, `no-skipped-test`. `node:test`: never pass `--test-only` in CI. |
| `hollow-assertion`, `hollow-test`                  | Lint: `expect-expect` and `valid-expect` (Vitest and Playwright plugins). Behaviour: mutation testing with StrykerJS on the changed files, `thresholds.break` set, incremental mode for speed; a test that kills no mutant is hollow.                      |
| `pinned-derived-value`                             | Replace the pinned value with the rule that derives it (assert the property, not the number), or compute the expected value from the same source in the test.                                                                                              |
| Playwright flake workarounds (`copied-workaround`) | The Playwright ESLint plugin's `no-wait-for-timeout`, `no-networkidle`, `prefer-web-first-assertions`, `missing-playwright-await`.                                                                                                                         |

## Nx (layers 1 and 2)

| Class                                      | Check                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `boundary-breach`                          | `@nx/enforce-module-boundaries` with project tags and `depConstraints`; `@nx/dependency-checks` for undeclared dependencies. |
| `second-implementation` of a project shape | A workspace generator, so the paved road is the command an agent runs.                                                       |
| `missing-check`                            | A target in `targetDefaults` (lint, typecheck, test) so every project gets it; `nx affected` in CI.                          |

## Angular (layer 2, fixed by migration)

| Class                          | Check, then the mechanical fix                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `angular-decorator-io`         | angular-eslint `prefer-signals` (inputs, queries) and `prefer-output-emitter-ref` where installed; fix with `ng generate @angular/core:signal-input-migration`, `output-migration`, `signal-queries-migration`. |
| `angular-structural-directive` | angular-eslint `template/prefer-control-flow`; fix with `ng generate @angular/core:control-flow`.                                                                                                               |
| `angular-ngmodule`             | angular-eslint `prefer-standalone`; fix with `ng generate @angular/core:standalone`.                                                                                                                            |

Run the migration in the bed, then the repository's checks; a migration's output is reviewed like any diff.

## Storybook (layer 2)

Stories that render but assert nothing are hollow tests for a component. The Storybook ESLint plugin keeps stories
well formed; interaction tests (play functions run by the Storybook test runner or its Vitest integration) make a
story a test that can fail.

## Records (layers 2 and 4)

| Class                | Check                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim-as-evidence`  | A verification step that runs the check and records its output, so "done" carries evidence. When the repository's workflow framework has a verification gate, use it; otherwise propose one in the report. |
| `rule-in-prose`      | Move the rule to the check that enforces it, then cut the prose to one line naming the check, or delete it.                                                                                                |
| `stale-verification` | Not tended here: refreshing a verification skill or feature map is its own job. Close with `--by "verification refresh"` once someone has done it.                                                         |

## Layer 3 (propose only)

When agents bypass a check (`--no-verify`, editing the lint config to pass, adding suppressions), the class needs a
guard on the agent itself: a hook that rejects the command or the edit, or a permission rule. Describe it in the
report, with the command or edit it would reject; a human decides and builds it.

Text injected when a session starts reaches only that session's main thread, not the subagents it spawns. A rule
that must reach every agent, subagents included, lives in a file every agent loads or arrives through a
subagent-start hook; say which in the proposal.
