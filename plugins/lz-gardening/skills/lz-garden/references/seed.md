# Seed pass

Run on every tick until a seed pass is recorded, in this clone or another (`site.ts open` reports `seeded: false`).
The census records every current hit as its starting count, so nothing in it is "new"; the seed pass queues what the
repository already shows instead, so the first tend pass has evidence to work from. Read `weeds.md`, in the same
folder as this file, first. Queue with the tick's step 4 command, and stay in the repository's working directory
throughout. Run all four steps: the records and the history find the weeds the census cannot, so a seed that stops
after the seed list misses them.

## 1. The seed list

With `--seed`, the census output prints the seed list above its JSON line. Each `=` line is either queued or
declined, by the rule in `weeds.md`: queue what spreads or invites copying; decline a one-off with a visible reason,
code that is deliberately unusual and says why, and what a check in the repository already rejects. Decline with

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" decline --class <class> --where <path> --reason "<why it is no weed>"
```

which keeps the line's weed out of the queue for good. `sync --seeded` in step 4 refuses to record the seed while a
line is neither queued nor declined, and names the lines left.

- `= [<pattern>] <path> <count>`: the files with the most hits for that pattern, at most 20 per pattern. Read a few
  hits; queue one weed, `--class <pattern>`, `--where <path>`, `--source census:seed`, the note naming what the hits
  have in common, or decline it with `--class <pattern> --where <path>`. The census keeps at most 1000 hits per
  pattern, in path order, so for a pattern with more the files are ranked from those 1000.
- `= duplicate <name>: <path>, <path>, ...`: a name defined in more than one file, at most 30 names, those defined
  in the most files first. Test files (`*.spec.*`, `*.test.*`) and files under dot-directories (`.claude/`,
  `.github/` and other tool folders, often deliberate mirrors of each other) are left out of duplicate names, though
  their pattern hits count. Read the definitions, the copy you would keep among them; when they do the same job,
  queue one `duplicate-function` weed per file, `--source census:seed`, the note naming the copy to keep. A comment or
  a doc that says why a copy must exist (a file that cannot import the shared one, a test that pins the copies alike)
  makes that copy no weed. Names that only share a word (two different `parse` functions) are not weeds: decline the
  line with `--class duplicate-function --where <one of its paths>`. A last line
  `<n> more duplicate names not listed` counts the rest. Later ticks report only what is new, so the seed list is the
  one time these are listed.

The line after the seed list, `census: <pattern> <count>, ...` or `census: none`, is the report's census line.

Done when every `=` line has its weeds queued or is declined.

## 2. The records

Read the repository's records listed under "Records" in `weeds.md`, as they are on the base: `git show
<base>:<path>` for a file, `git ls-tree -r --name-only <base> -- <folder>` for a folder. Skim summaries and lessons,
not every plan.

- A lesson, correction or finding that appears twice or more: `repeated-lesson`, `--where` the code it is about,
  `--source lesson:<path>:<line>` of each record (one weed per record).
- A milestone, phase or commit that cleaned up a repeated mistake: find the mistake's class (`duplicate-function`,
  `any-type`, ...), then check the code at the base for the mistake today. Present again: the hand fix did not hold.
  Queue each instance under the mistake's class, `--source commit:<sha>` of the clean-up, and skip the places the
  seed list already queued under that class. `repeated-lesson` is for records only, and `weeds.ts` refuses it
  without a `lesson:` source. Absent: queue nothing, but name the class in the report as one with no check behind
  it, if no lint rule, type or test now rejects it.
- A rule in agent instructions or a style guide that the code breaks: `rule-in-prose`.

Done when every record folder that exists has been listed and its lesson and summary files read.

## 3. History

```bash
git log --no-merges --format='%h %s' -n 300 <base>
```

Look for reverts, "again", "still", "re-fix", repeated subjects and clean-up runs. Read the diffs of the commits
they point at, and of the newest 20 commits, with `git show <commit>`; when the tool result says the output was saved
to a file, Read that file to its end. Done when each of those commits is read and its
weeds are queued.

## 4. Record and report

Run the two commands of the tick's step 5, `groups --ready` and `sync --census <sha>`, with `--seeded` added at the
end of `sync`. `--seeded` records in the queue that the seed pass ran, so no clone of the repository seeds again.
When `sync` exits 1 naming seed lines, queue or decline each of them as step 1 says, then run `sync` again.

Done when `sync` exits 0. Then reply with this form, every `<slot>` filled as the list below says. The reply is these
six lines and ends after the last one; the reason for each weed is in its `--note`.

```text
garden: seeded <base> at <short sha>
<the census line>
queued <total> (<class> x<n>, ...); declined <declined>; <unlisted> duplicate names not listed
no check behind: <class>, ...
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:lz-tend <class>
shared: <state> (<reason>)
```

- `<the census line>`: the census output's `census:` line, as printed.
- `queued`: one `<class> x<n>` per class, `<n>` the adds of this seed pass that printed `added`; `<total>` is the
  sum of the `<n>`, and `queued 0` has no parentheses. `<declined>` counts the seed lines declined. `<unlisted>` is
  the `<n>` of the census's
  `<n> more duplicate names not listed` line, or 0.
- `no check behind`: the classes step 2 found cleaned up by hand with nothing that now rejects them, or
  `no check behind: none`.
- `ready to tend` and `shared`: as in the tick's report form (step 5 of `SKILL.md`).
