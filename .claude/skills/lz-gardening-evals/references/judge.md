# Judge brief

Fill in the angle-bracket parts and send the rest as written. Adapted from skill-creator's `agents/grader.md`.

---

You are judge `<n>` for the `<case>` runs of iteration `<iteration dir>` of the lz-gardening plugin's evals. The
script checks are already graded; you grade only the assertions that need judgment, and you write files. Read only:
change no plugin file, checkout, site or bed; run no test, npm or Nx command; never read `node_modules`.

## The runs

Your runs are the letter folders in `<iteration dir>/judge-<case>-<n>/`. Each run comes from one of two plugin texts,
in an order you do not know; judge each on its own. In each letter folder:

- `calls.jsonl`: every tool call of the session, one JSON object per line: `index`, `agent`, `name`, `input`,
  `result` (its first 2000 characters), `isError`, `denied`. Plugin paths read `<plugin>`. Search it with the Grep
  tool and read the lines you need; it is too large to read whole.
- `final.md`: the session's final report. A run resumed after a usage limit or the time limit has one section per
  part; count the resume as context, not as the run's fault.
- `eval_metadata.json`: the case prompt and every assertion. Yours are those without a `check` key.
- `run.json`: the model, and the run's `checkout` and `site` folders; `git -C <dir> log`, `show` and `diff` there are
  fine.

Judge by the assertions and the case prompt. Until every verdict file below exists, read only your letter folders,
each run's checkout and site, and `GLOSSARY.md` of this repository. Everything else in `<iteration dir>` (other
judges' folders, keys and reports, the `eval-*` run folders, `iteration.json`) and the plugin texts name the
configurations.

## What to write

Judge one run at a time and write before moving on: `<letter folder>/llm-grades.json`, a JSON array with one object
per judged assertion, `{"text": <the assertion text, copied exactly from eval_metadata.json>, "passed": true|false,
"evidence": <one to three sentences naming the call indexes, report lines or commits that show it>}`. An assertion
passes on clear evidence that the run did the work, not on a report that says it did; a partly met assertion is
`false`, with what held named in the evidence.

When every run has its `llm-grades.json`, read the key file (letter to run folder; the folder names the
configuration) and `iteration.json`, and write `<iteration dir>/judge-<case>-<n>.md`: per assertion, every run's
verdict in one table; for each model, whether `new_skill` was worse, equal or better than `old_skill` and why,
marking a difference you cannot tie to the instructions as "one sample". Then diff the two plugin texts and say
whether any difference traces to text that differs. Last, list any assertion a run passed without doing what it is
meant to test, and any outcome that went wrong without an assertion that catches it. Label each claim [measured] or
[inferred].

Done when every run's `llm-grades.json` and `judge-<case>-<n>.md` exist. Your final reply: one line per letter with
its verdicts, nothing else.
