# Seed pass

Run on the first tick, when the census has no previous run. The census just recorded every current hit as the
baseline, so nothing in it is "new"; the seed pass queues what the repository already shows instead, so the first
tend pass has evidence to work from. Read `weeds.md` first. Queue with the same `weeds.ts add` command as a tick.

## 1. The baseline

Read `.garden/census.json`.

- For each pattern with hits: queue one weed per distinct file, at most 20 files per pattern (the files with the
  most hits first), `--where <path>`, `--source census:seed`, the note naming what the hits have in common.
- For each name in `duplicates`: queue one `duplicate-helper` weed per file, `--source census:seed`, the note
  saying whether the definitions do the same job (read them).

Done when every pattern with hits and every duplicate name has its weeds queued.

## 2. The records

Read the repository's records listed under "Records" in `weeds.md`, through the site: `git show
origin/<base>:<path>` for a file, `git ls-tree -r --name-only origin/<base> -- <folder>` for a folder. Skim
summaries and lessons, not every plan.

- A lesson, correction or finding that appears twice or more: `repeated-lesson`, `--where` the code it is about,
  `--source lesson:<path>:<line>` of each record (one weed per record).
- A milestone or phase that cleaned up a repeated mistake: find the class, then check the code at the base for the
  mistake today. Present again: queue the instances (the hand fix did not hold). Absent: queue nothing, but name
  the class in the report as one with no check behind it, if no lint rule, type or test now rejects it.
- A rule in agent instructions or a style guide that the code breaks: `rule-in-prose`.

Done when every record folder that exists has been listed and its lesson and summary files read.

## 3. History

```bash
git log --no-merges --format='%h %s' -n 300 origin/<base>
```

Look for reverts, "again", "still", "re-fix", repeated subjects and clean-up runs. Read the diffs of the commits
they point at, and of the newest 20 commits, as in a tick's step 3.

## 4. Commit and report

Commit with `git add .garden` and `git commit -q -m "garden: seed <short sha>"`. Report the census totals per pattern, the classes queued
with their open counts, and the classes that are ready to tend (`weeds.ts groups --min 2`), most open first. Keep
the report under 20 lines; the queue holds the detail.
