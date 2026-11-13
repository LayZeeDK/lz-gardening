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

Requires git 2.55 or later and Node.js 22.18 or later on the `PATH` (the scripts are TypeScript that Node.js runs
directly, with no dependencies). The git version is the oldest that GitHub's hosted runners carry on Windows, Linux and
macOS.

## Use

| Command                                             | What it does                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/lz-gardening:lz-garden [--base <branch>]`         | One watch tick: census the base branch, read what landed since the last tick, queue each weed with its evidence. Changes no code. The first tick seeds the queue from the census, the repository's records and its history. |
| `/lz-gardening:lz-tend [<class>] [--base <branch>]` | Take one class of queued weeds, add the strongest check that rejects it, prove the check on a real weed, then fix or baseline every instance, on a branch for you to review and land.                                       |

Run the watch on a loop and tend by hand:

```text
/loop 2h /lz-gardening:lz-garden
```

A tick that finds nothing replies with one line. A tick that finds a class with two or more open weeds ends with
`ready to tend: <class>`. Two or more means several agents took the same shortcut. A class with one open weed waits
for a second. Recurring `/loop` tasks expire after seven days; start the loop again after that.

## How it stays out of the way

The gardener never works in your checkout. Other agents may be writing there around the clock. It keeps a **garden
site** beside the repository: a local clone at `../<repo>.garden` with a ref `refs/garden/log` that holds the
queue and a ref `refs/garden/census` that holds the census.

```text
../<repo>.garden/
  refs/garden/log         (git ref, not a folder) the queue: one file per event, never edited
  refs/garden/census      (git ref) the last census
  .garden/patterns.json   optional extra census patterns for this repository
  beds/<class>/           a tend pass's worktree, on branch bed/<class>
```

On `origin`, a tended close also shares its bed as `refs/garden/beds/<class>`.

The queue and the census are shared through the repository's own `origin`, under the same refs: not branches, so
they never show in `git branch` or a plain clone. Each tick's `site.ts open` and `site.ts sync` fetch them into the
site, merge the queue with the site's own events, keep the census of the later base commit, and push both back, so
every clone that runs the gardener, on your machine or another, sees one queue and reads on from the last census any
clone took. A tend pass claims its class in the queue first, so two clones never tend one class at once, and shares
its close and its bed when it ends. No ref outside `refs/garden/` is pushed, and the checkout itself fetches nothing.
A clone that cannot reach `origin`, or may not push to it, keeps working on its own copy and shares it on a later
tick. Whoever can read the repository can read the shared queue: each claim names its holder by your `user.name`,
and the bed commits carry your `user.name` and `user.email`. The queue's and the census's own commits are signed
`lz-gardening <>`; to sign them yourself, set both `lzGardening.name` and `lzGardening.email` in the repository's
git config. To keep the garden local only:

```bash
git config lzGardening.share false
```

To take a tend pass's change, fetch its bed from the repository and merge it the way you land any work, then delete
the bed's ref on `origin`:

```bash
git fetch origin refs/garden/beds/<class>
```

A bed whose close was never shared is only in the site: `git fetch ../<repo>.garden bed/<class>`.

The watch runs in the `lz-gardener` agent. It reads the repository with read-only git commands and writes only
through its three scripts, which keep the queue and the census in the site. It never edits planning records, agent
instructions, hooks or settings. Tend passes propose hooks and permission rules in their report; they never build
them.

## Permissions

The `lz-garden` skill carries its own permission rules. They pre-approve what a tick needs: reading the skill's own
files, running its own scripts and `node --version`, and `git ls-tree` and `git rev-parse`; Claude Code runs the
read-only `git log` and `git show` a tick also uses without asking anyway. They grant nothing more; any other
command falls back to your own permission settings, so a tick never needs a broad rule such as `Bash(git *)`,
which would also allow a push. The site and weeds scripts push `refs/garden/log`, `refs/garden/census` and
`refs/garden/beds/<class>` themselves, and take no remote, URL or ref argument, so their rules cannot be turned into
another push; `lzGardening.share false` is the switch for those pushes. Claude Code asks before it runs a skill with its own rules. Allow it
once, in `.claude/settings.json` or `.claude/settings.local.json`, so a `/loop` tick never waits on a prompt:

```json
{ "permissions": { "allow": ["Skill(lz-gardening:lz-garden)"] } }
```

A tend pass runs in your session under your own permissions. The `lz-tend` skill's own rules pre-approve only
reading the `lz-tend` skill and the `lz-garden` references, and running the garden scripts, which make the bed (a
worktree in the site); it asks for the rest, such as edits in the bed and the repository's checks. Because the site
lies beside your checkout, a tend pass first asks you to add it as a working directory (`/add-dir <site>`); without
that, Claude Code asks before every read or edit of a file in the bed.

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
