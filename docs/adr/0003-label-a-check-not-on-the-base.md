# A regrown weed's check is labelled when it is not on the base, judged by patch ids in the checkout

A weed that comes back before its tend pass's bed lands is regrown. It read as if the bed's check had failed, though
that check never ran on the base. So `weeds add` and `weeds list` end the check with ` not on the base` when the
bed's change to its check is missing from the census commit. A base with no file at the check's path is missing it
too. The weed stays regrown, because the remedy is still to tend the class again in the same bed.

The bed's change is on the base in any of these cases:

- The bed's change to the check since it split off the base is empty: a merge or a fast-forward landed it, or the bed
  left the check as it was.
- One base commit has the patch id of the whole change: a squash.
- Each bed commit that touched the check has a base commit with its patch id: a rebase or a cherry-pick.
- The bed created the check's file, and the base has a file at that path.

Patch ids come from diffs without context lines, so a base edit next to the check does not hide a landing.

Git runs in the repository's checkout, which holds the census commit. The garden site holds the bed's commits but only
the base it last fetched. The site's objects reach the checkout's git through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, with
lazy fetch off, so git writes to neither.

## Considered Options

- **Hold such a weed back with a new `pending` status.** Takes it out of regrown while the remedy is still to tend the
  class again, loses the link to the pending bed, and adds a status to the queue format.
- **Ancestry alone.** Misses every rebase and squash landing.
- **One base commit that carries the bed's path-limited change.** Wrong on a squash that also edited the check, and
  on a revert.
- **Run git in the garden site.** The site need not hold the census commit, which the tick took from the checkout.

## Consequences

- The label is advisory. No label means either that the change landed or that the label could not tell: no readable
  census, a missing commit, a bed that shares no history with the base, a check the command line would refuse, or a
  check that names no file at the bed's commit. The weed is queued and listed either
  way.
- A check file the bed created reads as on the base as soon as the base has a file at that path, whatever it holds.
- A bed change that exists only in a merge commit, such as a merge resolved or edited by hand in the bed, is not seen,
  so its weeds get no label even when the base lacks the change. The clean merges `site.ts bed` makes cannot cause
  this.
- A change the base took split or combined differently from the bed's commits reads as not on the base.
