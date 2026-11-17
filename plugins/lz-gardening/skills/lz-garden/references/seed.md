# Seed pass

Run on every tick until a seed pass is recorded, in this clone or another (`site.ts open` reports `seeded: false`).
The census records every current hit as its starting count, so nothing in it is "new"; the seed pass queues what the
repository already shows instead, so the first tend pass has evidence to work from. Read `weeds.md`, in the same
folder as this file, first. Queue with the tick's step 4 command, and stay in the repository's working directory
throughout. Run all four steps: the records and the history find the weeds the census cannot, so a seed that stops
after the seed list misses them.

## 1. The seed list

With `--seed`, the census output prints the seed list above its JSON line. Each `=` line is either queued or
declined, by the rule in `weeds.md`: queue what spreads or invites copying, and decline only for one of the reasons
it lists, naming that reason. The same suppression with the same reason in two or more files is queued, one weed per
file. Decline with

```bash
node "${CLAUDE_SKILL_DIR}/scripts/weeds.ts" decline --class <class> --where <path> --reason "<why it is no weed>" --census <sha>
```

which keeps the line's weed out of the queue for good. `<sha>` is the census's commit, as in the tick's add command.
When the lines of a class left after its queued weeds share one reason, decline them all in one call: leave out
`--where`, and the command declines every line of that class that no add covers yet and prints
`declined <n> seed lines of <class>`. Queue a class's weeds first, then decline the rest, one call per class.
Duplicate names are the exception: decline each file of a duplicate line on its own, with `--where`.
Both commands take `census:seed` for the seed list's lines alone and refuse it for any other weed, which takes the
source of what it was found in (step 2, and `--source` in `SKILL.md`). `sync --seeded` in step 4 refuses to record the seed while a
line is neither queued nor declined, and names the lines left.

- `= [<pattern>] <path> <count>`: the files with the most hits for that pattern, at most 20 per pattern. Read a few
  hits; queue one weed, `--class <pattern>`, `--where <path>`, `--source census:seed`, the note naming what the hits
  have in common, or decline it with `--class <pattern> --where <path>`. The census keeps at most 1000 hits per
  pattern, in path order, so for a pattern with more the files are ranked from those 1000. A file off the list whose
  hits share a queued line's root cause is queued too, with `--source commit:<short sha>` of the commit that planted
  it (found as `SKILL.md` says under `--source`), since `census:seed` is for the listed files alone.
- `= duplicate <name>: <path>, <path>, ...`: a name defined at module scope (a definition at the start of its line)
  in more than one file, at most 30 names, those defined in the most files first. Test files (`*.spec.*`,
  `*.test.*`), `.d.ts` declarations and files under dot-directories (`.claude/`, `.github/` and other tool folders,
  often deliberate mirrors of each other) are left out of duplicate names, though their pattern hits count. Take every file of the line, not one of them, through steps 1 to 3 of the tick's step 4
  in `SKILL.md` (its `git show`, the words that make a documented copy), with two differences. A documented copy is
  declined, `--class duplicate-function --where <path> --reason` the words you found, copied as they stand (with
  `--in <record path>` when they are in a record, not in the file), instead of going on a `left out:` line; the
  command refuses words the file or record does not hold at the census's commit, so your own account of why a copy
  differs is no reason to decline it. Every other file is queued with `--source census:seed`, the note naming the
  definition to keep, a file whose `<name>` does a different job included (a naming weed). A last line
  `<n> more duplicate names not listed` counts the rest. Later ticks report only what is new, so the seed list is the
  one time these are listed.

The line after the seed list, `census: <pattern> <count>, ...` or `census: none`, is the report's census line.

Done when every `=` line has its weeds queued or is declined.

## 2. The records

Read the repository's records listed under "Records" in `weeds.md`, as they are on the base. List the whole tree
once, `git ls-tree -r --name-only <base>`, and read every ADR, changelog, lesson file and ledger of findings it
names, wherever it sits, with `git show <base>:<path>`, one call per record sent together in one message (`git show`
of several files runs them together, and a `lesson:` source needs each record's own line numbers); skim plans and
summaries, not every plan. Search a record too
large to read whole with Grep and no `head_limit`, then `git show` the lines you queue from.

- A lesson, correction or finding that appears twice or more: `repeated-lesson`, `--where` the code it is about,
  `--source lesson:<path>:<line>` of each record, one weed per lesson and record: `<line>` is the line that first
  states it in that record, and the record's later lines go in the note. A lesson about no code in this repository
  (a tool, a service or a way of working) takes `--where` the record's own `<path>:<line>`, the same place as its
  source. `repeated-lesson` is for records only, and `weeds.ts` refuses it without a `lesson:` source.
- A milestone, phase or commit that cleaned up a repeated mistake: find the mistake's class (`duplicate-function`,
  `any-type`, ...), then check the code at the base for the mistake today. Present again: the hand fix did not hold.
  Queue each instance under the mistake's class, `--source commit:<sha>` of the clean-up, and skip the places the
  seed list already queued under that class.
