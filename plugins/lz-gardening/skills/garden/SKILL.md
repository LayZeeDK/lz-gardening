---
name: garden
description: Watch a repository for weeds (copied shortcuts, creeping suppressions, duplicate helpers, hollow tests, lessons written down twice) and queue them with evidence, changing no code. Use for a garden tick, "watch this repo for weeds", "check the garden", or `/loop /lz-gardening:garden`. The first tick seeds the queue from the repository's history.
argument-hint: '[--base <branch>]'
context: fork
agent: lz-gardening:lz-gardener
allowed-tools:
  - Read(${CLAUDE_SKILL_DIR}/**)
  - Bash(node --version)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/site.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/census.ts" *)
  - Bash(node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" *)
  - Bash(git log *)
  - Bash(git show *)
  - Bash(git ls-tree *)
  - Bash(git rev-parse *)
---

Run one garden tick on the repository in the current working directory. Arguments: $ARGUMENTS

A tick watches what landed on the base branch since the last tick and queues each weed with its evidence. It
fixes nothing: grouping and fixing happen in a tend pass (`/lz-gardening:tend`). Every step below ends on a check;
when a check fails, report the command and its output and stop.

Stay in the repository's working directory for the whole tick and run every command as written below, quotes
included, one command per Bash call: no shell variables, functions, loops, pipes or `&&` chains around them. Read the repository with the git commands below and the Read, Grep and Glob tools; to search, use the Grep tool
(`git grep` is not allowed: it can start other programs), and read a file as it is on the base with
`git show <base>:<path>`. Write only through the three scripts, which keep the queue and the census in the garden site beside the repository. Any other command,
`cd`, file write or redirect is refused in an unattended tick, and a refusal stops it.

## 1. Open the site

Check `node --version` is 22.18 or newer (the scripts are TypeScript that Node.js runs directly); if not, report it
and stop. Then:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" open $ARGUMENTS
```

It creates the site on the first tick and picks the base on every tick. The last line is JSON: `site` (the site's
path, written `<site>` below), `created`, and `base` (the branch to watch, such as `main` or `origin/main`, written
`<base>`). Done when it exits 0.

## 2. Take the census

```bash
node "${CLAUDE_SKILL_DIR}/scripts/census.ts" --rev <base> --out "<site>/.garden/census.json" --patterns "<site>/.garden/patterns.json"
```

The last line of output is a JSON summary: `sha`, `previousSha`, `grew`, `newHits`, `newDuplicates`. Lines above it
starting `+ [<pattern>]` are new hits and lines starting `+ duplicate` are names newly defined in a second file.
Below, `<short sha>` is `sha` shortened with `git rev-parse --short <sha>`.

- `previousSha` is `null`: this is the first tick. Run the seed pass in `${CLAUDE_SKILL_DIR}/references/seed.md`
  in place of steps 3 to 5; it ends with its own commit and report.
- `sha` equals `previousSha`: nothing landed. Reply with the one line
  `garden: nothing new on <base> since <short sha>`, and stop without committing.

## 3. Read what landed

```bash
git log --no-merges --format='%h %an %s' <previousSha>..<sha>
```

The output lists the newest commit first. Read the diff (`git show <commit>`) of each commit it lists, the first 30
at most; when more landed, say how many you skipped. Look for the weeds catalogued in
`${CLAUDE_SKILL_DIR}/references/weeds.md`: the census finds the textual ones, and reading finds the rest (a hollow
test, a copied workaround, a second way to do what the codebase already does, a lesson the records hold twice).
Read the catalogue before the first diff. A weed is something an agent will copy; a one-off with no sign of
spreading is not one.

Done when every commit in the range is read or counted as skipped.

## 4. Queue

Queue each weed with `weeds.ts`. The script dedupes, so queueing the same weed twice is safe:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" add --file "<site>/.garden/weeds.jsonl" --class <class> --where <path[:line]> --source <kind:ref> --note "<root cause>" [--layer <1-6>]
```

- `--class`: the catalogue's class id; for a census hit, the pattern id; for a new duplicate, `duplicate-helper`
  with one weed per file the name is defined in.
- `--source`: `commit:<short sha>` of the commit that planted it, `lesson:<path>:<line>` for a record, or
  `census:seed` in the seed pass. For a census hit, the planting commit is
  `git log -n 1 --format=%h -S'<a plain piece of the hit text>' <previousSha>..<sha> -- <path>`.
- `--note`: the root cause in one sentence (what the agent was trying to do and which shortcut it took), not the
  symptom. Plain words only: no backticks, `$` or double quotes inside the note, which the shell would run or end.
- `--layer`: the strongest layer that could stop it growing back, from the catalogue's layer list, when the evidence
  shows it.

The script prints `added`, `seen`, `regrown` or `kept`. A `regrown` weed came back after a fix: say so in the
report, because the fix did not hold. Done when every weed from steps 2 and 3 printed one of those words.

## 5. Group, commit, report

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" groups --file "<site>/.garden/weeds.jsonl" --min 2
node "${CLAUDE_SKILL_DIR}/scripts/site.ts" commit --message "garden: watch <short sha>"
```

A class with two or more open weeds is ready to tend: several agents took the same shortcut. Report in this shape,
and nothing else:

```text
garden: <base> <previousSha short>..<sha short>, <n> commits read, <n> skipped
queued <n> (<class> x<n>, ...); regrown: <class or none>
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:tend <class>
```

Leave out the `ready to tend` line when no class has two open weeds. Done when `site.ts commit` exits 0 and its
JSON line shows `"committed": true`.
