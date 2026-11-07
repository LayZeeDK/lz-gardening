# The garden site

Read when opening, creating or cleaning up the garden site, or when making a bed for a tend pass.

The gardener never works in the repository's checkout. Other agents may be writing there around the clock, and a
gardener branch, worktree or stash in that checkout is one more thing for them to trip over. It works in a **site**:
a local clone beside the repository.

```text
<parent>/<repo>/                 the repository (read only, through the clone's `origin`)
<parent>/<repo>.garden/          the site: a clone with branch `garden` checked out
  .garden/weeds.jsonl            the weeds queue (scripts/weeds.ts)
  .garden/census.json            the last census (scripts/census.ts)
  .garden/patterns.json          optional: this repository's own census patterns
  .gitignore                     ignores /beds/
  beds/<class>/                  a tend pass's worktree on branch garden/<class>
```

`garden` is an orphan branch: it holds only `.garden/` and `.gitignore`, never the repository's code, so its history
is the gardener's record and nothing else. Bed branches (`garden/<class>`) start from the base branch and carry one
proposed bed change each. Nothing in the site is pushed. A human brings a bed home from the repository with
`git fetch ../<repo>.garden garden/<class>` and merges it the way the repository lands work; the `garden` branch can
be fetched the same way to keep the queue in the repository's history.

## Open or create

Run from the repository's checkout (the session's working directory). Bash:

```bash
repo=$(git rev-parse --show-toplevel)
site="$(dirname "$repo")/$(basename "$repo").garden"
```

When `$site/.garden` exists, the site is open: `cd "$site"`, run `git fetch --prune origin`, and confirm the branch
is `garden` (`git branch --show-current`). Done when `git rev-parse --verify origin/<base>` prints a commit.

Otherwise create it:

```bash
git clone --no-checkout "$repo" "$site"
cd "$site"
git config user.name "$(cd "$repo" && git config user.name)"
git config user.email "$(cd "$repo" && git config user.email)"
git switch --orphan garden
mkdir .garden
printf '/beds/\n' > .gitignore
git add .gitignore
git commit -m "garden: plant"
```

The identity comes from the repository so the gardener commits as the repository's owner commits; if either value
is empty, stop and report it rather than commit under a default identity.

## The base branch

The base is the branch work lands on, read through `origin/` in the site. Take, in order: the `--base` argument; the
`rev` recorded in `.garden/census.json` (strip `origin/`); the repository's default branch (`git symbolic-ref
--short refs/remotes/origin/HEAD` run in the repository, minus `origin/`), unless it names the branch checked out
in the repository (`git branch --show-current` there); `main` if `origin/main` exists in the site; else `master`.
Never take the repository's currently checked-out branch: in a repository that agents are working in, that is a
feature or milestone branch in flight. A repository cloned from a local path reports that very branch as its
default, because its `origin/HEAD` follows the source's checkout.

## Beds (tend passes only)

```bash
git worktree add -b garden/<class> beds/<class> origin/<base>
```

Dependencies for a bed, Node.js repositories:

- **Link** the repository's `node_modules` when the bed's lockfile is byte-identical to the repository's
  (`cmp -s "$repo/package-lock.json" beds/<class>/package-lock.json`, or the pnpm or yarn lockfile) and the root
  `package.json` declares no `workspaces` (and there is no `pnpm-workspace.yaml`). On Windows:
  `cmd //c mklink //J "<bed>\node_modules" "<repo>\node_modules"` with backslash paths; elsewhere `ln -s`.
- **Install** with the repository's package manager (`npm ci`, `pnpm install --frozen-lockfile`) otherwise, and
  always when the bed changes dependencies. A workspace package resolves through a linked `node_modules` to the
  repository's checkout, so the bed would test the other checkout's code.
- Never run an install through a link: it rewrites the repository's own `node_modules`.

## Cleanup

A bed stays until its branch is merged into the base or a human drops it. Remove one with: unlink `node_modules`
first (`rm <bed>/node_modules`, no `-r`; on Windows `cmd //c rmdir "<bed>\node_modules"`), then
`git worktree remove beds/<class>`, then `git branch -D garden/<class>` only once `git branch -r --contains
garden/<class>` or a merged commit in `origin/<base>` shows the change landed. Deleting the whole site loses the
queue unless the `garden` branch was fetched into the repository.

One gardener per site: two sessions looping on one repository append to the same queue and race on its commits.
