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
The commit that introduced a weed; a weed found in the code names it as its source.

**Source**:
What a weed was found through: a commit (the one that planted it, or a clean-up that did not hold), a line of the
records, or a line of the seed list.

**Duplicate function**:
A function name defined at module scope in two or more files of the codebase.
_Avoid_: copy, clone

**Naming weed**:
A function that shares a duplicate function's name but does another job; a rename that says its job fixes it.

**Documented copy**:
A file's own definition of a duplicate function, kept on purpose: words in that file or one beside it say why the
file cannot use the shared one (it runs alone, it cannot import), or a record says so.

**Close**:
Taking weeds off the queue, as one of three kinds: tended (a tend pass added a check and names it), one-off (no
check was written), or kept.

**Open**:
Said of a queued weed that no close has ended yet.

**Seen**:
Said of a weed a tick finds again while it is still open; it is not queued twice.

**Regrown**:
Said of a weed of a class a tend pass closed, wherever it comes back; the check that was meant to hold it did not.
A weed of a class only ever closed as a one-off is new, not regrown: no check was written to hold it.

**Kept**:
Said of a weed taken off the queue for good with no check: a human or a tend pass judged it deliberate, or a seed
pass declined it. It is never queued again.

**Place**:
The file a weed sits in. Six weeds in one file are six weeds in one place.

**Ready to tend**:
Said of a weed class whose open weeds sit in two or more places: several agents took the same shortcut, and a tend
pass may take the class unless another writer claims it or it is tended its own way (a stale verification, a repeated
lesson). A class whose open weeds all sit in one place waits for a second.

**One-off**:
Weeds judged an isolated occurrence rather than a pattern agents copy: they share no cause, or sit in one place. A
tick leaves a one-off out and a seed pass declines it; a queued one, or a weed that work outside a tend pass
resolved, gets a one-off close, with no check written.

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
compares its census with the garden's census, the last one recorded, which is shared like the garden log.
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

**Decline**:
To leave a seed line, or one file of a duplicate name's line, out of the queue on purpose, with a reason. Its weed is
recorded as kept, so no later tick queues it.
_Avoid_: skip, dismiss

**Queue**:
The weeds waiting to be tended, each with its file and line, its source and the root cause it points to. Weeds leave
the queue only by being closed, never by being edited.
_Avoid_: ledger, backlog, weeds file

**Event**:
One entry in the garden log: an add, close, claim, release or seed, written once by one writer and never edited.
Together the events give the queue and each weed's status.
_Avoid_: row, record (records are the repository's own)

**Writer**:
A garden site that adds events to the garden log, named by an id of its own that its claims carry. Two clones of
one repository are two writers.

**Records**:
What the repository writes down about its own work: plans, summaries, lessons, decisions, agent instructions and
commit history. The gardener reads them as evidence and never edits them.

**Held by hand**:
Said of a weed class a clean-up removed that is absent at the base, with no check to reject its return.
_Avoid_: no check behind

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
A writer's hold on one weed class for one tend pass, for six hours unless renewed; the earliest live claim of a
class owns it. A bed is made and a class closed only under one's own claim.
_Avoid_: lock, lease

**Paved road**:
The one sanctioned way to do a thing in the codebase, made easier to follow than any shortcut.
_Avoid_: golden path, happy path

**Baseline**:
The recorded weed instances, or their count, that a check tolerates for now. It may only shrink.
_Avoid_: allowlist, exceptions file

**Held**:
Said of a weed a tend pass's check now rejects; the tended close closes it. Unlike a class held by hand, a check
holds it.

**Baselined**:
Said of a weed whose copy a check's baseline tolerates; it stays open for the pass that shrinks the baseline.

**Starting results**:
The summary lines of the repository's lint, type-check and test commands, run in a bed before its first edit, so a
failure that predates a tend pass is not blamed on it.
_Avoid_: baseline (a baseline is what a check tolerates)

## Places

**Base branch**:
The branch work lands on, which a tick watches and a bed starts from. Short form: base.
_Avoid_: target branch

**Garden site**:
A clone of the repository beside it that holds the garden log, the census and the beds, so the gardener's own work stays
out of the repository's checkout.
_Avoid_: garden clone, workspace

**Garden branch**:
The site's branch, which holds only the ignore rule for the beds, never the repository's code. The garden log
and the census are not on it: each is a ref of its own.

**Garden log**:
The site's ref `refs/garden/log`, which holds the garden's events, a set that only grows. It is a ref, not a branch
or a folder, so nothing checks it out.
_Avoid_: weeds file, queue branch

**Shared log**:
The garden log on the repository's `origin`, under the same ref. A site syncs with it: fetches it, merges it into its
own garden log and pushes the result back.
_Avoid_: remote queue, garden remote

**Share state**:
What a sync says about the shared log: `local`, `synced`, `offline`, `read-only` or `behind`.
_Avoid_: sync status

**Bed**:
A tend pass's working copy and branch in the garden site, holding one proposed change for a human to land. A sync
shares the bed of a tended close as the shared bed, which the next bed of its class in any clone starts from.
_Avoid_: patch, fix branch
