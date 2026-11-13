# Changelog

This plugin uses [Semantic Versioning](https://semver.org/). Its public interface is: the plugin name; the skill
names and their slash commands; the agent name; who may invoke each skill; the arguments each skill takes; the
garden site layout (the `refs/garden/log`, `refs/garden/census` and `refs/garden/pending/<sha>` refs, the `garden`
branch, `.garden/patterns.json`, `bed/<class>` bed branches); the `refs/garden/log` and `refs/garden/census` refs the
site shares on the repository's `origin`, and the `lzGardening.share` setting; the formats of the event files and
`garden.json` in `refs/garden/log`, of `census.json` and `patterns.json` in `refs/garden/census`, and of
`.garden/patterns.json`; and the class ids a queue may hold. A change that makes an existing site, queue or census
unreadable is a major change.

## 0.1.0 (unreleased)

First release.

- `lz-garden` skill: one watch tick over the repository, recorded in a garden site beside it. Counts the hits
  of each census pattern on the base branch, reads what landed since the last tick, and queues each weed with its
  evidence. The first tick seeds the queue from the census's seed list, the repository's records and its history.
  A weed of a class a tend pass closed is queued as `regrown` wherever it comes back, naming the bed and the check
  that should have held it, and saying when that check is not on the base branch: the bed has not landed, or the
  check's file is gone from it. A weed of a class only ever closed as a one-off is queued as new. Carries its own
  permission rules: they allow reading its own files and running its own scripts and read-only git commands; anything
  else falls back to your own settings. The queue script writes only events to the site's `refs/garden/log`, and the
  census script only a census it took, to the site's `refs/garden/pending/<sha>`, and takes no output path. Two runs
  on one machine both land their events; an event file the queue cannot read, or whose text holds a line break or
  control character, is skipped and named, not fatal. A close exits 1 when it finds nothing open. The site's own git
  commands run none of your git hooks and sign nothing. The queue and the census are shared through the repository's
  `origin`: `site.ts open` and the tick's last command, `site.ts sync --census <sha>`, fetch `origin`'s
  `refs/garden/log` and `refs/garden/census`, merge the log with the site's events, keep the census of the later
  base commit (read by ancestry in your checkout), record the tick's census unless another clone already read past
  it, and push both refs back in one atomic push, pushing no ref outside `refs/garden/`. A tick whose base is behind
  the garden's census says so and stops; a seed pass marks the queue seeded, so no other clone seeds again. Both
  report the share state in a `shared` field: `local` (no `origin`, or
  `git config lzGardening.share false`), `synced`, `offline` (with git's reason; a fetch or push never asks for
  credentials and gives up after a minute), `read-only` (the push was declined, with git's reason) or `behind` (every
  try lost to another push or another sync of the site; the next run pushes the events). `site.ts sync` also prints how many events it shared and
  the files whose shared content it kept over the site's, and exits 0 in every state.
- `lz-tend` skill: takes one class of queued weeds and adds the check that keeps it from growing back, then fixes or
  baselines every instance, in a bed (a worktree of the site) for a human to fetch and land. Closes the class in
  the queue as tended, one-off or kept; a tended close records the bed and where its check lives. A class tended
  again before its bed lands is tended in the same bed, with what the base gained since merged in, so the check sees
  the weeds that came back. Makes the bed with the garden's site script, which links the checkout's Node.js
  dependencies into the bed, or names the command that installs them, for npm, pnpm, Yarn 1, and Yarn 4 or later.
  Carries its own permission rules for reading the `lz-tend` skill and the `lz-garden` references, and for running
  the garden scripts, and asks you to add the site as a working directory.
- `lz-gardener` agent: the fork the `lz-garden` skill runs in. Reads the repository and writes only through the
  garden scripts, which keep the queue and the census in the site.
