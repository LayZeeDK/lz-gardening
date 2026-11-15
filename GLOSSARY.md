# lz-gardening

Gardening a codebase that agents write: noticing the patterns agents copy, and turning each recurring one into a
check so it cannot come back.

## Weeds

**Weed**:
A pattern in the codebase that agents will copy and that makes the codebase worse each time it spreads.
_Avoid_: smell, finding, issue, slop

**Weed class**:
The named kind a weed belongs to, such as a duplicate function or a hollow test; weeds are grouped, counted and
tended by class. Each class has a kebab-case class id, and is found either by a census pattern or only by reading
what landed.
_Avoid_: category, kind, type

**Planting commit**:
The commit that introduced a weed; a weed found by reading what landed names it as its source.

**Duplicate function**:
A function name defined in two or more files of the codebase. A function declaration and a `const` bound to an arrow
function or a function expression count alike.
_Avoid_: copy, clone

**Close**:
Taking weeds off the queue, as one of three kinds: tended (a tend pass added a check and names it), one-off (no
check was written), or kept.

**Regrown**:
Said of a weed of a class a tend pass closed, wherever it comes back; the check that was meant to hold it did not.
A weed of a class only ever closed as a one-off is new, not regrown: no check was written to hold it. When the
weed reads `not on the base`, the bed's change to its check is not on the base the census was taken of: the bed has
not landed, or the check's file is gone from the base. When it reads `base unknown`, the site could not tell.

**Kept**:
Said of a weed a human or a tend pass judged deliberate; it is never queued again.

**Place**:
The file a weed sits in, its `--where` without the line. Six weeds in one file are six weeds in one place.

**Ready to tend**:
Said of a weed class whose open weeds sit in two or more places: several agents took the same shortcut. A class
whose open weeds all sit in one place waits for a second.

**One-off**:
Weeds judged an isolated occurrence rather than a pattern agents copy: they share no cause, or sit in one place. A
one-off is closed with no check written.

## Watching

**Gardener**:
The agent that watches the codebase and queues weeds, without changing code.
_Avoid_: sampler, reviewer, janitor

**Tick**:
One run of watching: a census, a reading of what landed since the last tick, and the weeds queued from both.
_Avoid_: scan, pass, garden pass

**Seed pass**:
The tick that queues the weeds already present in a codebase, from the census, the records and the history, instead
of only what is new. Every tick runs it until one has been recorded.

**Census**:
A count of every census pattern's hits, and of duplicate functions, at one commit of the base branch. Each tick
compares its census with the garden's census, the one recorded in the site's ref `refs/garden/census` and shared
through the repository's `origin` like the garden log.
_Avoid_: scan, inventory

**Census pattern**:
A text pattern that marks a weed class the census can count, such as a lint suppression.

**Hit**:
One line on the base branch where a census pattern matches.
_Avoid_: weed marker, match

**Seed list**:
What the census shows the seed pass: for each census pattern, the files with the most hits, and the names
defined in the most files.
_Avoid_: baseline (a baseline is what a check tolerates)

**Queue**:
The grow-only set of events (adds, closes, claims, releases and seeds) that a replay turns into the weeds and their
statuses, each weed with its file and line, its source and the root cause it points to. Weeds leave the queue only
by being closed, never by being edited.
_Avoid_: ledger, backlog, weeds file

**Event**:
One entry in the queue: an add, close, claim, release or seed, written once by one writer and never edited. Its
clock orders it against the others only where "earliest" or "latest" matters.
_Avoid_: row, record (records are the repository's own)

**Writer**:
A garden site that adds events to the queue, named by an id of its own in the site's git config
(`lzGardening.writer`) that its claims carry. Two clones of one repository are two writers.

**Records**:
What the repository writes down about its own work: plans, summaries, lessons, decisions, agent instructions and
commit history. The gardener reads them as evidence and never edits them.

**Sampling**:
Reading a share of what landed rather than all of it, and judging the whole by it.

## Tending

**Tend pass**:
The work of taking one weed class, adding the check that rejects it, proving the check on a real weed, and fixing
or baselining every instance.
_Avoid_: fix pass, clean-up, weeding

**Check**:
Anything that rejects a weed mechanically: code structure, a type, a compiler flag, a lint rule, a test.
_Avoid_: guard (that is an agent guard), fence

**Layer**:
Where a correction lives, one of six, strongest first: codebase, static analysis, agent guards, agent
instructions, skills, and style guide. A tend pass uses the strongest layer that can hold the weed class.
_Avoid_: level, tier

**Agent guard**:
A hook or permission that stops an agent from writing a weed or bypassing a check. Proposed by a tend pass, built by
a human.

**Claim**:
A writer's hold on one weed class for one tend pass, an event naming the class, the writer, its holder (the
checkout's `lzGardening.name`, else `writer` and the first 8 characters of the writer id) and an end six hours on.
The earliest live claim of a class owns it; a claim by the same writer renews it. It ends with a close of the class
by its writer, a release, or its end time. A bed is made and a class closed only under one's own claim.
_Avoid_: lock, lease

**Paved road**:
The one sanctioned way to do a thing in the codebase, made easier to follow than any shortcut.
_Avoid_: golden path, happy path

**Baseline**:
The recorded weed instances, or their count, that a check tolerates for now. It may only shrink.
_Avoid_: allowlist, exceptions file

**Starting results**:
The summary lines of the repository's lint, type-check and test commands, run in a bed before its first edit, so a
failure that predates a tend pass is not blamed on it.
_Avoid_: baseline (a baseline is what a check tolerates)

## Places

**Base branch**:
The branch work lands on, which a tick watches and a bed starts from. Short form: base.
_Avoid_: target branch

**Garden site**:
A clone of the repository beside it that holds the queue, the census and the beds, so the gardener's own work stays
out of the repository's checkout.
_Avoid_: garden clone, workspace

**Garden branch**:
The site's branch, which holds only the ignore rule for the beds, never the repository's code. The queue and the
census are not on it: they live in the refs `refs/garden/log` and `refs/garden/census`.

**Garden log**:
The site's ref `refs/garden/log`, whose commits hold the queue's events, one file each, and the format file
`garden.json`. It is a ref, not a branch or a folder, so nothing checks it out.
_Avoid_: weeds file, queue branch

**Shared log**:
The garden log on the repository's `origin`, under the same ref. A site syncs with it: fetches it, merges it into its
own garden log and pushes the result back.
_Avoid_: remote queue, garden remote

**Share state**:
What a sync says about the shared log: `local`, `synced`, `offline`, `read-only` or `behind`.
_Avoid_: sync status

**Bed**:
A tend pass's working copy and branch in the garden site, holding one proposed change for a human to land. Its
branch is the bed branch, `bed/<class>`. A sync shares the bed of a tended close as `refs/garden/beds/<class>` on the
repository's `origin`, the shared bed, which the next bed of the class in any clone starts from.
_Avoid_: patch, fix branch
