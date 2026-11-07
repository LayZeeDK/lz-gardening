# Changelog

This plugin uses [Semantic Versioning](https://semver.org/). Its public interface is: the plugin name; the skill
names and their slash commands; the agent name; who may invoke each skill; the arguments each skill takes; the
garden site layout (the `garden` branch, `.garden/` files, `garden/<class>` bed branches); the formats of
`.garden/weeds.jsonl`, `.garden/census.json` and `.garden/patterns.json`; and the class ids a queue may hold. A
change that makes an existing site, queue or census unreadable is a major change.

## 0.1.0 (unreleased)

First release.

- `garden` skill: one watch tick in a garden site beside the repository. Takes a census of weed markers at the base
  branch, reads what landed since the last tick, and queues each weed with its evidence. The first tick seeds the
  queue from the census baseline, the repository's records and its history.
- `tend` skill: takes one class of queued weeds and adds the check that keeps it from growing back, then fixes or
  baselines every instance, in a bed (a worktree of the site) for a human to fetch and land.
- `lz-gardener` agent: the fork the `garden` skill runs in. Writes only to the site's `.garden/` folder and
  `garden` branch.
