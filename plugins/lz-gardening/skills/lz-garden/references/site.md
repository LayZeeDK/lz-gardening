# The garden site

Read when opening, creating or cleaning up the garden site, or when making a bed for a tend pass.

The gardener never writes to the repository's checkout. Other agents may be writing there around the clock, and a
gardener branch, worktree or stash in that checkout is one more thing for them to trip over. Its scripts, run from
the checkout, write into a **site** instead: a local clone beside the repository.

```text
<parent>/<repo>/                 the repository (read only; the clone's `origin`)
<parent>/<repo>.garden/          the site: a clone with branch `garden` checked out
  refs/garden/log                (git ref, not a folder) the weeds queue (scripts/weeds.ts): its commits hold
                                 garden.json and one file per event
  .garden/census.json            the last census (scripts/census.ts)
  .garden/patterns.json          optional: this repository's own census patterns
  .gitignore                     ignores /beds/
  beds/<class>/                  a tend pass's worktree on branch bed/<class>
```

`garden` is an orphan branch: it holds only `.garden/` and `.gitignore`, never the repository's code, so its history
is the gardener's record and nothing else. Bed branches (`bed/<class>`, since git cannot hold a `garden/<class>`
branch beside `garden`) start from the base branch and carry one proposed bed change each. A human lands a bed by
fetching it into the repository with `git fetch ../<repo>.garden bed/<class>` and merging it the way the repository
lands work.

The garden log is the one thing the site shares: `site.ts open` and `site.ts sync` fetch the repository's `origin`
`refs/garden/log` into the site's `refs/garden-shared/log`, merge it with the site's own log, and push the result
back to `origin` `refs/garden/log`. They read the URLs from the checkout on every run (`git remote get-url origin`
to fetch, `--push` to push), so the checkout itself fetches nothing and gains no refs, and they push no other ref.
`git config lzGardening.share false` in the checkout keeps the garden local. Events are never edited or deleted, so
the merge is the union of both logs' event files: the commit takes the site's log and adds the shared log's files.
A file both logs hold with different content keeps the shared content and is reported as a conflict; a shared file
that is not an event file (`events/<xx>/<uuid>.json`) or `garden.json` is not copied and is named on stderr. A shared
log in a format other than this version's stops the sync with exit 2, naming both formats. Because every site holds
the whole log, a site made again, or one whose remote ref was deleted, gets the log back on its next sync.

## Open, sync, commit

`scripts/site.ts` does all of the site's git work, run from the repository's checkout. Run from a linked worktree
of the repository, it uses the one site beside the main checkout:

- `site.ts open [--base <branch>]` creates the site on first use: a clone with no checkout, the repository's
  `user.name` and `user.email` copied in, and the orphan `garden` branch with one first commit holding
  `.gitignore`, the queue's `refs/garden/log` holding only `garden.json` (the format of its events), and a random
  writer id in the site's `lzGardening.writer` setting. On later runs it plants only what the site lacks of
  `refs/garden/log` and the writer id, and leaves the rest as it is. Then it syncs the garden log once, with no
  wait, which also pushes events a run appended but never shared. It prints JSON with `site`, `created`, `base`,
  `seeded` (whether the `garden` branch holds a commit past the first one) and `shared` (the share state, below). It
  exits 2 when the repository has no `user.name` or `user.email`, so the gardener never commits under a default
  identity, and when a repository at `../<repo>.garden` has no `garden` branch, writing nothing into it.
- `site.ts sync` syncs the garden log, trying up to five times. It prints JSON with `shared` and `events` (how many
  of the site's events the push shared), plus `reason` (git's message) when there is one and `conflicts` (the files
  whose shared content it kept) when there are any. It exits 0 in every share state.
- `site.ts commit --message <text>` stages `.garden/` in the site and commits it on `garden`. It prints JSON with
  `committed`, false when nothing changed.

The share states:

- `local`: the checkout has no `origin`, or sets `lzGardening.share` to false. Nothing was fetched or pushed.
- `synced`: the site's log and `origin`'s are the same.
- `offline`: the fetch failed (no network, no access, a URL that asks for credentials) or a fetch or push took longer
  than a minute; `reason` says which. The site's events stay in the site.
- `read-only`: the fetch worked but `origin` declined the push, for a reason other than another push landing first;
  `reason` gives git's message, such as what a server hook said.
- `behind`: every try lost the race to another push. The site's events stay in the site and the next run pushes them.

Fetch and push never ask for a password or wait for input: a URL that needs credentials git cannot find is
`offline`. A push another push beat waits 1, 2, 4 and 8 seconds (give or take half) before the next try.

Every git command `site.ts` runs, from the clone to each commit in the site, runs none of the user's git hooks and
signs nothing: the site holds only the garden's own records, and a hook or a signing passphrase would stop a tick
that runs unattended.

The census is written by its own script, through an `--out` path into the site. `weeds.ts`, run from the
repository's checkout, finds the site beside it and appends events to `refs/garden/log` with git plumbing only: a
commit per command, moved onto the ref only if no other run moved it first, so two runs on one machine both land. An
entry in the log it cannot read (an event file that does not parse or whose text holds a line break or control
character, an object the site lacks, a submodule entry) is skipped and named on stderr. A `garden.json` in a newer
format stops it with exit 2 (update lz-gardening); one that is missing, is not JSON or names no format stops it with
exit 2, naming the file.

## The base branch

