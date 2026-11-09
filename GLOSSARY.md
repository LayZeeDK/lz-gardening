# lz-gardening

Gardening a codebase that agents write: noticing the patterns agents copy, and turning each recurring one into a
check so it cannot come back.

## Weeds

**Weed**:
A pattern in the codebase that agents will copy and that makes the codebase worse each time it spreads.
_Avoid_: smell, finding, issue, slop

**Weed class**:
The named kind a weed belongs to, such as a duplicate helper or a hollow test; weeds are grouped, counted and
tended by class. Each class has a kebab-case class id, and is found either by a census pattern or only by reading
what landed.
_Avoid_: category, kind, type

**Planting commit**:
The commit that introduced a weed; a weed found by reading what landed names it as its source.

**Duplicate helper**:
A function name defined in two or more files of the codebase.
_Avoid_: copy, clone

**Regrown**:
Said of a weed that came back after a tend pass closed it; the check that was meant to hold it did not.

**Kept**:
Said of a weed a human or a tend pass judged deliberate; it is never queued again.

**Ready to tend**:
Said of a weed class with two or more open weeds: several agents took the same shortcut. A class with one open weed
is a one-off and waits.

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
A count of every census pattern's hits, and of duplicate helpers, at one commit of the base branch. Each tick
compares its census with the last one.
_Avoid_: scan, inventory

**Census pattern**:
A text pattern that marks a weed class the census can count, such as a lint suppression.

**Hit**:
One place on the base branch where a census pattern matches.
_Avoid_: weed marker, match

**Seed list**:
What the census shows the seed pass: for each census pattern, the files with the most hits, and the names
defined in the most files.
_Avoid_: baseline (a baseline is what a check tolerates)

**Queue**:
The append-only list of weeds, each with its place, its source and the root cause it points to. Weeds leave the
queue only by being closed, never by being edited.
_Avoid_: ledger, backlog, weeds file

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
One of six places a correction can live, strongest first: codebase, static analysis, agent guards, agent
instructions, skills, and style guide. A tend pass uses the strongest layer that can hold the weed class.
_Avoid_: level, tier

**Agent guard**:
A hook or permission that stops an agent from writing a weed or bypassing a check. Proposed by a tend pass, built by
a human.

**Paved road**:
The one sanctioned way to do a thing in the codebase, made easier to follow than any shortcut.
_Avoid_: golden path, happy path

**Baseline**:
The recorded weed instances, or their count, that a check tolerates for now. It may only shrink.
_Avoid_: allowlist, exceptions file

## Places

**Base branch**:
The branch work lands on, which a tick watches and a bed starts from. Short form: base.
_Avoid_: target branch

**Garden site**:
A clone of the repository beside it that holds the queue, the census and the beds, so the gardener's own work stays
out of the repository's checkout.
_Avoid_: garden clone, workspace

**Garden branch**:
The site's branch that holds only the garden's records, never the repository's code.

**Bed**:
A tend pass's working copy and branch in the garden site, holding one proposed change for a human to land. Its
branch is the bed branch, `bed/<class>`.
_Avoid_: patch, fix branch
