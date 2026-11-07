---
name: garden
description: Watch a repository for weeds (copied shortcuts, creeping suppressions, duplicate helpers, hollow tests, lessons written down twice) and queue them with evidence, changing no code. Use for a garden tick, "watch this repo for weeds", "check the garden", or `/loop /lz-gardening:garden`. The first tick seeds the queue from the repository's history.
argument-hint: '[--base <branch>]'
context: fork
agent: lz-gardening:lz-gardener
background: false
---

Run one garden tick on the repository in the current working directory. Arguments: $ARGUMENTS

A tick watches what landed on the base branch since the last tick and queues each weed with its evidence. It
fixes nothing: grouping and fixing happen in a tend pass (`/lz-gardening:tend`). Every step below ends on a check;
when a check fails, report the command and its output and stop.

## 1. Open the site

Check `node --version` is 22.18 or newer (the scripts are TypeScript that Node.js runs directly); if not, report it
and stop. Then open or create the garden site and pick the base branch as
`${CLAUDE_SKILL_DIR}/references/site.md` describes (sections "Open or create" and "The base branch"). Run every
later command from the site. Done when `git rev-parse --verify origin/<base>` prints a commit in the site.

## 2. Take the census

```bash
node "${CLAUDE_SKILL_DIR}/scripts/census.ts" --rev origin/<base> --out .garden/census.json --patterns .garden/patterns.json
```

The last line of output is a JSON summary: `sha`, `previousSha`, `grew`, `newHits`, `newDuplicates`. Lines above it
starting `+ [<pattern>]` are new hits and lines starting `+ duplicate` are names newly defined in a second file.

- `previousSha` is `null`: this is the first tick. Run the seed pass in `${CLAUDE_SKILL_DIR}/references/seed.md`
  in place of steps 3 to 5; it ends with its own commit and report.
- `sha` equals `previousSha`: nothing landed. Run `git restore .garden/census.json`, reply with the one line
  `garden: nothing new on <base> since <short sha>`, and stop.

## 3. Read what landed

```bash
git log --no-merges --reverse --format='%h %an %s' <previousSha>..<sha>
```

Read the diff of each commit (`git show <commit>`), newest 30 at most; when more landed, say how many you skipped.
Look for the weeds catalogued in `${CLAUDE_SKILL_DIR}/references/weeds.md`: the census finds the textual ones, and
reading finds the rest (a hollow test, a copied workaround, a second way to do what the codebase already does, a
lesson the records hold twice). Read the catalogue before the first diff. A weed is something an agent will copy;
a one-off with no sign of spreading is not one.

Done when every commit in the range is read or counted as skipped.

## 4. Queue

Queue each weed with `weeds.ts`; the queue lives in `.garden/weeds.jsonl` and the script dedupes, so queueing the
same weed twice is safe:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" add --class <class> --where <path[:line]> --source <kind:ref> --note "<root cause>" [--layer <1-6>]
```

- `--class`: the catalogue's class id; for a census hit, the pattern id; for a new duplicate, `duplicate-helper`
  with one weed per file the name is defined in.
- `--source`: `commit:<short sha>` of the commit that planted it (`git log -n 1 --format=%h <previousSha>..<sha> --
<path>` for a census hit), or `lesson:<path>:<line>` for a record.
- `--note`: the root cause in one sentence (what the agent was trying to do and which shortcut it took), not the
  symptom.
- `--layer`: the strongest layer that could stop it growing back, from the catalogue's layer list, when the evidence
  shows it.

The script prints `added`, `seen`, `regrown` or `kept`. A `regrown` weed came back after a fix: say so in the
report, because the fix did not hold. Done when every weed from steps 2 and 3 printed one of those words.

## 5. Group, commit, report

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" groups --min 2
git add .garden
git commit -q -m "garden: watch <short sha>"
```

A class with two or more open weeds is ready to tend: several agents took the same shortcut. Report in this shape,
and nothing else:

```text
garden: <base> <previousSha short>..<sha short>, <n> commits read, <n> skipped
queued <n> (<class> x<n>, ...); regrown: <class or none>
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:tend <class>
```

Leave out the `ready to tend` line when no class has two open weeds. Done when `git status --short` in the site is
empty and the commit exists (`git log --oneline -1`).
