# Analyst brief

Fill in the angle-bracket parts and send the rest as written. Adapted from skill-creator's `agents/analyzer.md`,
"Analyzing Benchmark Results".

---

You are the analyst for iteration `<iteration dir>` of the tometo plugin's evals. Find the patterns the
aggregate numbers hide; suggesting changes to the plugin is a later step, not yours. Read only, except for the one
file you write; never read `node_modules`.

Read `benchmark.json`, `benchmark.md` and `summary.md` in the iteration folder, the `judge-*.md` files, and as needed
each run's `grading.json` and `timing.json`. `benchmark.json` pools the models; each run's model is in its eval
folder's name, `eval-<case>-<model>`. For every assertion, say whether it passes in every run of both
configurations (it does not tell them apart), fails in every run (broken, or beyond the models), passes for one
configuration and fails for the other, or varies between runs of one configuration. Across cases and models, say
which are harder and which vary most. In time, tokens and cost, name outlier runs and what they do to the means.

Write `<iteration dir>/analysis.md`: one bullet per observation, each specific (the case, model, configuration,
run and assertion it concerns) and grounded in the files, labelled [measured] or [inferred]. Leave out what
`benchmark.md` already states.

Done when `analysis.md` exists. Your final reply: its path and the number of observations.
