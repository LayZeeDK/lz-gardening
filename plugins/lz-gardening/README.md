# lz-gardening

Garden a codebase that agents write. A gardener watches what lands, queues the weeds it sees (a function written for
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
directly, with no build step). The git version is the oldest that GitHub's hosted runners carry on Windows, Linux and
macOS. The scripts use one npm package, Zod, which Claude Code installs with the plugin.

## Use

| Command                                             | What it does                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/lz-gardening:lz-garden [--base <branch>]`         | One tick: take a census of the base branch, read what landed since the last tick, queue each weed with its evidence. Changes no code. The first tick seeds the queue from the census, the repository's records and its history. |
| `/lz-gardening:lz-tend [<class>] [--base <branch>]` | Take one class of queued weeds, add the strongest check that rejects it, prove the check on a real weed, then fix or baseline every instance, on a branch for you to review and land.                                           |

Run ticks on a loop and tend by hand:

```text
/loop 2h /lz-gardening:lz-garden
```

A tick that finds nothing replies with one line. A tick that finds a class whose open weeds sit in two or more files
names it in its `ready to tend: <class>` line, unless another clone holds a claim of it or it is a class tended
another way (`stale-verification`, `repeated-lesson`). Two or more files means several agents took the same
shortcut. A class whose open weeds all sit in one file waits for a second. Recurring `/loop` tasks expire after
seven days; start the loop again after that.

Pick the interval so that fewer commits land between two ticks than one tick reads: a tick reads at most the newest
200 commits, and of those the smallest diffs first, up to 400,000 characters in all; a commit it skips is never read
later. Every tick costs tokens, so take the longest interval that keeps the first line of each tick's reply at
`0 skipped`, and shorten it when a tick reports more.

## Choose how ticks run

Every tick costs Claude Code tokens. The ways to run ticks differ in who starts a tick and where it runs:

| Way              | Start                                                             | Runs                                                              | Costs a tick                                  |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Local, by hand   | `/lz-gardening:lz-garden` in Claude Code                          | on your machine                                                   | each time you run it                          |
| Local, on a loop | `/loop 2h /lz-gardening:lz-garden`                                | on your machine, while the session stays open, up to seven days   | each interval                                 |
| CI, by hand      | the **Actions** tab or `gh workflow run garden.yml`               | in a GitHub Actions job ([Run ticks in CI](#run-ticks-in-ci))     | each time you start it                        |
| CI, automatic    | `workflow_run` after each passing push to the base, or `schedule` | in a GitHub Actions job ([When CI ticks run](#when-ci-ticks-run)) | at most one per passing push, or one per slot |

Unless `lzGardening.share` is `false`, all of them share one garden through `origin`, so you can mix them: a tick on
your machine and a CI tick compare against the same census. A CI tick with sharing off keeps nothing, because its site
lasts one job. Start by hand or on a loop while you learn what the gardener queues. To keep watching with no session
open, tick in CI after each passing push, which reads what landed and costs nothing while nothing lands.
Tend by hand in every case: a tend pass changes code on a branch for you to review.

On macOS and Linux, Claude Code's native builds replace the Grep and Glob tools with `grep` and `find` through Bash,
which a tick does not run, so a tick there has no search of its own: it reads the files that carry each hit instead
and covers less. Only a `--tools` list that names Grep and Glob brings them back, and such a list also leaves out
every tool it does not name, so start a session for ticks with one, such as
`claude --tools Bash,Read,Grep,Glob,Skill,Task`. The CI recipe below does this.

## How it stays out of the way

The gardener never works in your checkout. Other agents may be writing there around the clock. It keeps a **garden
site** beside the repository: a local clone at `../<repo>.garden` with a ref `refs/garden/log` that holds the
queue and a ref `refs/garden/census` that holds the census.

```text
../<repo>.garden/
  refs/garden/log         (git ref, not a folder) the queue: one file per event, never edited
  refs/garden/census      (git ref) the last census
  .garden/patterns.json   optional extra census patterns for this repository; pushed to origin as it is, in each census
  beds/<class>/           a tend pass's worktree, on branch bed/<class>
