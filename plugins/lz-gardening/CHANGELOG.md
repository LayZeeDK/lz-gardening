# Changelog

This plugin uses [Semantic Versioning](https://semver.org/). Its public interface is: the plugin name; the skill
names and their slash commands; the agent name; who may invoke each skill; the arguments each skill takes; the
garden site layout (the `garden` branch, `.garden/` files, `bed/<class>` bed branches); the formats of
`.garden/weeds.jsonl`, `.garden/census.json` and `.garden/patterns.json`; and the class ids a queue may hold. A
change that makes an existing site, queue or census unreadable is a major change.

## 0.1.0 (unreleased)

First release.

- `lz-garden` skill: one watch tick over the repository, recorded in a garden site beside it. Counts the hits
  of each census pattern on the base branch, reads what landed since the last tick, and queues each weed with its
  evidence. The first tick seeds the queue from the census's seed list, the repository's records and its history.
  A weed of a class a tend pass closed is queued as `regrown` wherever it comes back, naming the bed and the check
  that should have held it, and saying when that check is not on the base branch: the bed has not landed, or the
  check's file is gone from it. A weed of a class only ever closed as a one-off is queued as new.
  Carries its own permission rules: they allow reading its own files and running its own scripts and read-only git commands;
  anything else falls back to your own settings. The queue and census scripts write only to `.garden/weeds.jsonl`
  and `.garden/census.json` and refuse any other output path. The site's own git commands run none of your git hooks
  and sign nothing.
- `lz-tend` skill: takes one class of queued weeds and adds the check that keeps it from growing back, then fixes or
  baselines every instance, in a bed (a worktree of the site) for a human to fetch and land. Closes the class in
  the queue as tended, one-off or kept; a tended close records the bed and where its check lives. A class tended
  again before its bed lands is tended in the same bed, with what the base gained since merged in, so the check sees
  the weeds that came back. Makes the bed with the garden's site script, which links the checkout's Node.js
  dependencies into the bed, or names the command that installs them, for npm, pnpm, Yarn 1, and Yarn 4 or later.
  Carries its own permission rules for reading the `lz-tend` skill and the `lz-garden` references, and for running
  the garden scripts, and asks you to add the site as a working directory.
- `lz-gardener` agent: the fork the `lz-garden` skill runs in. Reads the repository and writes only through the
  garden scripts, which keep the queue and the census in the site and commit them on `garden`.
