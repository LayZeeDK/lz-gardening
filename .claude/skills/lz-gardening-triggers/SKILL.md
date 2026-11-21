---
name: lz-gardening-triggers
description: Measure and improve when an lz-gardening skill triggers, from an eval set of should and should-not queries. Use to optimize a skill's description, check a description change for trigger regressions, or extend a trigger eval set.
---

# Trigger optimization for lz-gardening skills

The method is skill-creator's description optimization (its `run_loop.py`), ported to `tools/evals/trigger-*.ts`
and run through `claude plugin eval`. Runs happen in a copy of the plugin, so the plugin's own `SKILL.md` never
changes until you apply a result by hand.

## 1. The eval set

Each skill has `.claude/evals/lz-gardening-triggers/<skill>.json`: `{query, should_trigger}` items. Should-trigger
queries are realistic, varied in phrasing and length, and include ones that never name the skill. Should-not queries
are near-misses: they share words or concepts with the skill but need something else, such as a fix instead of a
survey, or the other lz-gardening skill. A query Claude would answer in one step without a skill is a poor case
either way. Done when the set has 10 of each kind and no should-not query is plainly unrelated.

## 2. The runs

From the repository root, in the background, once per model (`--model sonnet` and `--model opus`, each with its own
workspace):

```bash
LZ_EVAL_RUN_SLIM=<path to run-slim.ts> LZ_EVAL_CLAUDE=<path to claude.exe> \
  node tools/evals/trigger-optimize.ts --plugin plugins/lz-gardening --skill <skill> --model <model> \
  --eval-set .claude/evals/lz-gardening-triggers/<skill>.json \
  --workspace .claude/evals/lz-gardening-triggers-workspace/<run name> --runs 3 --max-iterations 5 --concurrency 4
```

`LZ_EVAL_CLAUDE` names the Claude Code executable itself, not a `.cmd` shim. A first check of a new set can use
`--runs 1 --max-iterations 2`. One run costs about $0.04 at list price; a full run is up to 300 runs per skill, plus
one Opus call per iteration to write the next description.

The loop splits the set 60/40 into train and test, stratified and seeded. Each iteration measures train and test
together, then asks the slim runner for a better description from the train results only. It stops when every train
query passes or after the last iteration. It prints the exit reason and the best description's scores, and writes
`<workspace>/results.json`.

A usage limit or another stop leaves `results.json` unwritten. Once the limit resets, run the same command with
`--resume` added: it refuses options that differ from the workspace's `options.json`, keeps every finished iteration's
results and description, and runs the first unfinished one again, its old files moved to
`iteration-<n>-stopped-<ms>`. An iteration in which any run took no turn (how a usage limit ends a session) counts as
unfinished, so a stop is never scored as "not triggered".

Done when each model's workspace holds `results.json`.

## 3. Apply

`results.json` holds `best_description` (chosen by test score, the earliest winning a tie), the original's scores in
`history[0]`, and each iteration's per-query results. A description qualifies when its test score beats the
original's at `--runs 3` on the model it was found on, and on the other model its test score is no lower than that
model's `history[0]`: run it there with `--max-iterations 1 --runs 3` and the default `--seed` and `--holdout`, on a
plugin copy whose `SKILL.md` carries it. Apply a qualifying description to the skill's frontmatter. Report the before
and after descriptions, every score, and each query that still fails. The edit is a change to the plugin's public
text: commit it on its own, after the repository's checks pass.

Done when the final reply holds the report and a qualifying description, if any, is committed.
