# Weeds

Read before reading the first diff of a tick or a seed pass. Each class has an id (the `--class` value), how to
recognize it, and the layer that usually holds it.

A weed is a pattern an agent will copy. Agents imitate the nearest example and take the shortest path that
compiles, so one shortcut in a file becomes the template for the next ten. Queue what spreads or invites copying.
Leave out a one-off with a visible reason, code that is deliberately unusual and says why, and what a check in the
repository already rejects. A bug is not a weed: route it to the repository's normal review or issue flow.

## Layers

The strongest layer that can hold a fix, strongest first. `--layer` takes the number.

1. **Codebase**: architecture, module boundaries, one paved road, deleting the bad examples. The weed cannot be
   written.
2. **Static analysis**: types, compiler flags, lint rules, tests, CI gates. The weed cannot land.
3. **Agent guards**: hooks, permissions, tool settings. The weed cannot be typed by an agent. A gardener proposes
   these; a human builds them.
4. **Agent instructions**: `AGENTS.md`, `CLAUDE.md`, rules files. The agent is told.
5. **Skills and references**: loaded when a task matches. The agent is told sometimes.
6. **Style guide and human review**: a person notices.

A weed held only at layer 4 to 6 regrows whenever an agent misses the text. Prefer the lowest number that fits.

## Census classes

`scripts/patterns.json` finds these by text; the class id is the pattern id. A repository adds or overrides
patterns in the site's `.garden/patterns.json` (same shape).

| Class                                                                                    | Usual layer | Note                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint-disable`, `ts-suppress`, `prettier-ignore`, `coverage-ignore`, `stryker-disable` | 2           | Suppressions. The count should only shrink; each one left names its rule and a reason.                                                  |
| `any-type`, `double-cast`                                                                | 2           | A type the code could not prove. Usually a missing parser at a boundary or a missing type guard.                                        |
| `focused-or-skipped-test`, `hollow-assertion`                                            | 2           | Tests that hide failures or cannot fail.                                                                                                |
| `todo-marker`                                                                            | 6           | Deferred work. Queue a marker that names no trigger, owner or expiry for revisiting it: that is the one that rots.                      |
| `angular-decorator-io`, `angular-structural-directive`, `angular-ngmodule`               | 2           | Older Angular APIs where newer ones exist. Queue only when the repository already uses the newer API, so the old one is the second way. |
| `duplicate-helper`                                                                       | 1           | A function name defined in two or more files. Same name, same job: one shared helper. Same name, different jobs: a naming weed.         |

## Read classes

Only reading a diff finds these. Record what the code shows, not what you suspect.

| Class                     | Usual layer | Recognize by                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hollow-test`             | 2           | A test that passes whatever the code does: it asserts on a value it set up itself, only checks that a mock was called, catches its own failure, or asserts a constant. Ask: which bug would turn this test red? No answer means hollow.                                          |
| `pinned-derived-value`    | 2           | A test pins a value a machine derives (a hash, a generated count, a byte size, a timestamp, a snapshot of generated output) with no rule behind it. Each change breaks it and the next agent updates the number without looking.                                                 |
| `copied-workaround`       | 1           | The same workaround (a retry, a sleep, a timeout bump, a guard around a symptom) appears in a second place. The root cause is upstream of both.                                                                                                                                  |
| `second-implementation`   | 1           | New code does what an existing helper, service, component or pattern already does, in a new way. Name the existing one in the note.                                                                                                                                              |
| `swallowed-error`         | 2           | A `catch` that is empty, logs and continues, or returns a default; a `?? []` or `\|\| {}` fallback hiding a failure. Data or a failure goes missing quietly.                                                                                                                     |
| `defensive-noise`         | 2           | Checks for states the types already rule out: null checks on non-null values, `try` around code that cannot throw, optional chaining on required fields. Noise the next agent copies as house style.                                                                             |
| `narrating-comment`       | 2           | A comment that restates the code, narrates history ("added", "now", "previously", "fixed"), or talks to a reviewer.                                                                                                                                                              |
| `style-drift`             | 2           | Code inconsistent with the rest of its file or folder (naming, error style, import style, test layout) where a formatter or lint rule could hold the house style.                                                                                                                |
| `dead-code`               | 1           | An export nobody imports, a parameter nobody passes, a branch no input reaches, a file nothing loads. Agents copy dead code as if it were live.                                                                                                                                  |
| `speculative-abstraction` | 1           | Structure with nothing to vary: an interface with one implementation, a factory with one product, a wrapper that only delegates, a layer with one caller, an option nobody sets. Agents copy the ceremony into every new feature.                                                |
| `reinvented-stdlib`       | 1           | Hand-written code or an added dependency doing what the language's standard library or the platform already ships (date formatting, deep clone, UUIDs, debounce in a framework that has it). Name the built-in in the note.                                                      |
| `boundary-breach`         | 1           | An import across a boundary the architecture intends (a feature reaching into another feature's internals, server code in a client bundle, a library importing an app).                                                                                                          |
| `claim-as-evidence`       | 4           | A planning or progress record marks work done on an agent's own summary ("tests pass", "verified") with no command output, check run or artifact behind it.                                                                                                                      |
| `stale-verification`      | 5           | A change to routes, features or user flows in a repository that keeps a verification skill, control script or feature map, which the change did not update. Queue it; refreshing verification is a separate job, not a tend pass.                                                |
| `missing-check`           | 2           | A kind of check the repository lacks for its stack: no type-check in CI, no lint for TypeScript, no test runner on a package, no mutation testing where tests are hollow, no end-to-end path for a user flow. Queue once per kind, `--where` the config file that would hold it. |
| `rule-in-prose`           | 2           | A rule written in agent instructions or a style guide (layers 4 to 6) that a type, lint rule or test could enforce, and that the code already breaks somewhere. `--where` the place it is broken; `--source lesson:<file>:<line>` the rule.                                      |
| `repeated-lesson`         | 1           | The repository's records hold the same lesson, correction or post-mortem finding twice or more. The strongest sign of all: a weed someone pulled by hand that grew back.                                                                                                         |

## Records

Repositories driven by agent frameworks keep records of decisions, lessons and fixes. Read them as evidence, never
edit them:

- `.planning/` (phases, plans, summaries, verification reports, learnings) and `.project/` (milestones, archive,
  lessons), whichever the repository has.
- `AGENTS.md`, `CLAUDE.md`, rules folders, `CONTRIBUTING.md`, ADRs, a changelog, retrospectives.
- Commit subjects: a `revert`, a "fix ... again", or a clean-up milestone names a weed that already spread once.

A milestone or phase whose goal was cleaning up a repeated mistake is the best seed there is: the class is known,
the fix was made by hand, and the question for the gardener is whether anything now stops it growing back.
