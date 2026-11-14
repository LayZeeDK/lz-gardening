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
  refs/garden/census             (git ref) the garden's census (scripts/census.ts): one commit holding census.json,
                                 and patterns.json when the census used extra patterns
  refs/garden/pending/<sha>      (git ref) a census taken at <sha> and not yet recorded
  refs/garden-shared/            (git refs) what the last sync fetched of origin's refs/garden/: log, census and
                                 beds/<class>, the beds other clones closed
  .garden/patterns.json          optional, not committed on `garden`: this repository's own census patterns; each
                                 census the site records holds a copy, pushed to `origin` as it is
  .gitignore                     ignores /beds/
  beds/<class>/                  a tend pass's worktree on branch bed/<class>
```

`garden` is an orphan branch: it holds only `.gitignore`, never the repository's code. The census is not on it: each
census is its own commit with no parent, written to `refs/garden/census`. Bed branches (`bed/<class>`, since git cannot hold a `garden/<class>`
branch beside `garden`) start from the base branch and carry one proposed bed change each. A tended close shares
its bed on `origin` as `refs/garden/beds/<class>`. A human lands a bed by fetching it into the repository with
`git fetch origin refs/garden/beds/<class>` (or `git fetch ../<repo>.garden bed/<class>` when the bed was not
shared: its close did not end `synced`, or the sync named the bed on stderr) and merging it the way the repository
lands work.

The site shares two refs, the garden log and the census: `site.ts open` and `site.ts sync` fetch the repository's
`origin` `refs/garden/log` and `refs/garden/census` into the site's `refs/garden-shared/`, merge the log with the
site's own log, settle the census (below), and push both back to `origin` in one atomic push. They read the URLs from
the checkout on every run (`git remote get-url origin` to fetch, `--push` to push), so the checkout itself fetches
nothing and gains no refs, and they push no ref outside `refs/garden/`.
`git config lzGardening.share false` in the checkout keeps the garden local. Events are never edited or deleted, so
the merge is the union of both logs' event files: the commit takes the site's log and adds the shared log's files.
A file both logs hold with different content keeps the shared content and is reported as a conflict; a shared file
that is not an event file (`events/<xx>/<uuid>.json`) or `garden.json` is not copied and is named on stderr. A shared
log in a format other than this version's stops the sync with exit 2, naming both formats; one that is not a commit
holding `garden.json` stops it with exit 2 too, saying to delete or fix it on `origin`. Because every site holds
the whole log, a site made again, or one whose remote ref was deleted, gets the log back on its next sync.

After the log lands, a sync pushes beds in a push of their own, one ref per bed, so a bed `origin` refuses holds back
neither the log nor another bed. For each class, the latest tended close in the merged log names the bed: the sync
pushes the site's `bed/<class>` as `refs/garden/beds/<class>` when that branch's commit is the close's, and either
`origin`'s bed is an ancestor of it or `origin` has no bed of the class and the close is shared by this very sync.
A bed that does not descend from `origin`'s, or that `origin` refuses, is named on stderr and left in the site. The
only commits a bed may bring `origin` are its own, made in the site: a bed that would bring any commit the checkout
holds (a base on an unpushed branch, a tag, a detached commit or another remote's branch) stays in the site and is
named too. So is a bed whose commits add a line, or hold a message, with this machine's home folder, the checkout's
path or the site's path in it, spelled as the event check below reads them; merges and files git reads as binary
count. A bed ref deleted on `origin` after its close was shared stays deleted.

A census is shared only while a branch the checkout fetched from `origin` (`refs/remotes/origin/*`) holds its base
commit. Otherwise it stays in the site, and `site.ts` says so on stderr; a later sync, once that commit is pushed and
fetched, shares it.

The garden log's and the census's commits are authored and committed as `lz-gardening <>`, with no one's name or
address, unless the checkout's git config, in any scope, sets both `lzGardening.name` and `lzGardening.email`: then
those are the author and committer. With only one of the two set, the commits keep `lz-gardening <>`. Bed commits
are code for review and carry the identity of whoever commits them.

The queue is as public as the repository: whoever can read `origin` can read every event. So paths in events are
repository-relative, and `weeds.ts` refuses, with exit 2, an event whose text holds this machine's home folder, the
checkout's path or the site's path, in any letter case, with either slash or doubled backslashes (as JSON escapes
them), and with a drive written as Git Bash writes it (`/d/...`, which WSL's `/mnt/d/...` holds too). Beyond events,
only a bed is checked (above): a census
holds the site's `.garden/patterns.json` byte for byte, and `origin` gets the same copy.

In CI, the site sits beside the job's workspace and lasts one job. Events or a census a run has not shared by its end
are gone with the runner, and the next run reads the same commits again, because the shared census did not move. The
scripts read the checkout's `origin` URL on every sync,
so a token the CI job put in that URL reaches the site, which needs no credentials of its own and keeps no copy of the
token.

Claims decide who tends a class. A sync that shares a claim of this writer's checks it against `origin`'s log: when
another writer's claim of the class came first, it gives the claim back with a release, pushed in the same sync,
and names the class and the holder on stderr. `weeds.ts close-class` and `site.ts bed` share one precondition: each
syncs first and acts only when that sync is `synced` or `local` and this writer then holds a live claim of the
class; otherwise each exits 1 and changes nothing. `close --id` needs no claim.

The census is decided by the ancestry of its base commit, read in the checkout. A sync takes the shared census over
the site's unless the site's census is of a commit that descends from the shared one's; a shared census that is not
a census is left out, named on stderr, and replaced by the next census pushed. `sync --census <sha>` then records the
census `census.ts` took at `<sha>`, unless the site's census is of `<sha>` or a commit that descends from it: then
another run already read past it, and the taken census is dropped. A push that loses the shared census to another
clone fetches again and decides again.

## Open, sync

`scripts/site.ts` does all of the site's git work, run from the repository's checkout. Run from a linked worktree
of the repository, it uses the one site beside the main checkout:

- `site.ts open [--base <branch>]` creates the site on first use: a clone with no checkout, the repository's
  `user.name` and `user.email` copied in, and the orphan `garden` branch with one first commit holding
  `.gitignore`, the queue's `refs/garden/log` holding only `garden.json` (the format of its events), and a random
  writer id in the site's `lzGardening.writer` setting. On later runs it plants only what the site lacks of
  `refs/garden/log` and the writer id, and leaves the rest as it is. Then it syncs the garden log once, with no
  wait, which also pushes events a run appended but never shared. It prints JSON with `site`, `created`, `base`,
  `seeded` (whether the queue holds the event a seed pass records, after the sync) and `shared` (the share state,
  below). When it creates the site, it exits 2 if the repository has no `user.name` or `user.email`, so the gardener
  never commits under a default identity. The site keeps the identity it copied: a later change to the repository's
  `user.name` or `user.email` does not reach bed commits; set it in the site too (`git -C "<site>" config user.email
  <address>`). It also exits 2 when a repository at `../<repo>.garden` has no `garden` branch, writing nothing into
  it.
- `site.ts sync [--census <sha> [--seeded]]` syncs the garden log and census, trying up to five times. With
  `--census`, it records the census `census.ts` took at `<sha>` (above), and records it even when the sync shares
  nothing (a `local` or `offline` garden). `--seeded` also appends the event that marks the garden seeded, once. It
  prints JSON with `shared` and `events` (how many of the site's events the push shared), plus `reason` (git's
  message) when there is one and `conflicts` (the files whose shared content it kept) when there are any. It exits 0
  in every share state, and 2 when `<sha>` is not a full commit id or `--seeded` comes without `--census`.

The share states:

- `local`: the checkout has no `origin`, or sets `lzGardening.share` to false. Nothing was fetched or pushed.
- `synced`: the site's log and `origin`'s are the same.
- `offline`: the fetch failed (no network, no access, a URL that asks for credentials) or a fetch or push took longer
  than a minute; `reason` says which. The site's events stay in the site.
- `read-only`: the fetch worked but `origin` declined the push, for a reason other than another push landing first;
  `reason` gives git's message, such as what a server hook said.
- `behind`: every try lost the race to another push, or to another sync of the same site. The site's events stay in
  the site and the next run pushes them.

Fetch and push never ask for a password or wait for input: a URL that needs credentials git cannot find is
`offline`. A try that another push or sync beat waits 1, 2, 4 and 8 seconds (give or take half) before the next try.

Every git command `site.ts` runs, from the clone to each commit in the site, runs none of the user's git hooks and
signs nothing: the site holds only the garden's own records, and a hook or a signing passphrase would stop a tick
that runs unattended.

`census.ts --rev <base>`, run from the repository's checkout, reads the site's census and writes the census it takes
to `refs/garden/pending/<sha>` when it differs from the site's census in more than the time it was taken; `sync --census <sha>` records it. A
`refs/garden/census` that is not a census stops it with exit 2, naming the command that deletes it. `weeds.ts`, run from the
repository's checkout, finds the site beside it and appends events to `refs/garden/log` with git plumbing only: a
commit per command, moved onto the ref only if no other run moved it first, so two runs on one machine both land. An
entry in the log it cannot read (an event file that does not parse or whose text holds a line break or control
character, an object the site lacks, a submodule entry) is skipped and named on stderr. A `garden.json` in a newer
format stops it with exit 2 (update lz-gardening); one that is missing, is not JSON or names no format stops it with
exit 2, naming the file.

## The base branch

The base is the branch work lands on. `site.ts open` takes, in order: the `--base` argument; the `rev` recorded
in the site's census (stored without `origin/`, so each clone finds the branch its own way); the repository's default branch (`origin/HEAD`); `main` when that branch
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
`origin/main` when only the repository's remote has it). It first syncs the garden log once, as `open` does, and
goes on only while this site holds a live claim of the class in the merged log (`weeds.ts claim`; a `local` garden
claims locally). It exits 1, before it fetches or changes anything, when the sync is `offline`, `read-only` or
`behind` (`bed: cannot check the claim of <class>: <state> (<reason>)`), when this site holds no claim of the class
or its claim expired (`bed: this site holds no claim of <class>; run weeds claim --class <class>`), and when another
writer holds it (`bed: <class> is claimed by <holder> until <time>`). It fetches the base into the site and adds the
worktree `<bed>` on branch `bed/<class>`: at `origin`'s bed of the class when another clone shared one
(`refs/garden-shared/beds/<class>`), with the fetched base merged into it, else at the commit it fetched. Run again
on a bed that exists, it keeps the bed's work, merges `origin`'s bed of the class in first when there is one, then
the fetched base, so weeds that landed on the base since the bed was made are in the bed too;
when the bed's folder is gone but its branch is not, it adds the folder again from the branch, with the work
committed there, before the merge. The merge commit, like every git command of the site, runs no git hooks and is
not signed. It prints JSON with `bed`, `branch`, `start`, `created` and `deps`, and `install` when `deps` is
`install`. `start` is the base commit it fetched, written `<start>` below, so `git diff <start>` shows the bed's own
change. `bed` exits 2 on a class that is
not a kebab-case class id; when a merge is already in progress in a bed that exists (it is left alone; finish or
abort it, then run `bed` again); when the base, or `origin`'s bed, does not merge into the bed cleanly (a conflict
with the bed's commits, or a change to a file the bed holds uncommitted work in; the bed is left as it was and the
message names it; a new bed made at `origin`'s bed whose base merge conflicts stays at `origin`'s bed, and a rerun
reports the same conflict until it is merged by hand in the bed); on a base that is not a plain branch name or commit (one that starts
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
or the base holds a commit that carries the same change. Once it has landed, delete its shared copy on `origin` too:
`git push origin --delete refs/garden/beds/<class>`; no sync pushes it back. Deleting the whole site loses the queue events it never
shared (a `local` garden shares none of them); the next `site.ts open` brings back the rest from `origin`.

Two sessions looping on one repository, in one site or in clones on different machines, both land their queue
events; the census they record is the one of the later base commit. Claims decide which of them tends a class: the
earliest live claim on `origin` wins, and the other gives its claim back.
