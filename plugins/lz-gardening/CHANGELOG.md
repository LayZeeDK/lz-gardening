# Changelog

This plugin uses [Semantic Versioning](https://semver.org/). Its public interface is: the plugin name; the skill
names and their slash commands; the agent name; who may invoke each skill; the arguments each skill takes; the
garden site layout (the `garden` branch, `.garden/` files, `bed/<class>` bed branches); the formats of
`.garden/weeds.jsonl`, `.garden/census.json` and `.garden/patterns.json`; and the class ids a queue may hold. A
change that makes an existing site, queue or census unreadable is a major change.

## 0.1.0 (unreleased)

First release.

- `garden` skill: one watch tick over the repository, recorded in a garden site beside it. Takes a census of weed
  markers at the base branch, reads what landed since the last tick, and queues each weed with its evidence. The
  first tick seeds the queue from the census's seed list, the repository's records and its history. Carries its own
  permission rules: they allow reading its own files and running its own scripts and read-only git commands;
  anything else falls back to your own settings. The site's own git commands run none of your git hooks and
  sign nothing.
- `tend` skill: takes one class of queued weeds and adds the check that keeps it from growing back, then fixes or
  baselines every instance, in a bed (a worktree of the site) for a human to fetch and land. Carries its own
  permission rules for reading the tend skill and the garden references and running the garden scripts, and asks
  you to add the site as a working directory.
- `lz-gardener` agent: the fork the `garden` skill runs in. Reads the repository and writes only through the
  garden scripts, which keep the queue and the census in the site and commit them on `garden`.
