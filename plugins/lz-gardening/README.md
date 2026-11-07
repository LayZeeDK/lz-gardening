# lz-gardening

Garden a codebase that agents write. A gardener watches what lands, queues the weeds it sees (a helper written for
the third time, lint suppressions creeping, tests that cannot fail, a workaround copied from the last workaround),
and later turns each recurring weed into a rule, so it cannot grow back.

Agents copy the nearest example and take the shortest path that compiles. Weaker models do so more than stronger
ones. Every shortcut left in the code is a template for the next change, so the codebase drifts toward whatever
grew unless someone tends it. The idea comes from Lauren Tan's
[gardener post](https://x.com/poteto/status/2090546476464451907): "every weed you pull becomes a rule, so it can't
grow back."

## Install

```text
/plugin marketplace add LayZeeDK/lz-gardening
/plugin install lz-gardening@lz-gardening
```

Requires `git` and Node.js 22.18 or later on the `PATH` (the scripts are TypeScript that Node.js runs directly, with
no dependencies).

## Use

| Command                                          | What it does                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/lz-gardening:garden [--base <branch>]`         | One watch tick: census the base branch, read what landed since the last tick, queue each weed with its evidence. Changes no code. The first tick seeds the queue from the census, the repository's records and its history. |
| `/lz-gardening:tend [<class>] [--base <branch>]` | Take one class of queued weeds, add the strongest check that rejects it, prove the check on a real weed, then fix or baseline every instance, on a branch for you to review and land.                                       |

Run the watch on a loop and tend by hand:

```text
/loop 2h /lz-gardening:garden
```

A tick that finds nothing replies with one line. A tick that finds a class with two or more open weeds ends with
`ready to tend: <class>`. Two or more means several agents took the same shortcut. A one-off is left alone.
Recurring `/loop` tasks expire after seven days; start the loop again after that.

## How it stays out of the way

The gardener never works in your checkout. Other agents may be writing there around the clock. It keeps a **garden
site** beside the repository: a local clone at `../<repo>.garden` with an orphan branch `garden` that holds only
the queue and the census.

```text
../<repo>.garden/
  .garden/weeds.jsonl     the queue, append-only
  .garden/census.json     the last census
  .garden/patterns.json   optional extra census patterns for this repository
  beds/<class>/           a tend pass's worktree, on branch bed/<class>
```

Nothing is pushed. To take a tend pass's change, fetch it from the repository and merge it the way you land any
work:

```bash
git fetch ../<repo>.garden bed/<class>
```

The watch runs in the `lz-gardener` agent. It reads the repository with read-only git commands and writes only
through its three scripts, which keep the queue and the census in the site and commit them on `garden`. It never
edits planning records, agent instructions, hooks or settings. Tend passes propose hooks and permission rules in
their report; they never build them.

## Permissions

The garden skill carries its own permission rules. They pre-approve what a tick needs: reading the skill's own
files, running its own scripts, and `git log`, `git show`, `git ls-tree` and `git rev-parse`. They grant nothing
more; any other command falls back to your own permission settings, so a tick never needs a broad rule such as
`Bash(git *)`, which would also allow a push. Claude Code asks before it runs a skill with its own rules. Allow it
once, in `.claude/settings.json` or `.claude/settings.local.json`, so a `/loop` tick never waits on a prompt:

```json
{ "permissions": { "allow": ["Skill(lz-gardening:garden)"] } }
```

A tend pass runs in your session under your own permissions, and asks for what it needs: it creates a worktree in
the site and edits files there.

## Where a fix goes

A weed is fixed at the strongest layer that can hold it:

1. **Codebase**: one paved road, delete the bad examples, a module boundary.
2. **Static analysis**: types, compiler flags, lint rules whose message names the fix, tests.
3. **Agent guards**: hooks and permissions (proposed, never built by the plugin).
4. **Agent instructions**: `AGENTS.md`, `CLAUDE.md`.
5. **Skills and references**.
6. **Style guide and human review**.

A rule held only in text regrows whenever an agent misses the text. The census and the weeds catalogue know the
JavaScript and TypeScript toolchain best: Nx, Angular, Vitest, Playwright, StrykerJS, Storybook, ESLint and
Prettier. The loop itself works for any git repository.

Lauren Tan describes the larger picture as a Michelin kitchen. You cannot taste every dish, so you sample, and
when several dishes share a fault you change the kitchen, not the cook. The garden tick is the sampling. The tend
pass changes the kitchen. Each check it adds lets the agents prove more of their own work, which is what earns
them more trust.

## License

MIT
