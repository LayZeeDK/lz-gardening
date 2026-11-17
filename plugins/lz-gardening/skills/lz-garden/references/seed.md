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
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" decline --class <class> --where <path> --reason "<why it is no weed>" --census <sha>
```

which keeps the line's weed out of the queue for good. `<sha>` is the census's commit, as in the tick's add command.
Both commands take `census:seed` for the seed list's lines alone and refuse it for any other weed, which takes the
source of what it was found in (step 2, and `--source` in `SKILL.md`). `sync --seeded` in step 4 refuses to record the seed while a
line is neither queued nor declined, and names the lines left.

- `= [<pattern>] <path> <count>`: the files with the most hits for that pattern, at most 20 per pattern. Read a few
  hits; queue one weed, `--class <pattern>`, `--where <path>`, `--source census:seed`, the note naming what the hits
  have in common, or decline it with `--class <pattern> --where <path>`. The census keeps at most 1000 hits per
  pattern, in path order, so for a pattern with more the files are ranked from those 1000.
- `= duplicate <name>: <path>, <path>, ...`: a name defined in more than one file, at most 30 names, those defined
  in the most files first. Test files (`*.spec.*`, `*.test.*`) and files under dot-directories (`.claude/`,
  `.github/` and other tool folders, often deliberate mirrors of each other) are left out of duplicate names, though
  their pattern hits count. Take each file of the line through steps 1 to 3 of the tick's step 4 in `SKILL.md`
  (its `git show`, the words that make a documented copy), with two differences: a documented copy is declined,
  `--class duplicate-function --where <path> --reason` the words you found, copied as they stand, instead of going on
  a `left out:` line; and every other file is queued with `--source census:seed`, the note naming the definition to
  keep, a file whose `<name>` does a different job included (a naming weed). A last line
  `<n> more duplicate names not listed` counts the rest. Later ticks report only what is new, so the seed list is the
  one time these are listed.

The line after the seed list, `census: <pattern> <count>, ...` or `census: none`, is the report's census line.

Done when every `=` line has its weeds queued or is declined.

## 2. The records

Read the repository's records listed under "Records" in `weeds.md`, as they are on the base: `git show
<base>:<path>` for a file, `git ls-tree -r --name-only <base> -- <folder>` for a folder. Skim summaries and lessons,
not every plan.

- A lesson, correction or finding that appears twice or more: `repeated-lesson`, `--where` the code it is about,
  `--source lesson:<path>:<line>` of each record (one weed per record). A lesson about no code in this repository
  (a tool, a service or a way of working) takes `--where` the record's own `<path>:<line>`, the same place as its
  source.
- A milestone, phase or commit that cleaned up a repeated mistake: find the mistake's class (`duplicate-function`,
  `any-type`, ...), then check the code at the base for the mistake today. Present again: the hand fix did not hold.
  Queue each instance under the mistake's class, `--source commit:<sha>` of the clean-up, and skip the places the
  seed list already queued under that class. `repeated-lesson` is for records only, and `weeds.ts` refuses it
  without a `lesson:` source. Absent: queue nothing, and look for the check that keeps it out: Grep the base's lint
  config, compiler config and tests for a rule, flag or test that rejects the class's mistake. Finding none, the
  class has **no check behind** it, and only such a class goes on the report's `no check behind` line.
- A rule in agent instructions or a style guide that the code breaks: `rule-in-prose`, `--where` the code that
  breaks it, `--source lesson:<path>:<line>` of the rule.

A weed you find in the code while reading a record, one that no record names, is queued as the tick queues it:
`--source commit:<short sha>` of the commit that planted it. `census:seed` belongs to the seed list's lines alone.

Done when every record folder that exists has been listed and its lesson and summary files read.

## 3. History

```bash
git log --no-merges --format='%h %s' -n 300 <base>
```

Look for reverts, "again", "still", "re-fix", repeated subjects and clean-up runs. Then read the diffs of the newest
20 commits a page at a time, as the tick's step 3 reads its range, with a budget of 72,000 characters (three pages):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" <commit>..<sha> --chars 72000
```

`<commit>` is the 21st line's commit in the log above, and `<sha>` the census's commit; with 21 lines or fewer, take
the last line's commit, which the range leaves out. Read every page, one call per page, with the same `--chars`.
The commits page 1 marks `skip` stay unread: count them for the report, and read none of them with `git show`.

Then read up to five commits the log points at that the pages did not show, one page each:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" <commit>~1..<commit> --chars 24000
```

A commit that marks `skip` there is too large for the seed pass: count it as unread too. Done when the pages are read
and the weeds they show are queued.

## 4. Record and report

Run the two commands of the tick's step 5, `groups --ready` and `sync --census <sha>`, with `--seeded` added at the
end of `sync`. `--seeded` records in the queue that the seed pass ran, so no clone of the repository seeds again.
When `sync` exits 1 naming seed lines, queue or decline each of them as step 1 says, then run `sync` again.

Done when `sync` exits 0. Then reply with this form, every `<slot>` filled as the list below says. The reply is these
six lines and ends after the last one; the reason for each weed is in its `--note`.

```text
garden: seeded <base> at <short sha>
<the census line>
queued <total> (<class> x<n>, ...); declined <declined>; <unlisted> duplicate names not listed; <unread> commits unread
no check behind: <class>, ...
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:lz-tend <class>
shared: <state> (<reason>)
```

- `<the census line>`: the census output's `census:` line, as printed.
- `queued`: one `<class> x<n>` per class, `<n>` the adds of this seed pass that printed `added`; `<total>` is the
  sum of the `<n>`, and `queued 0` has no parentheses. `<declined>` counts the seed lines declined. `<unlisted>` is
  the `<n>` of the census's
  `<n> more duplicate names not listed` line, or 0. `<unread>` counts the commits step 3 left unread, or 0.
- `no check behind`: the classes step 2 found to have no check behind them, as it defines, or
  `no check behind: none`.
- `ready to tend` and `shared`: as in the tick's report form (step 5 of `SKILL.md`).
