---
name: lz-garden
description: Watch a repository for weeds (copied shortcuts, creeping suppressions, duplicate helpers, hollow tests, lessons written down twice) and queue them with evidence, changing no code. Use for a garden tick, "watch this repo for weeds", "check the garden", or `/loop /lz-gardening:lz-garden`. The first tick seeds the queue from the repository's history.
argument-hint: '[--base <branch>]'
context: fork
agent: lz-gardening:lz-gardener
allowed-tools:
  - Read(${CLAUDE_SKILL_DIR}/**)
  - Bash(node --version)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/site.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/census.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" *)
  - Bash(git ls-tree *)
  - Bash(git rev-parse *)
---

Run one garden tick on the repository in the current working directory. Arguments: $ARGUMENTS

A tick watches what landed on the base branch since the last tick and queues each weed with its evidence. It
fixes nothing: grouping and fixing happen in a tend pass (`/lz-gardening:lz-tend`). Every step below ends on a done
condition; when one is not met, report the command and its output and stop.

Stay in the repository's working directory for the whole tick and run every command as written below, quotes
included, one command per Bash call: no shell variables, functions, loops, pipes or `&&` chains around them. Read
the repository with the git commands below and the Read, Grep and Glob tools. Claude Code runs `git log` and
`git show` without asking only in read-only forms like the ones below; add no other options to them. To search, use
the Grep tool (`git grep` is not allowed: it can start other programs), and read a file as it is on the base with
`git show <base>:<path>`. The Read, Grep and Glob tools see the checkout, which is often another branch than
`<base>`, so confirm a hit with `git show <base>:<path>` before queueing it. Write only through the three
scripts, which keep the queue and the census in the garden site beside the repository. Anything else (another
command, `cd`, a file write, a redirect) falls back to the user's permission settings; a tick cannot stop to ask, so
what those settings do not allow is refused, and a refusal stops the tick.

## 1. Open the site

Check `node --version` is 22.18 or newer (the scripts are TypeScript that Node.js runs directly); if not, report it
and stop. Then:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" open $ARGUMENTS
```

It creates the site on the first tick, picks the base on every tick, and syncs the queue with the repository's
`origin`. The last line is JSON: `site` (the site's path, written `<site>` below), `created`, `base` (the branch to
watch, such as `main` or `origin/main`, written `<base>`), `seeded` (false until a seed pass has synced, in this
clone or another), and
`shared` (the share state: `local`, `synced`, `offline`, `read-only` or `behind`; see
`${CLAUDE_SKILL_DIR}/references/site.md`). Any share state is fine: the tick goes on with the site's own queue. Done
when it exits 0.

## 2. Take the census

```bash
node "${CLAUDE_SKILL_DIR}/scripts/census.ts" --rev <base>
```

When `seeded` is false, add `--seed` at the end: the output then holds the seed list.

The census compares the base with the garden's census, which every clone shares, and sets the new census aside until
step 5 records it. The last line of output is a JSON summary: `sha`, `previousSha`, `behind`, `commits` (the
commits from `previousSha` to `sha`, merges left out), `grew`, `newHits`, `newDuplicates`. Lines above it starting
`+ [<pattern>]` are new hits, each hit's text cut to 200 characters. A line
`+ duplicate <name>: new <path>, ...[; already <path>, ...]` is a name newly defined in another file: the files
after `new` define it since the last census, those after `already` defined it before. Below, `<short sha>` is `sha`
shortened with `git rev-parse --short <sha>`.

- `seeded` was false: run the seed pass in `${CLAUDE_SKILL_DIR}/references/seed.md` in place of steps 3 to 5,
  whatever the census says; it ends with its own sync and report. A seed pass cut short runs again on the next tick.
- `behind` is true: another run already read past this base commit. Reply with the one line
  `garden: <base> at <short sha> is behind the garden's census`, and stop.
- `previousSha` is `null` on a seeded site: there is nothing this checkout can compare against (the census was
  removed, or another clone recorded it at a commit this checkout has not fetched). Run
  `node "${CLAUDE_SKILL_DIR}/scripts/site.ts" sync --census <sha>`, reply with the one line
  `garden: census recorded on <base> at <short sha>`, and stop.
- `sha` equals `previousSha`: nothing landed. Reply with the one line
  `garden: nothing new on <base> since <short sha>`, and stop.

## 3. Read what landed

```bash
git log --no-merges --format='%h %an %s' <previousSha>..<sha>
```

The output lists the newest commit first. Read the diff (`git show <commit>`) of each commit it lists, the first 30
at most; the report counts the rest as skipped. Look for the weeds catalogued in
`${CLAUDE_SKILL_DIR}/references/weeds.md`: the census finds the textual ones, and reading finds the rest (a hollow
test, a copied workaround, a second way to do what the codebase already does, a lesson the records hold twice).
Read the catalogue before the first diff. A weed is something an agent will copy; a one-off with no sign of
spreading is not one.

Done when every commit in the range is read or counted as skipped.

## 4. Queue

Queue each weed with `weeds.ts`. The script dedupes, so queueing the same weed twice is safe:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" add --class <class> --where <path[:line]> --source <kind:ref> --note "<root cause>" [--layer <1-6>]
```

- `--class`: the catalogue's class id; for a census hit, the pattern id; for a new duplicate, `duplicate-helper`.
  Queue one weed per file after `new` on its `+ duplicate` line, and one per file after `already` that
  `node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" list --class duplicate-helper` does not show. First read the
  definition you would keep and each one you would queue, with `git show <sha>:<path>`. A comment or a doc that says
  why a copy must exist (a file that cannot import the shared one, a test that pins the copies alike) makes that
  copy no weed.
- `--where`: the path repository-relative, as git prints it (`src/a.ts:12`). An absolute path, one starting with
  `~` or one through `..` is refused with exit 2.
- `--source`: `commit:<short sha>` of the commit that planted it, `lesson:<path>:<line>` for a record (the path
  repository-relative, as for `--where`), or
  `census:seed` in the seed pass. For a census hit, the planting commit is
  `git log -n 1 --format=%h -S '<a plain piece of the hit text>' <previousSha>..<sha> -- <path>`, with a space
  after `-S`; for a duplicate, the piece is the name, and for a file after `already`, the range is `<sha>`.
  `repeated-lesson` takes a `lesson:` source only, and `weeds.ts` refuses any other: a clean-up in the code that did
  not hold is queued under the class of the mistake it cleaned up.
- `--note`: the root cause in one sentence (what the agent was trying to do and which shortcut it took), not the
  symptom. Plain words only: no backticks, `$` or double quotes inside the note, which the shell would run or end.
- `--layer`: the strongest layer that could stop it growing back, from the catalogue's layer list, when the evidence
  shows it.

The script prints `added`, `seen`, `regrown` or `kept`. A `regrown` weed belongs to a class a tend pass closed, and
the line names that bed and its check: say so in the report, because the check did not hold. When the check reads
`(check: <where> not on the base)`, the bed's change to that check is not on the base: the bed has not landed, or the
check's file is gone from the base. Report it that way, not as a check that failed. Done when every weed from steps 2
and 3 printed one of those words.

## 5. Group, record, report

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" groups --ready
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" sync --census <sha>
```

`sync --census` records the census of step 2 as the garden's census, unless another clone already recorded one of a
later commit, and shares it and the queue's new events with the repository's `origin`. Its last line is JSON:
`shared` (the share state), `events` (how many events it shared), and `reason` when the state has one.

A class whose open weeds sit in two or more places (files) is ready to tend: several agents took the same shortcut.
`groups --ready` prints the ready classes `lz-tend` takes on its own: not `stale-verification` or `repeated-lesson`,
and claimed by no other clone.

Done when `site.ts sync --census <sha>` exits 0. Then reply with this form, every `<slot>` filled as the list below
says. The reply is these four lines and ends after the last one; the reason for each weed is in its `--note`.

```text
garden: <base> <short previousSha>..<short sha>, <commits> commits, <read> read, <skipped> skipped
queued <total> (<class> x<n>, ...); regrown: <class> (check: <where>[ not on the base]), ...
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:lz-tend <class>
shared: <state> (<reason>)
```

- `<commits>`: the census's `commits`, as printed.
- `<read>`: the commits whose whole diff you read with `git show <commit>`. A `--stat` or a path-limited
  `git show` is not a read. `<skipped>` is `<commits>` minus `<read>`.
- `queued`: one `<class> x<n>` per class, `<n>` the adds of this tick that printed `added` or `regrown`; `<total>`
  is the sum of the `<n>`, and `queued 0` has no parentheses. `regrown:` names each class an add printed `regrown` for,
  with the check its line named, or reads `regrown: none`.
- `ready to tend`: one entry per row of `groups --ready`, its `open` and `places` columns, and the first row's class
  after `lz-tend`; `ready to tend: none` when it printed no row.
- `shared`: `sync`'s `shared`, with `(<reason>)` only when `sync` printed a `reason`.
