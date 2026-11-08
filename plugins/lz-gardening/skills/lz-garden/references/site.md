# The garden site

Read when opening, creating or cleaning up the garden site, or when making a bed for a tend pass.

The gardener never writes to the repository's checkout. Other agents may be writing there around the clock, and a
gardener branch, worktree or stash in that checkout is one more thing for them to trip over. Its scripts, run from
the checkout, write into a **site** instead: a local clone beside the repository.

```text
<parent>/<repo>/                 the repository (read only; the clone's `origin`)
<parent>/<repo>.garden/          the site: a clone with branch `garden` checked out
  .garden/weeds.jsonl            the weeds queue (scripts/weeds.ts)
  .garden/census.json            the last census (scripts/census.ts)
  .garden/patterns.json          optional: this repository's own census patterns
  .gitignore                     ignores /beds/
  beds/<class>/                  a tend pass's worktree on branch bed/<class>
```

`garden` is an orphan branch: it holds only `.garden/` and `.gitignore`, never the repository's code, so its history
is the gardener's record and nothing else. Bed branches (`bed/<class>`, since git cannot hold a `garden/<class>`
branch beside `garden`) start from the base branch and carry one proposed bed change each. Nothing in the site is
pushed. A human brings a bed home from the repository with `git fetch ../<repo>.garden bed/<class>` and merges it
the way the repository lands work; the `garden` branch can be fetched the same way to keep the queue in the
repository's history.

## Open, commit

`scripts/site.ts` does all of the site's git work, run from the repository's checkout. Run from a linked worktree
of the repository, it uses the one site beside the main checkout:

- `site.ts open [--base <branch>]` creates the site on first use: a clone with no checkout, the repository's
  `user.name` and `user.email` copied in, and the orphan `garden` branch with one plant commit holding
  `.gitignore`. On later runs it leaves the site as it is. It prints JSON with `site`, `created`, `base` and
  `seeded` (whether the `garden` branch holds a commit past the plant). It exits 2 when the repository has no
  `user.name` or `user.email`, so the gardener never commits under a default identity.
- `site.ts commit --message <text>` stages `.garden/` in the site and commits it on `garden`. It prints JSON with
  `committed`, false when nothing changed.

Every git command `site.ts` runs, from the clone to each commit in the site, runs none of the user's git hooks and
signs nothing: the site holds only the garden's own records, and a hook or a signing passphrase would stop a tick
that runs unattended.

The census and the queue are written by their own scripts, through `--out` and `--file` paths into the site.

## The base branch

The base is the branch work lands on. `site.ts open` takes, in order: the `--base` argument; the `rev` recorded
in the site's `.garden/census.json`; the repository's default branch (`origin/HEAD`); `main` when that branch
exists; else `master`. A repository cloned from a local path is the exception: its `origin/HEAD` names whatever
the source had checked out when it was cloned, often a feature or milestone branch in flight, so `open` passes over
it for `main` or `master`.

A branch that only `origin` has (a clone whose checkout is a milestone branch often has `main` only as
`origin/main`) is reported as `origin/<name>`, and every later command reads that ref. A base that resolves to no
commit, or whose name holds a character a shell would expand (anything but letters, digits and `._/+@-`), stops
`open` with exit 2 before it plants anything.

The base names a ref in the repository, not in the site: a tick reads it in the repository's checkout, and
`site.ts bed` fetches it into the site by that name (below).

## Beds (tend passes only)

A garden tick never runs anything in this section or the next. A tend pass makes its bed with `site.ts`, run from
the repository's checkout, and runs no git command against the site itself. Below, `<checkout>` is the repository's
checkout and `<bed>` is `<site>/beds/<class>`, both full paths.

`site.ts bed --class <class> --base <base>` takes the base by the name `site.ts open` reported (`main`, or
`origin/main` when only the repository's remote has it). It fetches the base into the site and adds the worktree
`<bed>` on branch `bed/<class>` at the commit it fetched. Run again on a bed that exists, it keeps the bed's work.
It prints JSON with `bed`, `branch`, `start`, `created` and `deps`. `start` is the commit the bed started from,
written `<start>` below; for a bed that exists, it is where the bed's branch left the base. `bed` exits 2 on a class
that is not a kebab-case class id, on a base that git could read as an option, and when `site.ts open` has not made
the site.

`deps` says how the bed gets its Node.js dependencies:

- `linked`: the bed's `node_modules` is a link to the checkout's. `bed` makes the link when the checkout has a
  `node_modules`, the bed's `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` is byte-identical to the
  checkout's, and the bed is not a workspace: its `package.json` declares no `workspaces` and it has no
  `pnpm-workspace.yaml`. A workspace package resolves through a linked `node_modules` to the repository's checkout,
  so the bed would test the other checkout's code.
- `install`: install with the repository's package manager, pointed at the bed: `npm --prefix "<bed>" ci`,
  `pnpm -C "<bed>" install --frozen-lockfile` or, for Yarn 4 or later, `yarn --cwd "<bed>" install --immutable`.
- `installed`: the bed already has its own install, a `node_modules` folder or the `.pnp.cjs` file of a Yarn
  Plug'n'Play install.
- `none`: the bed has no `package.json`.

When a linked bed changes its dependencies, remove the link first (as under Cleanup), then install. Never run an
install through a link: it rewrites the repository's own `node_modules`.

## Cleanup

A bed stays until its branch is merged into the base or a human drops it. Remove one with: unlink `node_modules`
first (`rm "<bed>/node_modules"`, no `-r`; on Windows `cmd //c rmdir "<bed>\node_modules"`), then
`git -C "<site>" worktree remove "<bed>"`, then `git -C "<site>" branch -D bed/<class>` only once the change has
landed: after `git -C "<site>" fetch -q origin <base>`,
`git -C "<site>" merge-base --is-ancestor bed/<class> FETCH_HEAD` exits 0, or the base holds
a commit that carries the same change. Deleting the whole site loses the
queue unless the `garden` branch was fetched into the repository.

One gardener per site: two sessions looping on one repository append to the same queue and race on its commits.
