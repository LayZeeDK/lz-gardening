# Changelog

This plugin uses [Semantic Versioning](https://semver.org/). Its public interface is: the plugin name; the skill
names and their slash commands; the agent name; who may invoke each skill; the arguments each skill takes; the
garden site layout (the `refs/garden/log`, `refs/garden/census`, `refs/garden/pending/<sha>` and
`refs/garden-unpushed/beds/<class>` refs, the `garden` branch, `.garden/patterns.json`, `bed/<class>` bed
branches); the `refs/garden/log`, `refs/garden/census` and `refs/garden/beds/<class>` refs the site shares on the
repository's `origin`, and the `lzGardening.share`, `lzGardening.name` and `lzGardening.email` settings; the formats
of the event files and `garden.json` in `refs/garden/log`, of `census.json` and `patterns.json` in
`refs/garden/census`, and of `.garden/patterns.json`; and the class ids a queue may hold. A change that makes an
existing site, queue or census unreadable is a major change.

## 0.1.0 (unreleased)

First release. The scripts use one npm package, Zod, which Claude Code installs with the plugin.

- `lz-garden` skill (`/lz-gardening:lz-garden [--base <branch>]`): one tick over the repository, recorded in
  a garden site beside it at `../<repo>.garden`.
  - Watch: counts the hits of each census pattern on the base branch, reads what landed since the last tick (the
    diffs of the newest 200 commits, chosen smallest first up to 400,000 characters), and queues each weed with its
    evidence. A weed of a class a tend pass closed is queued as `regrown`, naming the bed and the check that should
    have held it.
  - Seed: the first tick seeds the queue from the census, the repository's records and its history (up to 72,000
    characters of the newest 20 commits' diffs, and the report counts the commits left unread, names the classes a
    clean-up removed that nothing now rejects, and says what the pass left undone; `diffs.ts <commit>` reads a commit the
    pass is pointed at from its parent). A seed pass
    marks the queue seeded, so no other clone seeds again, and is recorded only once each file of each line of the
    seed list is queued or declined (`weeds.ts decline`, which keeps the weed out of the queue for good; without
    `--where` it declines every pattern line of the class not yet queued or declined, and a duplicate name's files
    are declined one at a time, each on words its file, or the record `--in` names, holds at the census's
    commit). `weeds.ts lines --class <class>` prints the seed lines of a census pattern's class with the hits the
    census holds for each, and last `read <class> <token>`; a decline of such a class takes that token as `--read`,
    and is refused without it or with a token from another census. `lines` refuses duplicate-function, and a class
    with no line on the seed list; a duplicate-function decline refuses `--read`. Duplicate names count only module-scope
    definitions, outside test files and `.d.ts` declarations.
    `weeds.ts add` takes `--source census:seed`, and `decline` records its weed with it, only for a weed on a line of
    the seed list; `add` takes `--where` once per weed, so the files of one duplicate name are queued in one call. A
    path given as `./a` or `a//b` is recorded as `a` or `a/b`, so those spellings make one weed; a path must be
    repository-relative both as given and in that form, with `\` read as `/` (`.\d:\a` is refused). Every other
    `weeds.ts` flag goes once, except `--check` of `close-class`: given twice, it is refused (exit 2), not read as its
    last value.
  - Census patterns: the bundled patterns, extended or overridden by id in the site's `.garden/patterns.json`,
    which the census prints as `site pattern <id>: <regex>` lines. A
    pattern without `paths` searches the JavaScript and TypeScript source files (`.ts`, `.tsx`, `.mts`, `.cts`,
    `.js`, `.jsx`, `.mjs`, `.cjs`).
  - Share: the queue (`refs/garden/log`) and the census (`refs/garden/census`) are shared through the repository's
    `origin`. No ref outside `refs/garden/` is pushed. `git config lzGardening.share false` keeps the garden local.
    An event in the queue that the scripts would not write, such as an add whose id does not match its class,
    `where` (line included) and source, is skipped and named on stderr, and a close ends only the weeds of its own
    class. A sync names on stderr what it left out, kept local or gave back (a shared census that is not one, a
    census of a commit `origin` lacks, a bed `origin` did not take, a claim another writer won): every sync of a
    `site.ts` command, the first sync of `weeds.ts claim`, and the last sync of `weeds.ts close`, `close-class` and
    `release`.
  - Privacy: events take repository-relative paths only, and an event that holds this machine's paths is refused. A
    bed that holds them, or that would bring `origin` a commit other than its own, stays in the site, as does a
    census of a commit no branch on `origin` holds. Each census carries the site's `.garden/patterns.json` as it
    is. The garden log's and the census's commits are authored as `lz-gardening <>`, or as `lzGardening.name` and
    `lzGardening.email` when both are set, and dated in UTC, so none names the machine's time zone.
  - Permissions: carries its own rules, for reading its own files and running its own scripts and read-only git
    commands. Anything else falls back to your own settings.
- `lz-tend` skill (`/lz-gardening:lz-tend [<class>] [--base <branch>]`): takes one class of queued weeds, adds the
  check that keeps it from growing back, then fixes or baselines every instance.
  - Claim: claims its class first, so no other clone tends it at the same time. A claim lasts six hours, and the
    earliest live claim on `origin` wins. A claim that would end more than six hours after it was taken, or more
    than seven hours after the reader's clock, holds nothing. A claim names its holder by `lzGardening.name`, else by
    `writer` and the first 8 characters of the site's random writer id, never by `user.name`.
  - Bed: works in a bed, a worktree of the site on branch `bed/<class>`, with the checkout's Node.js dependencies
    linked in or an install command named (npm, pnpm, Yarn 1, Yarn 4 or later). `site.ts bed` also prints `run` and
    `tool`, the forms that run a package script and a tool in the bed from the checkout, and `back`, the call back to
    the checkout. A class
    tended again before its bed lands is tended in the same bed.
  - Close: closes the class as tended, one-off or kept. A tended close names the bed and where each of its checks
    lives (`--check` once per check file, each a file the tended bed commit holds, `./a` and `a` recorded once as
    `a`; the event's `check` field joins them with `, `), and shares the bed on `origin` as
    `refs/garden/beds/<class>` for a human to fetch and land; a bed a sync did not see land (a failed or timed-out
    push, or a sync stopped once its log landed) is pushed again by the next sync. Bed commits carry the identity of
    whoever commits them.
  - Proof: the check is proved on a queued weed in the untouched bed before any fix, and on paved-road code, and a
    tended close holds only the weeds that proof reported or the bed fixed. A weed whose copy stays in the check's
    baseline stays open (`weeds.ts close-class --baselined`), and the close refuses, closing nothing, a baselined
    weed whose file no `--check` file names at the bed commit. A copy is kept only on words the repository wrote
    that say the copy stays, cited by path and line; a function that shares a queued name but does another job is
    renamed, not closed.
  - Stops: a refused command the pass needs ends it, and the pass releases its claim; a refused lookup it can do
    without is named in the report. A tool with no package script runs from the bed's root through `npx --no`, so it
    reads the bed's config and a missing tool fails instead of being downloaded. The README lists the permission
    rules a pass needs in a session that cannot ask.
  - Permissions: carries its own rules for reading the `lz-tend` skill and the `lz-garden` references and for running
    the site and weeds scripts, and asks you to add the site as a working directory.
- `lz-gardener` agent: the fork the `lz-garden` skill runs in. Reads the repository and writes only through the
  garden scripts. Runs on the session's model (`model: inherit`).
- Git reads: on Windows, where starting a git process is slow, each script command reads git objects through one
  long-lived `git cat-file --batch-command` per folder and ends it before the command exits. Other platforms start
  a git process per read. The scripts' own fetches, merges and commits start no auto maintenance
  (`maintenance.auto=false`), as its packing of refs can go unseen by a long-lived reader.
- Search: a tick and a tend pass search with the Grep tool and list files with the Glob tool. On macOS and Linux,
  where Claude Code's native builds have neither tool, they search with `git grep --untracked`, which skips the files
  git ignores, and list files with `find` through Bash (a tend pass searches its bed with `grep`). Claude Code runs
  these as read-only commands without asking unless your permission rules refuse them, so the plugin needs no setup
  on Windows, macOS or Linux.
