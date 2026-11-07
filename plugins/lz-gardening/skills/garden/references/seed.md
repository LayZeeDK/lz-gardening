# Seed pass

Run on every tick until a seed pass has committed (`site.ts open` reports `seeded: false`). The census records every
current hit as its starting count, so nothing in it is "new"; the seed pass queues what the repository already
shows instead, so the first tend pass has evidence to work from. Read `weeds.md`, in the same folder as this file,
first. Queue with the tick's step 4 command, `--file` included, and stay in the repository's working directory
throughout. Run all four steps: the records and the history find the weeds the census cannot, so a seed that stops
after the seed list misses them.

## 1. The seed list

With `--seed`, the census output prints the seed list above its JSON line:

- `= [<pattern>] <path> <count>`: the files with the most hits for that pattern, at most 20 per pattern. Queue one
  weed per line, `--where <path>`, `--source census:seed`, the note naming what the hits have in common (read a few).
  The census keeps at most 1000 hits per pattern, in path order, so for a pattern with more the files are ranked
  from those 1000; say so in the report when a pattern's count is over 1000.
- `= duplicate <name>: <path>, <path>, ...`: a name defined in more than one file, at most 30 names, those defined
  in the most files first. Files under dot-directories (`.claude/`, `.github/` and other tool folders, often
  deliberate mirrors of each other) are left out of duplicate names, though their pattern hits count. Read the
  definitions; when they do the same job, queue one `duplicate-helper` weed per file, `--source census:seed`, the
  note naming the copy to keep. Names that only share a word (two different `parse` functions) are not weeds. A last
  line `<n> more duplicate names not listed` counts the rest; say how many in the report. Later ticks report only
  what is new, so the seed list is the one time these are listed.

Done when every `=` line has its weeds queued. No `=` lines means the census found no hits and no duplicates; say so
in the report.

## 2. The records

Read the repository's records listed under "Records" in `weeds.md`, as they are on the base: `git show
<base>:<path>` for a file, `git ls-tree -r --name-only <base> -- <folder>` for a folder. Skim summaries and lessons,
not every plan.

- A lesson, correction or finding that appears twice or more: `repeated-lesson`, `--where` the code it is about,
  `--source lesson:<path>:<line>` of each record (one weed per record).
- A milestone or phase that cleaned up a repeated mistake: find the class, then check the code at the base for the
  mistake today. Present again: queue the instances (the hand fix did not hold). Absent: queue nothing, but name
  the class in the report as one with no check behind it, if no lint rule, type or test now rejects it.
- A rule in agent instructions or a style guide that the code breaks: `rule-in-prose`.

Done when every record folder that exists has been listed and its lesson and summary files read.

## 3. History

```bash
git log --no-merges --format='%h %s' -n 300 <base>
```

Look for reverts, "again", "still", "re-fix", repeated subjects and clean-up runs. Read the diffs of the commits
they point at, and of the newest 20 commits, as in a tick's step 3. Done when each of those commits is read and its
weeds are queued.

## 4. Commit and report

Run the two commands of the tick's step 5, `groups` and `commit`, with the commit message
`garden: seed <short sha>`. Done when `commit` prints `"committed": true`. Report in this shape, and nothing else:

```text
garden: seeded <base> at <short sha>
census: <pattern> <count>, ... (patterns with hits only)
queued <n> (<class> x<n>, ...)
no check behind: <class>, ... (or none)
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:tend <class>
```

Leave out the `ready to tend` line when no class has two open weeds.
