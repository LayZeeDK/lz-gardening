# The garden is shared through the repository's remote as a grow-only set of events under refs/garden/*

Any clone of a repository (developers' machines, manual runs, `/loop`, CI) may garden at the same time, so the garden
log is a set of immutable event files, one per event, in a commit at `refs/garden/log`; the census and the beds sit
beside it at `refs/garden/census` and `refs/garden/beds/<class>`. Each site keeps a full copy, merges by the union of
event files, and pushes the log only as a fast-forward, so every copy that has synced replays the same statuses. Each
add records what its writer saw (the closes of its weed and the latest tend pass of its class), because a replay in
any shared order, file order or a logical clock, gives the wrong status for an add made beside a close, a tend pass or
a keep.

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

- Something is pushed: the garden's own refs, never the repository's branches. No argument names a remote, a URL or
  a ref to push: the scripts push only their fixed `refs/garden/*` refs, so a skill's existing rule for them cannot
  push anything else. `git config lzGardening.share false` keeps a repository's garden local.
- Nothing on GitHub can protect `refs/garden/*` from deletion; every site holds a full copy, and the next sync of any
  clone puts a deleted ref back. Resetting a garden therefore means deleting it in every site too.
- A mistaken event is never removed, only answered by a later one, as a close answers an add. Sync depends on it:
  a log whose commit already contains the other's, or that holds every event file of the other, has nothing to
  merge. Removing an event would let the next sync drop it silently.
- Any clone can write an event and none can remove one, so readers keep the writers' rules: an event the scripts
  would not write (an add whose id is not its weed id, a close whose `ids` list is empty, a blank reason or check, a
  layer outside 1 to 6, and the rest site.md lists) is skipped and named, and a close ends only the weeds of its own
  class. Each write is read back through the same parser first, so a writer never shares an event every reader skips.
- An event file that holds different content in two copies keeps the remote's content, and sync names it. A file in
  the remote's log that is neither `garden.json` nor an event file is named and left out of the merge, so the next
  push drops it from the remote's tip.
- The union of two logs is a merge commit, so the remote log's history grows by every local write, not one commit
  per sync. Nothing reads that history; replicas read only the tree.
- Of two censuses, the one whose base commit descends from the other's is kept. A sync adopts the remote's census
  unless the local one strictly descends from it. A new census is recorded when its base descends from the remote's,
  when neither descends from the other, or when the checkout lacks the remote's base commit. After a force-push to the
  base, a clone that has not fetched the rewrite and one that has can replace each other's census on every tick until
  the stale clone fetches. Nothing is lost: adds dedupe and the ranges are read again. Keeping the remote's census
  instead would leave a clone without the old history, such as CI, stuck on a census from before the rewrite.
- A claim expires after 6 hours, so a crashed pass blocks its class that long. Since no event is removed, readers keep
  that bound too: a claim whose end is more than 6 hours after its own time is skipped, and one whose end is more than
  7 hours after the reader's clock is not live, so no writer, nor one whose clock ran ahead, holds a class for good.
  The extra hour is for clocks: a claim another process or machine took after the reader read the time ends more
  than 6 hours after the reader's clock. Measured on 2026-11-14: with a 6-hour bound, two claim processes started
  together both claimed the class in one of five rounds, as each dropped the other's claim as dated in the future.

## Update, 2026-11-13: claims, shared beds and what the garden may publish

- A claim that loses the race is answered by a release, not deleted from the replica, since sync depends on no event
  being removed. A claim whose push failed (offline, read-only, behind, or timed out after the remote took it) is
  released too, and the release is pushed once more, so a claim left on the remote does not block its class for 6 hours.
- The look for another writer's claim reads the remote's log as fetched, not this site's tip from before the merge:
  when both sides hold new events, the merged tip is a new commit, and a look at the old local tip misses the very
  claim it exists for.
- `claim`, `close`, `close-class` and `bed` sync once before they plan, so none of them acts on a replica that has not
  seen a newer claim of the class. Only `close-class` releases the holder's claim; a `close --id` in the middle of a
  pass leaves the class held. `close-class` and `bed` share one precondition: the first sync is `synced` or `local`
  and this writer then holds a live claim of the class, else exit 1. Planning on a stale replica (a `behind` sync) let
  a close by a writer with no claim reach `origin` under another writer's live claim, which then blocked the class
  for 6 hours with nothing open to close; the sync pushes a close without looking at claims, so the refusal has to
  come before the plan. `close --id` keeps no such check: it closes single weeds and ends no claim.
- Beds are pushed after the log, in a push of their own, each bed ref on its own outcome. A bed the remote refuses
  (such as a workflow file a CI token may not push) or that is not a fast-forward is named and left out; it never
  blocks the log. Which bed to push comes from the latest tended close of its class in the merged log. A shared bed
  that is gone while its close is already shared stays gone: someone deleted it after landing it.
- The garden is as public as the repository, and its events are never removed. A claim's holder is `lzGardening.name`
  when the checkout sets it, else `writer` and the first 8 characters of the site's random writer id; never
  `user.name`, which the user did not set for the garden, and never a hostname. Log and census commits are authored
  `lz-gardening <>` unless the checkout sets both `lzGardening.name` and `lzGardening.email`; bed commits keep the
  user's identity, as they are code for review. An event field holding this machine's home folder, the checkout's
  path or the site's path is refused, and `--check`, `--where` and a lesson's path take repository-relative paths
  only. Paths match in any case, with runs of slashes or backslashes as one, and with a drive in Git Bash's `/d/`
  form. A census whose base commit no branch fetched from `origin` holds stays local. A bed may bring `origin` only
  its own commits, the ones made in the site, which the checkout's object store lacks; one that would bring any
  commit the checkout holds stays local, whatever holds it (a branch, a tag, a reflog, another remote), since asking
  which refs hold the base missed every holder the question did not name. A bed whose commits add a line or a message
  holding one of those paths stays local too, merges and binary files included, with the diff read by its structure
  rather than its line prefixes. Sync names each kept bed on stderr.

## Update, 2026-11-18: paths are checked twice and stored in their plain form

An event is never removed, so the form a path is stored in, and any machine path that reaches an event, stays on the
remote for good.

- `--where` and `--check` are stored in their plain form: `./src/a.ts` and `src//a.ts` as `src/a.ts`. Before, two
  spellings of one path gave a weed two ids, and `add` with `--source census:seed` and `decline` refused a `--where`
  spelled with `./` as off the seed list.
- A path is taken only when it is repository-relative both as given and in its plain form, with `\` read as `/`.
  Checking it as given alone missed a root, drive or `~` hidden behind `./` or `.\`: `./c:/Users/<name>/a.ts` was
  taken and, once paths were stored plain, stored as a machine path. Checking the plain form alone is weaker, as the
  form given refuses any `..` segment, while normalizing resolves `a/../b` to `b`.
- The stored plain form keeps each `\` as it is, since a backslash is a legal file name character on Linux and macOS;
  only the check reads it as `/`. So a name such as `.\c:` is refused there though it is legal, which errs on the
  safe side.