```

On `origin`, a tended close also shares its bed as `refs/garden/beds/<class>`.

The queue and the census are shared through the repository's own `origin`, under the same refs: not branches, so
they never show in `git branch` or a plain clone. Each tick's `site.ts open` and `site.ts sync` fetch them into the
site, merge the queue with the site's own events, keep the census of the later base commit, and push both back, so
every clone that runs the gardener, on your machine or another, sees one queue and reads on from the last census any
clone took. A tend pass claims its class in the queue first, so two clones never tend one class at once, and shares
its close and its bed when it ends; a class is closed, like a bed made, only under the closer's own claim. No ref
outside `refs/garden/` is pushed, and the checkout itself fetches nothing. A clone that cannot reach `origin`, or may
not push to it, keeps working on its own copy and shares it on a later tick. Whoever can read the repository can read
the shared queue: each claim names its holder by `lzGardening.name` when you set it, and otherwise by `writer` and the
first 8 characters of the site's random writer id, never by your `user.name`; the bed commits carry the `user.name`
and `user.email` the site copied from the repository when `site.ts open` made it. Each census also carries the
site's `.garden/patterns.json` byte for byte, and nothing checks that file for machine paths, so keep local paths
and private text out of it. A clone without the file takes its census with the extra patterns of the last census it
holds, which a sync takes from `origin`. The queue's and the census's own commits are authored and committed as
`lz-gardening <>`; to put your own name on them, set both `lzGardening.name` and `lzGardening.email` in the
repository's git config. To keep the garden local only:

```bash
git config lzGardening.share false
```

To take a tend pass's change, fetch its bed from the repository and merge it the way you land any work, then delete
the bed's ref on `origin`:

```bash
git fetch origin refs/garden/beds/<class>
```

A bed that was not shared is only in the site: fetch it with `git fetch ../<repo>.garden bed/<class>`. The tend
pass's report says when this applies: its close did not end `synced`, or the close named the bed on stderr.

A tick runs in the `lz-gardener` agent. It reads the repository with read-only git commands and writes only
through its three scripts, which keep the queue and the census in the site. It never edits planning records, agent
instructions, hooks or settings. Tend passes propose hooks and permission rules in their report; they never build
them.

The agent runs on your session's model. To run every subagent, the gardener included, on one model, set
`CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.

## Permissions

The `lz-garden` skill carries its own permission rules. They pre-approve what a tick needs: reading the skill's own
files, running its own scripts and `node --version`, and `git ls-tree` and `git rev-parse`; Claude Code runs the
read-only `git log` and `git show` a tick also uses without asking anyway. They grant nothing more; any other
command falls back to your own permission settings, so a tick never needs a broad rule such as `Bash(git *)`,
which would also allow a push. The site and weeds scripts push `refs/garden/log`, `refs/garden/census` and
`refs/garden/beds/<class>` themselves. No argument names a remote, a URL or a ref to push: they push only those
fixed refs, so their rules cannot be turned into another push; `lzGardening.share false` is the switch for those
pushes. Claude Code asks before it runs a skill with its own rules. Allow it
once, in `.claude/settings.json` or `.claude/settings.local.json`, so a `/loop` tick never waits on a prompt:

```json
{ "permissions": { "allow": ["Skill(lz-gardening:lz-garden)"] } }
```

A tend pass runs in your session under your own permissions. The `lz-tend` skill's own rules pre-approve only
reading the `lz-tend` skill and the `lz-garden` references, and running the site and weeds scripts, which make the
bed (a worktree in the site); it asks for the rest, such as edits in the bed and the repository's checks. Because the
site lies beside your checkout, a tend pass first asks you to add it as a working directory (`/add-dir <site>`);
without that, Claude Code asks before every read or edit of a file in the bed.

A refused command ends the pass, and a session that cannot ask (`claude -p`, `--permission-mode dontAsk`) refuses
every command its rules do not allow. To tend in such a session, add the site with `--add-dir <site>` and allow the
forms the pass sends to the bed:

```json
{
  "permissions": {
    "allow": [
      "Edit",
      "Write",
      "Bash(npm --prefix *)",
      "Bash(npx --no *)",
      "Bash(node --test *)",
      "Bash(git -C * add *)",
      "Bash(git -C * commit *)",
      "Bash(git -C * rm *)"
    ]
  }
}
```

`npm --prefix <bed>` installs the bed's dependencies and runs the repository's package scripts in the bed. A tool
with no script runs from the bed's root, where it finds the bed's config, as `cd <bed> && npx --no -- <tool>`; `--no`
refuses to download a package that is not installed, and `--` keeps npm from reading the tool's options as its own.
Use `pnpm -C *` or `yarn --cwd *` in place of `npm --prefix *` in a repository that uses them. A repository whose
tests run with Node.js flags, such as `node --conditions=<condition> --test`, needs that form allowed as well. These
rules allow any installed tool and any package script to run, so grant them only in a session that tends.

## Run ticks in CI

