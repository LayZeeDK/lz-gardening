---
name: lz-gardening-evals
description: Measure a change to an lz-gardening skill, agent or reference against the text before it on the seed and tend passes, graded by scripts and blind LLM judges. Use before keeping such a change, or to rerun an earlier round.
---

# lz-gardening eval rounds

The method is skill-creator's (iterations, two configurations, assertions graded `{text, passed, evidence}`, a
benchmark and an analyst step), with runs as slim `claude -p` sessions and no human review pages: scripts and LLM
judges decide. Cases and assertions: `.claude/evals/lz-gardening/evals.json`. Everything a round writes goes under
`.claude/evals/lz-gardening-workspace/`, which git ignores.

`eval-run.ts` reads its settings from the environment; its header says which subcommand reads which:
`LZ_EVAL_SAMPLES_ROOT` (a folder for the samples, outside this repository), `LZ_EVAL_SAMPLE_ORIGIN` (the bare origin
of the sample repository), `LZ_EVAL_RUN_SLIM` (the path of the slim runner, `run-slim.ts`), and on a shared machine
`LZ_EVAL_HEAVY_LOCK` (the path of `heavy-lock.ts`) with `LZ_EVAL_LOCK_OWNER`.

## 1. Set up the iteration

1. Put each plugin text in its own checkout: `git worktree add <dir> <commit>` outside this repository, with folder
   names that do not say which text is which (`wt-a`, `wt-b`), then `npm ci --prefix <dir>/plugins/lz-gardening` in
   that fresh worktree.
2. Write `.claude/evals/lz-gardening-workspace/iteration-<n>/iteration.json`, `new_skill` (the change) first and
   `old_skill` (the text before it) second: the benchmark's delta is the first minus the second, and the judges and
   step 5 use these names. Take three runs per configuration and model; step 5 says when to raise them to ten.

   ```json
   {
     "configs": {
       "new_skill": { "plugin": "<dir>/plugins/lz-gardening", "commit": "<sha>", "text": "<what changed>" },
       "old_skill": { "plugin": "<dir>/plugins/lz-gardening", "commit": "<sha>", "text": "<the text before it>" }
     },
     "models": ["sonnet", "opus"],
     "runs": 3
   }
   ```

3. `node tools/evals/eval-run.ts scaffold <iteration dir>`. It keeps every sample that exists and makes the missing
   ones, so after raising `runs` it scaffolds only the new runs' samples.

Done when every configuration, model and run has a sample with a `.garden` site beside it.

## 2. Run the cases

`node tools/evals/eval-run.ts run <iteration dir> garden-seed`, then, once every seed run exited 0 (itself or through
a resume), the same with `tend`, which runs on the garden sites the seed pass filled. Each prints one
`<run dir> exit <status>` line per run and exits 1 when any run failed. `run` starts only the runs that have no result
yet. A seed pass takes up to 14 minutes and a tend pass up to 40; run them in the background.

A run that did not exit 0 has its cause in its newest `outputs/result*.json`: `status`, `stderr` and the last
`result` line of `stdout`. Resume a tend run a usage limit or the time limit stopped with
`node tools/evals/eval-run.ts resume <iteration dir> tend <run dir>...`, which continues its session into
`outputs/result-resume-<n>.json`. A seed run cannot resume: `lz-garden` runs forked, so its work was in a subagent
the session cannot continue, and the resumed session's own Skill call is refused. Start a stopped seed run, or a run
that crashed for another reason, over on its own and keep every other run:
`node tools/evals/eval-run.ts rerun <iteration dir> garden-seed <seed run dir>...` moves the named runs and their
samples' later runs (their tend runs) into the first free `<iteration dir>/set-aside-<n>/`, moves their samples with
`.garden` and `-origin.git` into the first free `<samples root>/set-aside-<n>/` (the two numbers can differ),
scaffolds fresh samples and runs the seed pass. Once every seed rerun exited 0,
`node tools/evals/eval-run.ts rerun <iteration dir> tend <tend run dir>...` runs the tend runs it set aside. A tend run
that crashed starts over the same way, from its seed run, and so do two more: one the time limit killed, whose
`result.json` names no session, and one the usage limit stopped before it read the skill's references, because a
resumed session keeps none of the skill's permissions and its first reference read is refused (iteration 9, two
runs). A killed tend run can leave an Nx daemon running in its bed, and `rerun` then fails to move the site; stop the
process whose command line names the sample first. Delete the `set-aside-<n>` folders once nothing in them is
wanted.

