# Agent instructions

This repository is the `lz-gardening` Claude Code plugin marketplace. The plugin lives in `plugins/lz-gardening/`;
everything else (`tools/`, `package.json`, the lint and type configs) is maintainer tooling and does not ship.

## The plugin stands alone

Shipped files name none of the maintainer's own plugins or skills; `tools/hygiene.test.ts` lists the names it
rejects. Describe an idea in its own words instead of pointing at another tool. Credit people, not tools.

## Public repositories

The plugin must be safe in open-source repositories. Everything the garden shares (`refs/garden/*` on `origin`) is
readable by anyone who can read the repository, and its events are never removed: put no hostname, local path, user
name or email, or other machine or personal data into an event, a census, a garden commit or a shared bed, unless the
user configured it (`lzGardening.name` and `lzGardening.email` name the garden's commits).

## Words and decisions

- `GLOSSARY.md` defines the plugin's words (weed, bed, regrown, one-off and the rest). Use them in code, docs, tests
  and commit messages, and not the words a term lists under _Avoid_. Change a term in the same commit as the change
  that needs it. The glossary defines words only; behaviour belongs in the skills' docs and the CHANGELOG.
- `docs/adr/` records the decisions that are hard to reverse, surprising without context and the result of a real
  trade-off, one numbered file each. Read the ADRs that cover what you change; when a change reverses one, add an
  update to it or a new ADR that supersedes it.
- `references/glossary-and-adrs.md` says when each of them changes and how to write the change.

## Skills and agents

- No skill sets `disable-model-invocation: true`. In Claude Code it also makes the Skill tool refuse the skill,
  stops `skills:` preloading, and keeps `/loop` and autonomous sessions from running it.
- Name plugin agents with the plugin prefix wherever a caller names them (`agent: lz-gardening:lz-gardener`,
  `subagent_type: "lz-gardening:lz-gardener"`). A bare name silently falls back to the default agent in a skill's
  `agent:` field, and fails in an Agent call.
- Point at bundled files with `${CLAUDE_SKILL_DIR}` inside a skill and `${CLAUDE_PLUGIN_ROOT}` across skills.
- Verify a change to a skill or agent with a real run (`claude -p --plugin-dir ./plugins/lz-gardening`) on Sonnet
  and Opus. Judge from the subagent's transcript what it received, not from the model's answer.

## Scripts

The scripts under `plugins/lz-gardening/skills/*/scripts/` are TypeScript in erasable syntax that Node.js 22.18+
runs directly, with Node.js built-ins only. Develop them test-first, one `node:test` test per red-green-refactor
cycle. Give each test its own state from a setup function it calls (a throwaway git repository for census tests),
not shared `before` hooks. Mutation-test changes with StrykerJS: the command runner over `node --test`, or, on a
machine with an `@layzee/stryker-node-test-runner` checkout, that runner and the checkout's mutators
(`stryker.config.mjs` says how).

Keep `npm run check` passing: type-check, lint, Prettier and every test, the hygiene checks included.

## Versioning and commits

- `plugins/lz-gardening/CHANGELOG.md` defines the public interface. Pick each Conventional Commit type by its
  SemVer effect on that interface.
- Put a version bump and its CHANGELOG entry in their own commit, apart from the changes they describe.
- Commit as the public maintainer identity; `tools/hygiene.test.ts` checks it.
