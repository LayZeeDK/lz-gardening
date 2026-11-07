---
name: tend
description: Tend one class of queued weeds - find the root cause, add the strongest check that rejects the class, prove it fails on a real weed, then fix or baseline every instance, in a bed branch beside the repository for a human to land. Use for "tend <class>", "pull these weeds", "make this mistake impossible", or a `ready to tend` line from a garden tick.
argument-hint: '[<class>] [--base <branch>]'
---

Tend one class of weeds from the garden queue. Arguments: $ARGUMENTS

Every weed pulled becomes a rule, so it cannot grow back. A tend pass writes the rule first, proves it rejects the
weed, then clears the bed. It works in a bed: a worktree of the garden site on branch `bed/<class>`. It never
writes to the repository's checkout, never pushes and never merges; a human brings the bed home. Each step ends on
a check; when one fails, report the command and its output and stop.

Two scripts of the garden skill do the site's bookkeeping, run from the repository's checkout: `site` below is
`node "${CLAUDE_PLUGIN_ROOT}/skills/garden/scripts/site.ts"`, and `weeds` is
`node "${CLAUDE_PLUGIN_ROOT}/skills/garden/scripts/weeds.ts"` with `--file "<site>/.garden/weeds.jsonl"` on every
call. Commands run from the repository's checkout. Point git at the site or the bed (`<bed>`, the full path
`<site>/beds/<class>`) with `git -C "<site>"` or `git -C "<bed>"`. Run the repository's own lint, type-check and
test commands in the bed as one Bash call, `cd "<bed>" && <command>`. `site` finds the site from the directory it
runs in, so when the shell is no longer in the checkout, `cd` back to it before calling `site`.

## 1. Pick the class

Run `site open`, passing `--base <branch>` when the arguments name one; its JSON line names `<site>` and `<base>`
(`${CLAUDE_PLUGIN_ROOT}/skills/garden/references/site.md` explains both). With no class argument, run
`weeds groups --min 2` and take the first class other than `stale-verification` and `repeated-lesson`, which are
not tended directly (step 2); say which. When it lists no class, report `nothing ready to tend` and stop. Then
`weeds list --class <class>`. Done when you hold the open weeds of one class.

## 2. Find the root cause

Read every open weed at the base (`git show <base>:<path>`) and the commit that planted it (`--source`).
Answer in two sentences: what were the agents trying to do, and why was the shortcut the nearest example? A class
whose weeds were `regrown` had a fix that did not hold: find why (a rule too narrow, a suppression, an exception
that spread) before writing another.

Then decide, and say which:

- **Keep**: the pattern is deliberate and right here. `weeds close-class --class <class> --by "<reason>" --keep`,
  `site commit --message "garden: keep <class>"`, report, stop.
- **One-off**: on reading, the weeds share no cause or sit in one place.
  `weeds close-class --class <class> --by "one-off: <reason>"`, `site commit --message "garden: one-off <class>"`,
  report, stop.
- **Redirect**: a `repeated-lesson` class is tended through the class its lessons are about, and a
  `stale-verification` class through a refresh of the verification setup, not here. Name that class or job in the
  report and stop; the weeds stay open as evidence.
- **Tend**: continue.

## 3. Choose the layer

Take the strongest layer that can hold the class, from the layer list in
`${CLAUDE_PLUGIN_ROOT}/skills/garden/references/weeds.md`. `${CLAUDE_SKILL_DIR}/references/checks.md` lists, per stack,
the checks that hold common classes; read the rows for the repository's stack. Prefer, in order: change the code so
the weed cannot be written (one helper, one paved road, delete the bad examples); a type or compiler flag; a lint
rule whose message names the fix; a test. Layer 3 (hooks, permissions) is proposed in the report, never built.
Layers 4 to 6 (instructions, skills, style guide) only when nothing stronger can hold it; say why.

Done when you can name the check, where it lives, and the message it prints.

## 4. Make the bed

Create the bed worktree and its dependencies as `${CLAUDE_PLUGIN_ROOT}/skills/garden/references/site.md` describes
under "Beds", and keep the `<start>` commit it names. Done when the repository's own
lint, type-check and test commands run in the bed (read them from `package.json`, `nx.json` and CI config); note
any that fail before your change, so they are not blamed on it.

## 5. Rule first, proved on a real weed

Add the check, with its own test when it is a custom rule. Run it in the bed before fixing anything: it must report
at least one queued weed by path. A check that reports none does not hold this class; change it until it does.
Then run it on code that does the same job the right way (the paved road, the simplest correct form): it must
report nothing there. A check that also flags correct code teaches agents to suppress it. Quote both outputs in the
report: they are the proof.

## 6. Clear the bed

Fix every instance the check reports. Delete code the weeds made unused. When the instances are too many or too
risky for one pass, record the rest in a baseline that can only shrink (the tool's own suppression or baseline
file, or a count the check enforces as a maximum) and never raise one. Every exception left in the code names its
rule and a reason.

Done when the repository's lint, type-check and test commands pass in the bed, apart from failures noted in step 4.
Quote their summary lines.

## 7. Commit and close

Commit the bed change with `git -C "<bed>"`, following the repository's commit message convention
(`git log --oneline -20`), one commit per check, holding the check and its clean-up together. Then, from the
repository's checkout, close the class and commit the queue:
`weeds close-class --class <class> --by "bed/<class>@<short sha>"`, then
`site commit --message "garden: tend <class>"`.

## 8. Report

- The class, its root cause, and the decision.
- The check: layer, file, message, and the quoted output that proved it rejects a real weed.
- Instances fixed, instances baselined, code deleted, and the bed's net line count
  (`git -C "<bed>" diff --shortstat <start>`); a tend pass usually leaves the codebase shorter.
- The checks run in the bed, with their summary lines.
- A layer 3 proposal, if one would help, described but not built.
- How to land it, from the repository: `git fetch ../<repo>.garden bed/<class>`, then review and merge the
  fetched branch the way the repository lands work.