Done when every run exited 0, itself or through a resume.

## 3. Grade

1. `node tools/evals/eval-grade.ts <run dir>...` for every run: it writes `outputs/calls.jsonl`, `outputs/final.md`,
   `timing.json` and `grading.json`, with the script checks graded and each judged assertion under `needs_review`.
2. First judge, for each case: `node tools/evals/eval-blind.ts blind <iteration dir> <case> 1` copies every run of
   the case to `judge-<case>-1/<letter>/`. Send one judge agent (Opus at medium effort, `opus-medium` where
   defined), briefed from [references/judge.md](references/judge.md) with that folder. Then
   `node tools/evals/eval-blind.ts unblind <iteration dir> <case> 1`, and `eval-grade.ts` on every run again.
   `unblind` refuses a verdict file whose texts are not the case's judged assertions; send that judge back to fix it.
3. Second judge: where the configurations' pass counts on a judged assertion differ for a model, blind every run of
   that model and case for judge 2 (`blind <iteration dir> <case> 2 <run dir>...`), judge, unblind and grade again.
   `eval-grade.ts` takes the judges' majority; a split leaves `judges split: <assertion>` under `needs_review`.
4. Third judge: blind each run with a split for judge 3 the same way, judge, unblind and grade again.

After raising `runs` (step 5), judge only the new runs and keep the verdicts of the runs judged before. First move each
`judge-<case>-<n>/` folder and `judge-<case>-<n>.md` aside to `judge-<case>-<n>-runs-1-<old runs>`, because `blind`
refuses a judge folder that exists; then name the new run folders to `blind`, for judge 1 too. For judges 2 and 3,
count the pass counts over every run, and blind only runs without that judge's verdict file. `blind` takes at most as
many runs as it has letters; past that, judge one model's runs at a time.

Done when no `grading.json` holds a `needs_review` entry.

## 4. Benchmark and analyse

1. `node tools/evals/eval-benchmark.ts <iteration dir> lz-gardening` writes `benchmark.json`, `benchmark.md` and
   `summary.md` (Pass@k and Pass^k per case, model and configuration).
2. One analyst agent (Opus at medium effort), briefed from [references/analyst.md](references/analyst.md), writes
   `analysis.md`.

Done when `benchmark.md`, `summary.md` and `analysis.md` exist.

## 5. Decide

Read `benchmark.md`, `summary.md`, `analysis.md` and the judges' `judge-<case>-<n>.md` files. Name every assertion
where `new_skill` did worse for a model, and trace each to text that differs or call it one sample. Unless the request
names another rule, keep the change only where no judged or script assertion got worse for any model.

When the results are not clear, raise `runs` from three to ten instead of deciding, and keep the runs already done:
Lars's rule (2026-11-23), "When eval results aren't clear, raise n from 3 to 10, keeping existing 3 runs in the 10
group instead of a full re-run when possible." Results are not clear when a worse assertion traces to no text that
differs, or when the gain the change targets rests on one run per model. Set `runs` in `iteration.json` and go back to
step 1.3; steps 2 to 4 then run and judge only the new runs, and the benchmark covers every run.

Record the decision with its evidence in the plan or log the round belongs to. Then remove each sample, its `.garden` site and
its `-origin.git` (all under `LZ_EVAL_SAMPLES_ROOT`), and `git worktree remove` the worktrees of step 1.

Done when the decision and every worse assertion with its cause are recorded and the samples and worktrees are gone.
