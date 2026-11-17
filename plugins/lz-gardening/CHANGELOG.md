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

- `lz-garden` skill (`/lz-gardening:lz-garden [--base <branch>]`): one watch tick over the repository, recorded in
  a garden site beside it at `../<repo>.garden`.
  - Watch: counts the hits of each census pattern on the base branch, reads what landed since the last tick (the
    diffs of the newest 30 commits, chosen smallest first up to 400,000 characters), and queues each weed with its
    evidence. A weed of a class a tend pass closed is queued as `regrown`, naming the bed and the check that should
    have held it.
  - Seed: the first tick seeds the queue from the census, the repository's records and its history (up to 72,000
    characters of the newest 20 commits' diffs, and the report counts the commits left unread). A seed pass
    marks the queue seeded, so no other clone seeds again, and is recorded only once each line of the seed list is
    queued or declined (`weeds.ts decline`, which keeps the line's weed out of the queue for good). `weeds.ts add`
    and `decline` take `--source census:seed` only for a weed on a line of the seed list.
  - Census patterns: the bundled patterns, extended or overridden by id in the site's `.garden/patterns.json`. A
    pattern without `paths` searches the JavaScript and TypeScript source files (`.ts`, `.tsx`, `.mts`, `.cts`,
    `.js`, `.jsx`, `.mjs`, `.cjs`).
  - Share: the queue (`refs/garden/log`) and the census (`refs/garden/census`) are shared through the repository's
    `origin`. No ref outside `refs/garden/` is pushed. `git config lzGardening.share false` keeps the garden local.
    An event in the queue that the scripts would not write, such as an add whose id does not match its class,
    `where` (line included) and source, is skipped and named on stderr, and a close ends only the weeds of its own
    class.
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
    linked in or an install command named (npm, pnpm, Yarn 1, Yarn 4 or later). A class tended again before its bed
    lands is tended in the same bed.
  - Close: closes the class as tended, one-off or kept. A tended close names the bed and where its check lives, and
    shares the bed on `origin` as `refs/garden/beds/<class>` for a human to fetch and land; a bed a sync did not see
    land (a failed or timed-out push, or a sync stopped once its log landed) is pushed again by the next sync. Bed
    commits carry the identity of whoever commits them.
  - Proof: the check is proved on a queued weed in the untouched bed before any fix, and on paved-road code, and a
    tended close holds only the weeds that proof reported or the bed fixed. A copy is kept only on words the
    repository wrote, cited by path and line.
  - Stops: a refused command the pass needs ends it, and the pass releases its claim; a refused lookup it can do
    without is named in the report. Tools run through `npm exec --no` and `npx --no`, so a missing tool fails instead
    of being downloaded.
  - Permissions: carries its own rules for reading the `lz-tend` skill and the `lz-garden` references and for running
    the site and weeds scripts, and asks you to add the site as a working directory.
- `lz-gardener` agent: the fork the `lz-garden` skill runs in. Reads the repository and writes only through the
  garden scripts. Runs on the session's model (`model: inherit`).
- Git reads: on Windows, where starting a git process is slow, each script command reads git objects through one
  long-lived `git cat-file --batch-command` per folder and ends it before the command exits. Other platforms start
  a git process per read. The scripts' own fetches, merges and commits start no auto maintenance
  (`maintenance.auto=false`), as its packing of refs can go unseen by a long-lived reader.
