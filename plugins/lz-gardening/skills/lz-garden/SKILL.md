---
name: lz-garden
description: Use this skill to find and record the shortcuts that coding agents or people leave in a repository, changing no code - duplicated functions, copied workarounds, eslint-disable or @ts-expect-error suppressions piling up, hollow tests that can't fail, lessons written down twice in the docs. It covers a read-only audit of the git history, a look at what recent merges brought in, and a recurring watch ("garden tick", "check the garden", `/loop /lz-gardening:lz-garden`). Each finding, a weed, goes into a queue with the commit that planted it, for a later fix; the first run seeds the queue from history. Use it even when the request never says weed or garden. Fixing, refactoring, adding a lint rule or reviewing one branch's diff is other work; pulling queued weeds is lz-tend.
argument-hint: '[--base <branch>]'
context: fork
agent: lz-gardening:lz-gardener
allowed-tools:
  - Read(${CLAUDE_SKILL_DIR}/**)
  - Read(/${CLAUDE_SKILL_DIR}/**)
  - Bash(node --version)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/site.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/census.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" *)
  - Bash(git ls-tree *)
  - Bash(git rev-parse *)
---

Run one garden tick on the repository in the current working directory. Arguments: $ARGUMENTS

A tick watches what landed on the base branch since the last tick and queues each weed with its evidence. It
fixes nothing: grouping and fixing happen in a tend pass (`/lz-gardening:lz-tend`). Every step below ends on a done
condition; when one is not met, report the command and its output and stop.

Two rules hold for the whole tick:

- **Search with the Grep tool, list files with the Glob tool.** Where Claude Code has no Grep or Glob tool (its
  native macOS and Linux builds), search with `git grep --untracked -nE '<pattern>' -- <path>` and list files with
  `find <path> -not -path '*/node_modules/*' -not -path '*/.git/*' -name '<glob>' -print` through Bash: no other
  `find` action and no redirect. Where this text says Grep or Glob, that command does the same there, with POSIX
  extended regular expressions; like Grep, `git grep` skips the files git ignores, and its exit 1 with no output
  means no match, not a failure. A Grep or Glob call that answers `No such tool available` means you are on such a
  build: run the command instead and go on, and leave no search undone for the missing tool. Where Claude Code has
  the two tools, they are the tick's only search and listing, and no search or listing command (`git grep`, `rg`,
  `find`, `ls`) runs through Bash.
  Grep patterns are Rust regular expressions, with no look-around and no backreferences: search twice instead.
- **A refused command ends the tick.** Report the command and its refusal, and stop. Reach the same result no other
  way, with a tool or with another command.

Stay in the repository's working directory for the whole tick and run every command as written below, quotes
included, one command per Bash call: no shell variables, functions, loops, pipes or `&&` chains around them. Add
no options to `git log` and `git show` beyond the ones below. Read a file as it is on the base with
`git show <base>:<path>`. The Read, Grep and Glob tools see the checkout, which is often another branch than
`<base>`, so confirm a hit with `git show <base>:<path>` before queueing it. Write only through `site.ts`,
`census.ts` and `weeds.ts`; run no other command but those searches, and no `cd`, file write or redirect.

## 1. Open the site

Check `node --version` is 22.18 or newer (the scripts are TypeScript that Node.js runs directly); if not, report it
and stop. Then:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" open $ARGUMENTS
```

It creates the site on the first tick, picks the base on every tick, and syncs the queue with the repository's
`origin`. The last line is JSON: `site` (the site's path, written `<site>` below), `created`, `base` (the branch to
watch, such as `main` or `origin/main`, written `<base>`), `seeded` (false until a seed pass is recorded, in this
clone or another), and `shared` (the share state: `local`, `synced`, `offline`, `read-only` or `behind`; see "The
share states" under "Open, sync" in `${CLAUDE_SKILL_DIR}/references/site.md`). Any share state is fine: the tick
goes on with the site's own queue. Done when it exits 0.

## 2. Take the census

```bash
node "${CLAUDE_SKILL_DIR}/scripts/census.ts" --rev <base>
```

When `seeded` is false, add `--seed` at the end: the output then holds the seed list.

The census patterns are the plugin's, `${CLAUDE_SKILL_DIR}/scripts/patterns.json`, extended or overridden by id by
the site's `<site>/.garden/patterns.json` when that file exists. To see what a pattern matches, Read the plugin's file;
the census prints each pattern the site adds or overrides as `site pattern <id>: <regex>[ in <path>, ...]`, so never
open the site's file, which lies outside the working directory, and never read either file through `node` or another
command.

The census compares the base with the garden's census, which every clone shares, and sets the new census aside until
step 5 records it. The last line of output is a JSON summary: `sha`, `previousSha`, `behind`, `commits` (the
commits from `previousSha` to `sha`, merges left out), `grew`, `newHits`, `newDuplicates`. Lines above it starting
`+ [<pattern>]` are new hits, each hit's text cut to 200 characters. A line `hits capped at 1000: <pattern>, ...`
names patterns with more hits than the census keeps: a new hit of one of them may be missing from the `+` lines, so
when such a pattern is in `grew`, read its new hits in the commits by hand. A line
`+ duplicate <name>: new <path>, ...[; already <path>, ...]` is a name newly defined in another file: the files
after `new` define it since the last census, those after `already` defined it before. Below, `<short sha>` is `sha`
shortened with `git rev-parse --short <sha>`. Done when it exits 0; then take the first case below that holds.

- `seeded` was false: run the seed pass in `${CLAUDE_SKILL_DIR}/references/seed.md` in place of steps 3 to 5,
  whatever the census says; it ends with its own sync and report. A seed pass cut short runs again on the next tick.
- `behind` is true: another run already read past this base commit. Reply with the one line
  `garden: <base> at <short sha> is behind the garden's census`, and stop.
- `previousSha` is `null` on a seeded site: there is nothing this checkout can compare against (the census was
  removed, or another clone recorded it at a commit this checkout has not fetched). Run
  `node "${CLAUDE_SKILL_DIR}/scripts/site.ts" sync --census <sha>`, reply with the one line
  `garden: census recorded on <base> at <short sha>; shared: <state> (<reason>)`, with `pending` for `recorded` when
  it said on stderr that the census stays pending, `<state>` the sync's `shared` and `(<reason>)` only when it gave
  one, and stop.
- `sha` equals `previousSha`: nothing landed. Reply with the one line
  `garden: nothing new on <base> since <short sha>`, and stop.

## 3. Read what landed

Read the catalogue, `${CLAUDE_SKILL_DIR}/references/weeds.md`, first. Then read the diffs, page by page:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" <previousSha>..<sha>
```

The script picks what a tick reads: of the newest 200 commits, the smallest diffs first up to 400,000 characters in
all, shown newest first. Page 1 opens with one line per commit, `read` or `skip`, with its diff's size and its subject; the diffs of the
`read` commits follow. Each page ends with a JSON line: `page`, `pages`, `commits`, `read`, `skipped`. Run it with
`--page 2`, `--page 3` and on, one call per page, until `page` equals `pages`, and read each page for weeds before
you run the next. The census finds the textual weeds; only this reading finds the rest (a hollow test, a copied
workaround, a second way to do what the codebase already does, a lesson the records hold twice), so the census's
findings do not stand in for the pages. A weed is something an agent will copy; a one-off with no sign of spreading
is not one.

A page fits in one tool result. If the tool result says a page was saved to a file, Read that file to its end
before the next page.

Done when you have run and read the last page (`page` equals `pages`).

## 4. Queue

Queue each weed with `weeds.ts`. The script dedupes, so queueing the same weed twice is safe:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" add --class <class> --where <path[:line]> --source <kind:ref> --note "<root cause>" [--layer <1-6>] --census <sha>
```

- `--class`: the catalogue's class id; for a census hit, the pattern id; for a new duplicate, `duplicate-function`
  (see "New duplicates" below).
- `--where`: the path repository-relative, as git prints it (`src/a.ts:12`). An absolute path, one starting with
  `~` or one through `..` is refused with exit 2. Give `--where` once per weed to add several weeds that share the
  class, source and note in one call, such as the files of one duplicate name; the script prints a line for each.
- `--source`: what the weed was found in. `commit:<short sha>` of the commit that planted it for a weed in the code,
  `lesson:<path>:<line>` for a weed in a record (the path repository-relative, as for `--where`), and
  `census:seed` for a line of the seed list and nothing else: a weed the seed pass finds by reading code or history
  takes the `commit:` of the commit that planted it, found as below with `<sha>` as the range. For a census hit, the
  planting commit is
  `git log -n 1 --format=%h -S '<a plain piece of the hit text>' <previousSha>..<sha> -- <path>`, with a space
  after `-S`; for a duplicate, the piece is the name, and for a file after `already`, the range is `<sha>`.
  `repeated-lesson` takes a `lesson:` source only, and `weeds.ts` refuses any other: a clean-up in the code that did
  not hold is queued under the class of the mistake it cleaned up.
- `--note`: the root cause in one sentence (what the agent was trying to do and which shortcut it took), not the
  symptom. Plain words only: no backtick, `$` or double quote inside the note, which the shell would run or end, and
  Claude Code refuses such a command, which ends the tick. A weed about one of those characters names it in words
  (a backtick used as an apostrophe), never types it. Read the note once more for them before you send the add.
- `--layer`: the strongest layer that could stop it growing back, from the catalogue's layer list, when the evidence
  shows it.
- `--census`: the census's `sha` from step 2, in full.

**New duplicates.** Each `+ duplicate <name>` line of step 2 names files to judge: every file after `new`, and every
file after `already` that `node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" list --class duplicate-function` does not
show. Take them one at a time:

1. Run `git show <sha>:<path>` for that file, one call per file (`git show` of several files runs them together with
   nothing between them); send the calls for all the files of one line in the same message. Read each file's header
   comment and its definition of `<name>`. When the tool result says the output was saved to a file, Read that file
   to its end. A Grep or Read of the checkout does not replace this call, nor does a diff page of step 3.
2. Look for words that say why this copy must exist: a comment in the file, or a document the repository keeps, that
   says the file cannot import the shared definition (it is loaded, injected or copied alone) or that a test pins the
   copies alike. Only such words make a documented copy; a file that merely has no imports, or looks
   self-contained, is not one.
3. A documented copy goes on the reply's `left out:` line, its reason the words you found, copied as they stand
   (`...` where you cut some out), and the file they are in when it is not the copy itself. Every other file
   is queued, one weed per file (one `add` with a `--where` per file), with a note naming the definition to keep:
   the file that holds that definition is queued too, and so is a file whose `<name>` does a different job (a
   naming weed). A tend pass decides what happens to each. No file of a `+ duplicate` line ends neither queued nor
   on `left out:`.

The script prints `added`, `seen`, `regrown` or `kept`. Report a `regrown` weed with the bed and check its line
names. Report a `(check: <where> not on the base)` line as a check that has not landed, not one that failed, and a
`(check: <where>, base unknown)` line as a check whose landing is unknown. Done when every weed from steps 2 and 3
printed one of those words, and every file of a new duplicate had its own `git show <sha>:<path>` and is either
queued or a documented copy.

## 5. Group, record, report

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" groups --ready
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" sync --census <sha>
```

`sync --census` records the census of step 2 as the garden's census, unless another clone already recorded one of a
later commit, and shares it and the queue's new events with the repository's `origin`. Its last line is JSON:
`shared` (the share state), `events` (how many events it shared), and `reason` when the state has one. It exits 1,
recording and sharing nothing, when no census of `<sha>` waits to be recorded and the site's census is not already of
`<sha>` or a later commit: run step 2's `census.ts` again, then this command. When another sync of this site moved
the census first, it says so on stderr, and the census stays pending for the next sync to record.

A class whose open weeds sit in two or more places (files) is ready to tend: several agents took the same shortcut.
`groups --ready` prints the ready classes `lz-tend` takes on its own: not `stale-verification` or `repeated-lesson`,
and claimed by no other clone.

Done when `site.ts sync --census <sha>` exits 0. Then reply with this form, every `<slot>` filled as the list below
says. The reply is exactly these five lines: the last character of the reply ends the `shared:` line. The reason for
each weed is in its `--note`, what was not read is in the counts, and what was not queued is on `left out:`; the
reply holds nothing the form has no line for.

```text
garden: <base> <short previousSha>..<short sha>, <commits> commits, <read> read, <skipped> skipped
queued <total> (<class> x<n>, ...); regrown: <class> (check: <where>[ not on the base|, base unknown]), ...
left out: <path> (<reason>), ...
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:lz-tend <class>
shared: <state> (<reason>)
```

- `<commits>`: the census's `commits`, as printed.
- `<read>` and `<skipped>`: the `read` and `skipped` of the last page's JSON line from step 3, once you have read
  every page. When you stopped before the last page, `<read>` is 0 and `<skipped>` is `<commits>`.
- `queued`: one `<class> x<n>` per class, `<n>` the adds of this tick that printed `added` or `regrown`; `<total>`
  is the sum of the `<n>`, and `queued 0` has no parentheses. `regrown:` names each class an add printed `regrown` for,
  with the check its line named, or reads `regrown: none`.
- `left out`: one `<path> (documented copy: [<other file>: ]"<quoted words>")` entry per documented copy of step 4,
  comma-separated, such as `extension/a.js (documented copy: "runs in the page alone, so it cannot import")` or
  `extension/b.js (documented copy: test/b.spec.ts: "loads b.js alone")`. Each entry names one path and its own
  words: never two paths under one reason, and no entry for a group of files. `left out: none` when there is none.
- `ready to tend`: one entry per row of `groups --ready`, its `open` and `places` columns, and the first row's class
  after `lz-tend`; `ready to tend: none` when it printed no row below its header.
- `shared`: `sync`'s `shared`, with `(<reason>)` only when `sync` printed a `reason`.
