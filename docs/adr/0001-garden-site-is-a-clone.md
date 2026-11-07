# The garden site is a separate clone, not a branch or worktree of the repository

The gardener runs on a loop in repositories where other agents may be committing around the clock, so it works in
a local clone beside the repository (`../<repo>.garden`) and reads the repository only through that clone's
`origin`. Its queue and census live on an orphan `garden` branch in the clone, and each tend pass gets a worktree of
the clone. Nothing is pushed: a human fetches a bed's branch into the repository.

## Considered Options

- **A worktree of the repository.** Shares the repository's refs, stashes and worktree list, so the gardener's
  branches show up in every agent's `git branch` and `git worktree list`, and a stray `git worktree prune` or
  branch cleanup by another agent can remove them.
- **Files in the repository's checkout (a `.garden/` folder on the working branch).** Every tick would dirty the
  checkout other agents are working in, and the queue would land in whatever branch is checked out.
- **Queue outside git (a user-level data folder).** Loses history, and the human cannot fetch the queue or a bed
  the way they fetch any other branch.

## Consequences

- The site's view of the repository is only as fresh as its last `git fetch`, which each tick runs first.
- The base branch comes from the clone's `origin/` refs, never from the repository's checked-out branch, which in
  a busy repository is usually a feature branch in flight.
- Deleting the site loses the queue unless the `garden` branch was fetched into the repository first.
- One gardener per site: two loops on one site race on the queue's commits.
