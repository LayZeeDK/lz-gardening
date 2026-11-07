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

## Update, 2026-11-07: reads moved to the repository

The site is still where every write goes, but a tick no longer reads through it. A garden tick runs as a forked
subagent under the skill's own permission rules, and a practice run showed that every write or `cd` outside the
working directory was refused. So a tick stays in the repository's checkout and reads it with read-only git commands
(`git log`, `git show`, `git ls-tree`, `git rev-parse`) and the Grep and Read tools; the scripts write into the site
by path. Two consequences above change:

- The site's freshness no longer matters to a tick, which reads the repository directly; `site.ts open` does not
  fetch. A tend pass fetches the base into the site when it makes a bed.
- The base comes from the repository's own refs: an explicit `--base`, the base the last census recorded, the
  repository's `origin/HEAD` unless that is its checked-out branch, then `main` or `master`, as `origin/<name>`
  when only the remote has it. It is still never the checked-out branch.
