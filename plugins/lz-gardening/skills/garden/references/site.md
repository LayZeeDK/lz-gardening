# The garden site

Read when opening, creating or cleaning up the garden site, or when making a bed for a tend pass.

The gardener never writes to the repository's checkout. Other agents may be writing there around the clock, and a
gardener branch, worktree or stash in that checkout is one more thing for them to trip over. Its scripts, run from
the checkout, write into a **site** instead: a local clone beside the repository.

```text
<parent>/<repo>/                 the repository (read only, through the clone's `origin`)
<parent>/<repo>.garden/          the site: a clone with branch `garden` checked out
  .garden/weeds.jsonl            the weeds queue (scripts/weeds.ts)
  .garden/census.json            the last census (scripts/census.ts)
  .garden/patterns.json          optional: this repository's own census patterns
  .gitignore                     ignores /beds/
  beds/<class>/                  a tend pass's worktree on branch bed/<class>
```

`garden` is an orphan branch: it holds only `.garden/` and `.gitignore`, never the repository's code, so its history
is the gardener's record and nothing else. Bed branches (`bed/<class>`, since git cannot hold a `garden/<class>` branch beside `garden`)
start from the base branch and carry one proposed bed change each. Nothing in the site is pushed. A human brings a bed home from the repository with
`git fetch ../<repo>.garden bed/<class>` and merges it the way the repository lands work; the `garden` branch can
be fetched the same way to keep the queue in the repository's history.

## Open, commit

`scripts/site.ts` does all of the site's git work, run from the repository's checkout. Run from a linked worktree
of the repository, it uses the one site beside the main checkout:

- `site.ts open [--base <branch>]` creates the site on first use: a clone with no checkout, the repository's
  `user.name` and `user.email` copied in, and the orphan `garden` branch with one plant commit holding
  `.gitignore`. On later runs it leaves the site as it is. It prints JSON with `site`, `created` and `base`. It
  exits 2 when the repository has no `user.name` or `user.email`, so the gardener never commits under a default
  identity.
- `site.ts commit --message <text>` stages `.garden/` in the site and commits it on `garden`. It prints JSON with
  `committed`, false when nothing changed.

The census and the queue are written by their own scripts, through `--out` and `--file` paths into the site.

## The base branch

The base is the branch work lands on. `site.ts open` takes, in order: the `--base` argument; the `rev` recorded
in the site's `.garden/census.json`; the repository's default branch (`origin/HEAD`); `main` when that branch
exists; else `master`. A repository cloned from a local path is the exception: its `origin/HEAD` follows whatever
the source had checked out, often a feature or milestone branch in flight, so when it names the branch checked out
in the repository, `open` passes over it for `main` or `master`.

A branch that only `origin` has (a clone whose checkout is a milestone branch often has `main` only as
`origin/main`) is reported as `origin/<name>`, and every later command reads that ref. A base that resolves to no
commit, or whose name holds a character a shell would expand (anything but letters, digits and `._/+@-`), stops
`open` with exit 2 before it plants anything.

The base names a ref in the repository, not in the site: a tick reads it in the repository's checkout, and a tend
pass fetches it into the site by that name (below).

## Beds (tend passes only)

A garden tick never runs anything in this section or the next. A tend pass runs these against the site from the
repository's checkout, pointing git at the site with `-C`. Below, `<checkout>` is the repository's checkout and
`<bed>` is `<site>/beds/<class>`, both full paths. The fetch takes the base by the name `site.ts open` reported
(`main`, or `origin/main` when only the repository's remote has it), and the bed starts from the commit it fetched:

```bash
git -C "<site>" fetch -q origin <base>
git -C "<site>" rev-parse FETCH_HEAD
git -C "<site>" worktree add -b bed/<class> "<bed>" FETCH_HEAD
```

The commit `git rev-parse` printed is the bed's start, written `<start>` below.

Dependencies for a bed, Node.js repositories:

- **Link** the repository's `node_modules` when the bed's lockfile is byte-identical to the repository's
  (`cmp -s "<checkout>/package-lock.json" "<bed>/package-lock.json"`, or the pnpm or yarn lockfile) and the root
  `package.json` declares no `workspaces` (and there is no `pnpm-workspace.yaml`). On Windows:
  `cmd //c mklink //J "<bed>\node_modules" "<checkout>\node_modules"` with backslash paths; elsewhere `ln -s`.
- **Install** with the repository's package manager (`npm ci`, `pnpm install --frozen-lockfile`) otherwise, and
  always when the bed changes dependencies. A workspace package resolves through a linked `node_modules` to the
  repository's checkout, so the bed would test the other checkout's code.
- Never run an install through a link: it rewrites the repository's own `node_modules`.

## Cleanup

A bed stays until its branch is merged into the base or a human drops it. Remove one with: unlink `node_modules`
first (`rm "<bed>/node_modules"`, no `-r`; on Windows `cmd //c rmdir "<bed>\node_modules"`), then
`git -C "<site>" worktree remove "<bed>"`, then `git -C "<site>" branch -D bed/<class>` only once the change has
landed: after `git -C "<site>" fetch -q origin <base>`,
`git -C "<site>" merge-base --is-ancestor bed/<class> FETCH_HEAD` exits 0, or the base holds
a commit that carries the same change. Deleting the whole site loses the
queue unless the `garden` branch was fetched into the repository.

One gardener per site: two sessions looping on one repository append to the same queue and race on its commits.