The base is the branch work lands on. `site.ts open` takes, in order: the `--base` argument; the `rev` recorded
in the site's `.garden/census.json`; the repository's default branch (`origin/HEAD`); `main` when that branch
exists; else `master`. A repository cloned from a local path is the exception: its `origin/HEAD` names whatever
the source had checked out when it was cloned, often a feature or milestone branch in flight, so `open` passes over
it for `main` or `master`.

A branch that only `origin` has (a clone whose checkout is a milestone branch often has `main` only as
`origin/main`) is reported as `origin/<name>`, and every later command reads that ref. A base that resolves to no
commit, or whose name holds a character a shell would expand (anything but letters, digits and `._/+@-`), stops
`open` with exit 2 before it creates anything.

The base names a ref in the repository, not in the site: a tick reads it in the repository's checkout, and
`site.ts bed` fetches it into the site by that name (below).

## Beds (tend passes only)

A garden tick never runs anything in this section or the next. A tend pass makes its bed with `site.ts`, run from
the repository's checkout, and runs no git command against the site itself. Below, `<checkout>` is the repository's
checkout and `<bed>` is `<site>/beds/<class>`, both full paths.

`site.ts bed --class <class> --base <base>` takes the base by the name `site.ts open` reported (`main`, or
`origin/main` when only the repository's remote has it). It fetches the base into the site and adds the worktree
`<bed>` on branch `bed/<class>` at the commit it fetched. Run again on a bed that exists, it keeps the bed's work
and merges the fetched base into it, so weeds that landed on the base since the bed was made are in the bed too;
when the bed's folder is gone but its branch is not, it adds the folder again from the branch, with the work
committed there, before the merge. The merge commit, like every git command of the site, runs no git hooks and is
not signed. It prints JSON with `bed`, `branch`, `start`, `created` and `deps`, and `install` when `deps` is
`install`. `start` is the base commit it fetched, written `<start>` below, so `git diff <start>` shows the bed's own
change. `bed` exits 2 on a class that is
not a kebab-case class id; when a merge is already in progress in a bed that exists (it is left alone; finish or
abort it, then run `bed` again); when the base does not merge into a bed that exists cleanly (a conflict with the
bed's commits, or a change to a file the bed holds uncommitted work in; the bed is left as it was and the message
names it); on a base that is not a plain branch name or commit (one that starts
with `-`, or holds characters such as `~`, `^` or `:`); on a base the site cannot fetch; when `site.ts open` has not
made the site; when something other than the worktree of `bed/<class>` is at `<bed>`, such as a file or a folder
left from an earlier bed (the message names it; move it aside and run `bed` again); and when it must read a bed
`package.json` that is not valid JSON (the message names the file).

`deps` says how the bed gets its Node.js dependencies:

- `linked`: the bed's `node_modules` is a link to the checkout's. `bed` makes the link when three things hold: the
  checkout has a `node_modules`; the bed's `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` is a plain file, not
  a link, with the same bytes as the checkout's; and the bed is not a workspace, so its `package.json` declares no
  `workspaces` and it has no `pnpm-workspace.yaml`. A workspace package resolves through a linked `node_modules` to
  the repository's checkout, so the bed would test the other checkout's code. On a bed that exists, the link stays
  only while a lockfile still has the same bytes as the checkout's; when the merged base changed it, `bed` removes
  the link (never the checkout's folder) and reports `install`.
- `install`: run the command `bed` prints as `install`. It installs with the package manager of the bed's lockfile,
  pointed at the bed: `npm --prefix "<bed>" ci`, `pnpm -C "<bed>" install --frozen-lockfile` or
  `yarn --cwd "<bed>" install --frozen-lockfile`; with no lockfile, `npm --prefix "<bed>" install`. Yarn 1 refuses to
  change the lockfile only under `--frozen-lockfile`, and Yarn 4 still takes that flag, with a deprecation notice.
- `installed`: the bed already has its own install, a `node_modules` folder or the `.pnp.cjs` file of a Yarn
  Plug'n'Play install.
- `none`: the bed has no `package.json`.

When a linked bed changes its dependencies, stop any process a check left running in the bed (`npx nx daemon --stop`
for Nx), remove the link (`rm "<bed>/node_modules"`, no `-r`; on Windows `cmd //c rmdir "<bed>\node_modules"`), then
install with the command for the bed's lockfile above. Cleanup below is for the human who lands or drops the bed.
Never run an install through a link: it rewrites the repository's own `node_modules`. Tools that cache under `node_modules`, such as `node_modules/.cache`,
write those caches through the link into the checkout's folder.

## Cleanup

A bed stays until its branch is merged into the base or a human drops it. Stop any process a check left running in
the bed, such as Nx's daemon: on Windows git cannot move or remove a folder a process holds open. Remove the bed
with: unlink `node_modules` first (`rm "<bed>/node_modules"`, no `-r`; on Windows
`cmd //c rmdir "<bed>\node_modules"`), then `git -C "<site>" worktree remove "<bed>"`, then
`git -C "<site>" branch -D bed/<class>` only once the change has landed: after
`git -C "<site>" fetch -q origin <base>`, `git -C "<site>" merge-base --is-ancestor bed/<class> FETCH_HEAD` exits 0,
or the base holds a commit that carries the same change. Deleting the whole site loses the queue events it never
shared (a `local` garden shares none of them); the next `site.ts open` brings back the rest from `origin`.

One gardener per site: two sessions looping on one repository both land their queue events, but race on the census
commits on `garden`.