To run one tick on GitHub Actions, add this workflow as `.github/workflows/garden.yml`. It runs the tick with
[claude-code-action](https://github.com/anthropics/claude-code-action). Start it from the repository's **Actions**
tab or with `gh workflow run garden.yml`.

```yaml
name: garden

on:
  workflow_dispatch:
  # To tick on a schedule as well, uncomment these lines (see "When CI ticks run").
  # schedule:
  #   - cron: '17 6 * * 1-5'

permissions:
  # The garden scripts push refs/garden/log, refs/garden/census and refs/garden/beds/* with this job's token.
  contents: write

jobs:
  garden:
    # On the job, not the workflow, so that a workflow_run whose job its if: skips never takes a waiting run's place.
    concurrency:
      group: lz-gardening
      cancel-in-progress: false
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          # The census reads the base's history since the last census.
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: ${{ github.token }}
          plugin_marketplaces: https://github.com/LayZeeDK/lz-gardening.git
          plugins: lz-gardening@lz-gardening
          # The checkout may have no origin/HEAD, so the tick is told the base.
          prompt: /lz-gardening:lz-garden --base ${{ github.event.repository.default_branch }}
          # Linux builds of Claude Code drop the Grep and Glob tools, a tick's only search, unless --tools names them.
          claude_args: --permission-mode dontAsk --tools Bash,Read,Grep,Glob,Skill,Task
          # The session, its tool calls and the tick's reply, in the run's summary; the step's log hides them.
          display_report: true
```

The workflow needs a `CLAUDE_CODE_OAUTH_TOKEN` repository secret. To use an API key instead, replace
`claude_code_oauth_token` with `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`.

The recipe has no credential step. The action puts the job's token, the one `github_token` passes, into the
checkout's `origin` URL. The garden scripts read that URL on every sync, so the site fetches and pushes with the same
token. Git leaves the token out of its messages, and the site keeps no copy of it. `contents: write` lets the token
push the garden's refs, and the job's token lasts as long as the job.

Leave these three claude-code-action inputs unset:

- `allowed_bots` and `allowed_non_write_users`. With either one set, the action hands git the token through the
  checkout's own git config instead of the `origin` URL. The site does not read that config, so its sync ends
  `offline` or `read-only` and shares nothing.
- `use_commit_signing`. With it set to `true`, the action sets no `user.name` or `user.email`, and `site.ts open`
  stops because the repository has no identity.

A run shares what a tick on your machine shares: the queue and the census, pushed to `refs/garden/` on the
repository, where anyone who can read the repository can read them. The site copies the `claude[bot]` identity that
the action sets, and the queue's and the census's commits are authored as `lz-gardening <>`, as on any clone.

The site lasts one job. A run whose last `shared` state is `offline`, `read-only` or `behind` loses what it found,
and the next run reads the same commits again, because the shared census did not move. The `concurrency` group
keeps two runs from ticking at once. `--permission-mode dontAsk` makes Claude Code refuse every call that would
otherwise ask for permission. Without it, the action lets a classifier approve such calls while a token that can
push sits in the `origin` URL.

A green run does not mean the tick worked. The job fails only when the Claude Code run itself fails. A tick whose
script stops, for example on a damaged queue or a repository with no identity, ends with a reply that says so, and
the run still shows green. Read the reply at the end of the run's summary, under **Claude Code Report**: a tick that
worked ends with `shared: synced`, on a line of its own or at the end of the `garden: census` line, or is one
`garden:` line when nothing new landed or another run already read past the base. A census that was recorded but not
shared is lost with the job's site. In a public repository anyone can read the summary, with every command the tick
ran and what it printed; GitHub masks the job's secrets in it.

Name the marketplace by its URL, as the recipe does. With a local path such as `plugin_marketplaces: ./`, Claude Code
reads the plugin from that folder, where its npm packages are not installed, and the tick stops on its first script.

### When CI ticks run

The workflow above starts only by hand, so a tick costs tokens only when you start one. To tick without being asked,
add one of two triggers beside `workflow_dispatch`.

**After each push that passed the checks.** This fits the gardener's job best: each tick reads what one push landed.
claude-code-action refuses `push` events but runs on `workflow_run`, so name the workflow that already runs on each
push to the default branch (`check` here):

```yaml
on:
  workflow_run:
    # Name that workflow and your default branch here.
    workflows: [check]
    types: [completed]
    branches: [main]
  workflow_dispatch:
```

and add this condition to the `garden` job, so that only a passing push to the base starts a tick:

```yaml
jobs:
  garden:
    # A failed push, or a pull request from a branch named like the base, starts this workflow too; only a passing push ticks.
    if: >-
      github.event_name != 'workflow_run' ||
      (github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_repository.full_name == github.repository)
```

GitHub reads a `workflow_run` trigger from the default branch only, so it works once `garden.yml` is merged there.
Each passing push costs one tick, and a repository where nothing lands costs nothing. The `concurrency` group keeps
one run going and one waiting, and a newer run replaces the waiting one, so a burst of pushes costs at most two
ticks, the second reading the rest of the burst.

**On a schedule.** Uncomment the `schedule` lines of the recipe. Each slot costs one tick, even when nothing landed;
such a tick replies with one line. Pick the interval as for `/loop`: fewer commits than one tick reads should land
between two slots. GitHub can start a scheduled run late or drop it when it is busy, and in a public repository it
turns scheduled workflows off after 60 days with no activity; a dropped slot makes the next tick read more.

Each CI tick also costs the job's Actions minutes in a private repository; standard GitHub-hosted runners are free
for public repositories.

`lz-tend` does not run in CI yet: a tend pass needs the site added as a working directory before the session starts,
and the repository's own checks allowed.

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