- The same clean-up, its mistake absent at the base: queue nothing, and look for the check that keeps it out: Grep
  the base's lint config, compiler config and tests for a rule, flag or test that rejects the class's mistake.
  Finding none, the class is **held by hand**: cleaned up, gone today, and nothing rejects its return. Only such a
  class goes on the report's `held by hand` line; a class with a weed queued in this pass never does, since its
  clean-up did not hold and the queue says so.
- A rule in agent instructions or a style guide that the code breaks: `rule-in-prose`, `--where` the code that
  breaks it, `--source lesson:<path>:<line>` of the rule.

A weed you find in the code while reading a record, one that no record names, is queued as the tick queues it:
`--source commit:<short sha>` of the commit that planted it. `census:seed` belongs to the seed list's lines alone.

Done when the tree has been listed and every ADR, changelog, lesson file and ledger in it read or searched.

## 3. History

```bash
git log --no-merges --format=%h%x20%p%x20%s -n 300 <base>
```

Each line is a commit's short id, its parent's short id (none for the first commit) and its subject.

Look for reverts, "again", "still", "re-fix", repeated subjects and clean-up runs. Then read the diffs of the newest
20 commits a page at a time, as the tick's step 3 reads its range, with a budget of 72,000 characters (three pages):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" <commit>..<sha> --chars 72000
```

`<commit>` is the 21st line's commit in the log above, and `<sha>` the census's commit; with 21 lines or fewer, take
the last line's commit, which the range leaves out. Read every page, one call per page, with the same `--chars`.
The commits page 1 marks `skip` stay unread: count them for the report, and read none of them with `git show`.

Then read the commits pointed at that the pages did not show: each clean-up commit step 2 named and each commit the
log scan above flagged, up to five, the clean-ups first. Read each in one page, `<parent>` the second id on the
commit's line in the log (`diffs.ts` takes two commit ids and nothing else, so not `<commit>~1`):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/diffs.ts" <parent>..<commit> --chars 24000
```

A commit that marks `skip` there is too large for the seed pass, and a commit with no parent cannot be read this way:
count either as unread too, and count the pointed-at commits past the first five as unread. Done when the pages and
the pointed-at commits are read and the weeds they show are queued.

## 4. Record and report

Start this step only once steps 1 to 3 are done. Run the two commands of the tick's step 5, `groups --ready` and
`sync --census <sha>`, with `--seeded` added at the end of `sync`. `--seeded` records in the queue that the seed pass
ran, so no clone of the repository seeds again: a weed steps 2 and 3 would have found after it is never looked for.
When `sync` exits 1 naming seed lines, queue or decline each of them as step 1 says, then run `sync` again.

Done when `sync` exits 0. Then reply with this form, every `<slot>` filled as the list below says. The reply is these
seven lines and ends after the last one; the reason for each weed is in its `--note`.

```text
garden: seeded <base> at <short sha>
<the census line>
queued <total> (<class> x<n>, ...); declined <declined>; <unlisted> duplicate names not listed; <unread> commits unread; <read> of <pointed> pointed-at commits read
held by hand: <class>, ...
not done: <step> (<what>), ...
ready to tend: <class> (<open> open, <places> places), ...  -> /lz-gardening:lz-tend <class>
shared: <state> (<reason>)
```

- `<the census line>`: the census output's `census:` line, as printed.
- `queued`: one `<class> x<n>` per class, `<n>` the adds of this seed pass that printed `added`; `<total>` is the
  sum of the `<n>`, and `queued 0` has no parentheses. `<declined>` counts the pattern lines and the duplicate files
  declined. `<unlisted>` is the `<n>` of the census's `<n> more duplicate names not listed` line, or 0. `<unread>`
  counts the commits step 3 left unread, or 0. `<pointed>` counts the commits step 3 found pointed at, and `<read>`
  those it read.
- `held by hand`: the classes step 2 found held by hand, as it defines, or `held by hand: none`.
- `not done`: each part of steps 1 to 3 that you skipped or cut short (a file not shown, a record not read, a weed
  you could not queue, a step run out of order), named by step, or `not done: none`. A step that ran in full and
  found nothing is done.
- `ready to tend` and `shared`: as in the tick's report form (step 5 of `SKILL.md`).
