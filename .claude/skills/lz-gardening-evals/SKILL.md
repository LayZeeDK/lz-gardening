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
   step 5 use these names.

   ```json
   {
     "configs": {
       "new_skill": { "plugin": "<dir>/plugins/lz-gardening", "commit": "<sha>", "text": "<what changed>" },
       "old_skill": { "plugin": "<dir>/plugins/lz-gardening", "commit": "<sha>", "text": "<the text before it>" }
     },
     "models": ["sonnet", "opus"],
     "runs": 1
   }
   ```

3. `node tools/evals/eval-run.ts scaffold <iteration dir>`.

Done when every configuration, model and run has a sample with a `.garden` site beside it.

## 2. Run the cases

`node tools/evals/eval-run.ts run <iteration dir> garden-seed`, then, once every seed run exited 0 (itself or through
a resume), the same with `tend`, which runs on the garden sites the seed pass filled. Each prints one
`<run dir> exit <status>` line per run and exits 1 when any run failed. A seed pass takes up to 14 minutes and a tend
pass up to 40; run them in the background.

A run that did not exit 0 has its cause in its newest `outputs/result*.json`: `status`, `stderr` and the last
`result` line of `stdout`. Resume a tend run a usage limit or the time limit stopped with
`node tools/evals/eval-run.ts resume <iteration dir> tend <run dir>...`, which continues its session into
`outputs/result-resume-<n>.json`. A seed run cannot resume: `lz-garden` runs forked, so its work was in a subagent
the session cannot continue, and the resumed session's own Skill call is refused. A stopped seed run, and a run that
crashed for another reason, start the iteration over: move aside every run folder of the iteration and every sample
with its `.garden` and `-origin.git`, then go back to step 1.3.

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
names another rule, keep the change only where no judged or script assertion got worse for any model. Record the
decision with its evidence in the plan or log the round belongs to. Then remove each sample, its `.garden` site and
its `-origin.git` (all under `LZ_EVAL_SAMPLES_ROOT`), and `git worktree remove` the worktrees of step 1.

Done when the decision and every worse assertion with its cause are recorded and the samples and worktrees are gone.
