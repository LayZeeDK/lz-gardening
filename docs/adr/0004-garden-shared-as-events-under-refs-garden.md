# The garden is shared through the repository's remote as a grow-only set of events under refs/garden/*

Any clone of a repository (developers' machines, manual runs, `/loop`, CI) may garden at the same time, so the queue
is a set of immutable event files, one per event, in a commit at `refs/garden/log`; the census and the beds sit beside
it at `refs/garden/census` and `refs/garden/beds/<class>`. Each site keeps a full copy, merges by the union of event
files, and pushes only fast-forwards, so every copy that has synced replays the same statuses. Each add records what
its writer saw (the closes of its weed and the latest tend pass of its class), because a replay in any shared order,
file order or a logical clock, gives the wrong status for an add made beside a close, a tend pass or a keep.

## Considered Options

- **A shared `garden` branch, merged and pushed from the site's working tree.** A branch shows in every
  `git branch -a`, falls to branch cleanup and `push --prune` from clones that never fetched it, and a repository rule
  set for all branches can refuse the gardener's unsigned direct pushes. A working tree also keeps one gardener per
  site, since two runs share its index and any rebase in progress.
- **Replay ordered by a logical clock (Lamport) or by the commit graph.** Measured wrong in 3 of 7 concurrent
  scenarios: an add beside a close, beside a tend pass, and beside a keep. The commit graph also needs full history on
  every reader.
- **The census as an event in the log.** A census holds up to about a megabyte of hits and is taken every tick; in a
  set that never deletes, that growth never ends. The census is one replaceable commit instead, kept by ancestry of
  the base commits it read.
- **A claim as its own ref per class, created by a push that fails when the ref exists.** Release and expiry then
  need deletes and forced pushes on a ref other clones may hold stale, a second mechanism beside the event log.
  Claims are events, and one owner comes from the push itself: a clone whose push is rejected fetches, and yields
  when another claim of the class is now visible (measured: one owner in 20 of 20 races; without the look, two).

## Consequences

- Something is pushed: the garden's own refs, never the repository's branches. The scripts take no remote, ref or
  path argument, so a skill's existing rule for them cannot push anything else. `git config lzGardening.share false`
  keeps a repository's garden local.
- Nothing on GitHub can protect `refs/garden/*` from deletion; every site holds a full copy, and the next sync of any
  clone puts a deleted ref back. Resetting a garden therefore means deleting it in every site too.
- A mistaken event is never removed, only answered by a later one, as a close answers an add. Sync depends on it:
  a log whose commit already contains the other's, or that holds every event file of the other, has nothing to
  merge. Removing an event would let the next sync drop it silently.
- An event file that holds different content in two copies keeps the remote's content, and sync names it. A file in
  the remote's log that is neither `garden.json` nor an event file is named and left out of the merge, so the next
  push drops it from the remote's tip.
- The union of two logs is a merge commit, so the remote log's history grows by every local write, not one commit
  per sync. Nothing reads that history; replicas read only the tree.
- A claim expires after 6 hours, so a crashed pass blocks its class that long.
