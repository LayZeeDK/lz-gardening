---
name: lz-tend
description: Tend one class of queued weeds - find the root cause, add the strongest check that rejects the class, prove it fails on a real weed, then fix or baseline every instance, in a bed branch beside the repository for a human to land. Use for "tend <class>", "pull these weeds", "make this mistake impossible", or a `ready to tend` line from a garden tick.
argument-hint: '[<class>] [--base <branch>]'
allowed-tools:
  - Read(${CLAUDE_SKILL_DIR}/**)
  - Read(${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/references/**)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/scripts/site.ts" *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/scripts/weeds.ts" *)
---

Tend one class of weeds from the garden queue. Arguments: $ARGUMENTS

Every weed pulled becomes a rule, so it cannot grow back. A tend pass writes the rule first, proves it rejects the
weed, then clears the bed. It works in a bed: a worktree of the garden site on branch `bed/<class>`. It never
writes to the repository's checkout (tool caches in a linked `node_modules` aside), never pushes with git itself and
never merges; a human lands the bed. The scripts push to the repository's `origin`, under `refs/garden/` only: the
queue's `refs/garden/log` with the claim, the release and the close, and the closed bed's
`refs/garden/beds/<class>`. Each step ends on a done condition; when one is not met, report the command and its
output and stop.

Two rules hold for the whole pass:

- **Read with the Read tool, search with the Grep tool, list files with the Glob tool**, in the checkout and in the
  bed alike. `rg`, `grep`, `find`, `ls`, `cat`, `head` and `tail` through Bash are outside the pass: many users'
  rules refuse them, and a refused command ends the pass.
- **A refused command the pass needs ends the pass.** A command the pass needs is one of the forms below, a step's
  own command, or a command of the check or the repository's checks. Report it with its refusal, and stop. The
  refusal is the user's answer to the command in every form, so the pass reaches the same result no other way. A
  refused lookup the pass can do without (the source of a dependency, a log outside the workspace) does not end it:
  name it in the report and go on without that information, never fetching it another way.

When the pass stops at any point after step 1's claim, its last command is `weeds release --class <class>`, so
another clone can tend the class; the bed and its commits stay in the site for the next pass.

Two scripts of the `lz-garden` skill do the site's bookkeeping: `site` below is
`node "${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/scripts/site.ts"`, and `weeds` is
`node "${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/scripts/weeds.ts"`, run from the repository's checkout: it finds the
site's queue from there. Both run without asking when the Bash call holds that command alone, as written.
`<checkout>` below is the repository's checkout, the directory the session started in.

A tend pass runs under the user's own permission rules, and the site lies beside the repository, outside the
session's working directory. Until it is added as one, Claude Code asks before every read or edit of a bed file and
refuses `cd`, `cat`, `cmp` and git's file arguments there. So after `site open` (step 1), unless `<site>` is among
the session's working directories (the session's environment lists any added ones), ask the user to run
`/add-dir <site>` (or to start the session with `--add-dir <site>`) and wait. Then:

- Stay in the repository's checkout and point each command at the bed (`<bed>`, the full path
  `<site>/beds/<class>`) with its own directory flag. Git: `git -C "<bed>" ...`. Tools: the repository's package
  scripts, `npm --prefix "<bed>" run <script> [-- <args>]` (`pnpm -C "<bed>" run <script>`,
  `yarn --cwd "<bed>" <script>`), which run in the bed. A tool with no script:
  `npm --prefix "<bed>" exec --no -- <tool> <args>`, which takes the bed's installed tool but runs in the checkout,
  so give it the bed's files by full path, and use it only for a tool that finds its config beside the files it reads
  (Prettier, say). `--no` makes it fail when the tool is not installed, where plain `exec` downloads a package of that
  name from the registry and runs it. Never `exec` `node`: run a test file through the project's test script, or
  `cd "<bed>" && node --test <file>`. In an Nx workspace, add `--output-style=static` to every `nx run` and
  `nx run-many`, so each task's output is in the tool result. `site` finds the site from the checkout.
- Learn what an installed tool does from its `--help` or its documentation, and its version from the lockfile or
  `npm --prefix "<bed>" ls <package>`; never read `node_modules`.
- When nothing above fits, run `cd "<bed>" && <command>` with nothing after the command, and send `cd "<checkout>"`
  as your very next call: the shell stays in the bed after a `cd`, and the commands above expect the checkout. Never
  put git after a `cd`: Claude Code refuses such a chain, whatever the allow list says.
- Send each command bare: no pipe (`| tail`, `| head`, `| node -e`), no redirect (`>`, `2>&1`) and no second command
  after `;` or `&&` (the `cd "<bed>" &&` above aside). Claude Code refuses those forms in the bed and the site. Read
  the summary lines in the tool result; when a command prints more than the result shows, run a narrower one (one
  project's tests, one file's lint). Write files only in the bed, with the Edit and Write tools: a rename across a
  file with Edit's `replace_all`, never a `node -e` or `sed` rewrite. Delete a tracked file with
  `git -C "<bed>" rm <path>`, never `rm`.
- Run each command in the foreground and read its output in the tool result; for a long one, raise the Bash tool's
  timeout, up to its limit of 10 minutes. A command that runs longer moves to the background, and its output file
  cannot be read: run the tests of the projects the change touches instead (step 4).
- Write each command out in full, with no shell variables, `$(...)` or loops: the user's rules cannot match those,
  so they ask every time.

## 1. Pick the class

Run `site open`, passing `--base <branch>` when the arguments name one; its JSON line names `<site>` and `<base>`
(`${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/references/site.md` explains both). Then claim the class, so no other
clone or CI run tends it at the same time: `weeds claim --class <class>` with a class argument, else `weeds claim`,
which takes the first ready class (open weeds in two or more files, not `stale-verification` or `repeated-lesson`,
not claimed by another writer) and prints it; say which. It prints `claimed <class> until <time>` and exits 0 when the
claim is yours and shared, or the garden is local. Exit 1 stops the pass: report its line as it is
(`taken <class> by <holder> until <time>`, `nothing ready to tend`, `nothing open for <class>`, or
`cannot claim <class>: <state> ...`). Then `weeds list --class <class>`. Done when you hold the claim and the open
weeds of one class.

## 2. Find the root cause

Read every open weed as it is on the base: run `git show <base>:<path>` for each weed's file, one call per file, and
when the tool result says the output was saved to a file, Read that file to its end. A Read or Grep of the checkout
does not replace this call: the checkout can be on another branch than `<base>`. Read the commit that planted each
weed too (`git show <commit>` for a `commit:` source). Then answer in two sentences, written in your reply before
step 3: what were the agents trying to do, and why was the shortcut the nearest example? For copies (a function
defined twice, a block repeated), first read why each copy exists: a comment, a doc or a test that pins the copies
alike can say a copy must stay (a file loaded or copied alone, which cannot import the shared one). Such a copy is
kept, not removed, and the check pins the copies instead. A copy is kept only on such words, cited by
`<path>:<line>` in its `--keep` reason; your own judgement that a copy should stay is no reason to keep it, so fix it
or baseline it (step 6). A class whose weeds were `regrown` had a check that did not hold: start from the bed and check that
`weeds list` shows on each regrown weed (`[regrown after bed/<class>@<sha> (check: <where>)]`), and find why (a rule
too narrow, a suppression, an exception that spread, a bed not landed yet) before writing another. The check reads
`(check: <where> not on the base)` when its bed had not landed as of the garden's last census, or the check's file is
gone from the base; a tend pass takes no census, so a bed that landed since still reads so. When the bed has not
landed, its check never ran on the base: tend the class again in the same bed, which step 4 brings up to the base,
and change the check only if it misses the new weeds. The check reads `(check: <where>, base unknown)` when the site
could not judge the base (no readable census, the bed's or the census's commit is missing, or the bed shares no
history with the base): read the base yourself (`git show <base>:<where>`) to see whether the check landed before you
decide which case it is.

Then decide, and say which in your reply:

- **Keep**: the pattern is deliberate and right here, as the repository says in words you cite by `<path>:<line>`.
  `weeds close-class --class <class> --keep "<reason>"`, report, stop.
- **One-off**: on reading, the weeds share no cause or sit in one place.
  `weeds close-class --class <class> --one-off "<reason>"`, report, stop.
- **Redirect**: a `repeated-lesson` class is tended through the class its lessons are about, and a
  `stale-verification` class through a refresh of the verification setup, not here. Run
  `weeds release --class <class>`, name that class or job in the report and stop; the weeds stay open as evidence.
- **Tend**: continue.

Keep and one-off end the claim through `close-class`. `close-class` closes nothing and exits 1 unless its first sync
is `synced` or `local` and this site still holds the claim; report its line as it is
(`cannot check the claim of <class>: ...`, `this site holds no claim of <class>; ...` or
`<class> is claimed by <holder> until <time>`). Done when you have said the root cause and the decision.

## 3. Choose the layer

First Read two files with the Read tool, even for a class you think you know: the layer list ("Layers") in
`${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/references/weeds.md`, and `${CLAUDE_SKILL_DIR}/references/checks.md`, which
lists, per stack, the checks that hold common classes. Find the rows for this class and the repository's stack.

Take the strongest layer that can hold the class. Prefer, in order: change the code so the weed cannot be written
(one shared function, one paved road, delete the bad examples); a type or compiler flag; a lint rule whose message
names the fix; a test. Layer 3 (hooks, permissions) is proposed in the report, never built.
Layers 4 to 6 (instructions, skills, style guide) only when nothing stronger can hold it; say why.

When the paved road needs a shared home that does not exist yet (a module every copy can import), make it in the bed,
with the decision record the repository's instructions ask for (an ADR, say): a human reviews the bed before it
lands, so the choice of home is theirs to accept or change. Do not stop to ask. When a copy cannot use that home (a
file that cannot import it), the check pins it as step 2 says.

Done when you have read both files and can name the check, its layer by the number `weeds.md` gives it (a type,
lint rule or test is layer 2; a change to the code itself is layer 1), the `checks.md` row it follows (or that no
row fits, and why), where it lives, and the message it prints.

## 4. Make the bed

Run `site bed --class <class> --base <base>`; its JSON line names `<bed>` and the `<start>` commit, which you keep.
It syncs first and makes the bed only while you hold the claim; exit 1 stops the pass, and you report its line as it
is. On a bed that exists it merges the base in first, keeping the bed's work. When another clone tended the class
before, the bed starts from, or merges in, the bed that clone shared.
When its `deps` is `install`, run the command its `install` field names before anything else in the bed: the bed has
no dependencies until you do. When it is `linked` and a later step changes the bed's dependencies (a new lint
plugin, say), remove the link and install first, as `${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/references/site.md` says
under "Beds"; never install through the link, which would write into the checkout's `node_modules`.

Then, before your first edit to the bed's files, take the starting results, so a failure that predates your change
is not blamed on it. Read the repository's checks from `package.json`, `nx.json`, CI config and its agent
instructions, and run in the bed:

- its lint, type-check and format check, the commands its own `check` script or CI runs, not a narrower script
  such as `check:<part>`. When your change will touch a root config (the lint config, a base `tsconfig`, the
  Prettier config), that config reaches every project, so run these for all of them, as CI does;
- the tests of the projects your change will touch: each package's own test script, or in an Nx workspace
  `cd "<bed>" && npx --no nx run-many -t test -p <project>,<project> --output-style=static` (Nx finds its workspace
  from the directory it runs in, so it needs the `cd`). Run the whole suite only when the repository's done check requires it (CI,
  `AGENTS.md`, a pre-commit rule), and when that suite outruns the Bash tool's 10 minutes, report it as not run.
- the tests that load each file your change will touch, wherever they live: Grep the repository's test files for
  the file's name, and run every test file that imports it, reads it or copies it, with the command that runs that
  file (a root `node --test` suite that loads a module alone, say). A project's test script often leaves these out.

Keep each command and its summary lines: the lines that count passes and failures, and the name of each failing
check or test. A failing command is a starting result too: its failures are the ones step 6 may see again. When the
tool result says a command's output was saved to a file, Read the end of that file for its summary lines. When you
cannot read a command's summary lines (the output was cut, or the command timed out), it is no starting result:
replace it with narrower
commands whose summary lines you can read (one project's tests, one test folder) and keep those. Step 6 runs the
same commands. Done when each has run before any edit and you hold its summary lines.

## 5. Rule first, proved on a real weed

Add the check, with its own test when it is a custom rule, and change nothing else yet: no edit to the code it
checks, and no commit. Run it in the bed while the code is as the base has it: it must report at least one queued
weed by the path `weeds list` shows. A file you wrote to trip it is no weed. A check that reports none does not hold
this class; change it until it does. Keep this first output: it lists the weeds the check holds (step 7). Then run
`git -C "<bed>" status --short`: it must show only the check's own files.

Then run the check on code that does the same job the right way (the paved road, the simplest correct form): it must
report nothing there. Code the check skips through a baseline or an exemption list is not that code. A check that
also flags correct code teaches agents to suppress it. Quote the first output, the status and the second output in
the report: they are the proof. Done when you have all three.

## 6. Clear the bed

Fix every instance the check reports. Delete code the weeds made unused. When the instances are too many or too
risky for one pass, record the rest in a baseline that can only shrink (the tool's own suppression or baseline
file, or a list whose length the check asserts as a maximum) and never raise one. Every exception left in the code
names its rule and a reason.

Then run every command of step 4's starting results again in the bed, all of them, and the tests of any project or
file the change touched that step 4 did not run. Skip none: not because you expect the same result, not because the
change touches none of the files it covers, and not because it failed or ran long at the start. A command that failed
at the start runs again too, however long its output: its rerun shows whether the same checks or tests fail and no
others. Read its summary lines as step 4 says; when a rerun's summary lines are cut from the result, count it as a
failure the change may have caused (below). Done when each has run again and passes, or fails with exactly the
failures it had at the start, by name. Quote their summary lines in one table, each command with its result before
and after the change; a row with no result after the change means this step is not done, so run that command. A command that fails after the change and has no starting result, or fails with a
failure it did not have at the start, may be a failure your change caused: stop before step 7 and report it with its
output, so a human judges it. The class stays open and the bed stays as it is.

## 7. Commit and close

Commit the bed change, one commit per check, holding the check and its clean-up together. Send each git write as a
call of its own, and read its result before you send the next:

1. `git -C "<bed>" status --short` lists what changed.
2. `git -C "<bed>" add <path> <path> ...` stages the files you changed, by path. Stage by name only: `git add -A` and
   `git add .` are refused by many users' rules, and they stage whatever else the bed holds.
3. `git -C "<bed>" status --short` again: every change you made is staged, and nothing else.
4. `git -C "<bed>" commit -m "<subject>" -m "<paragraph>" ...`, one `-m` per paragraph, so no message file is
   written or removed. Write the message in the repository's own convention. Read it from the last commits
   (`git -C "<bed>" log -10`): their subject form, body and trailers. The convention decides every trailer: add one
   (`Co-Authored-By`, `Signed-off-by`) only when those commits carry it.

Then, from the repository's checkout, renew the claim with `weeds claim --class <class>`: a long pass can outlast it.
When that prints anything but `claimed`, stop and report its line; the bed stays for the next pass.

A tended close names the check as the one that holds every weed it closes. The check holds a weed when step 5's
first output reported its path, or when the bed fixed it and the check would now report the weed if it came back.
Go through `weeds list --class <class>` weed by weed and say which holds it. An open weed the check does not hold (a
function that shares the name but not the job, a copy the check does not name, say) is closed one by one first:
`weeds close --id <id> --keep "<reason>"` when the repository says it is deliberate (cited as step 2 says) or it is
not this class's mistake, `weeds close --id <id> --one-off "<reason>"` when it shares no cause with the rest.
Otherwise the class is not tended yet: widen the check (step 5) or fix the weed (step 6) until the check holds it.
Name each weed closed one by one in the report. Then close the class:
`weeds close-class --class <class> --tended "bed/<class>@<short sha>" --check "<where the check lives>"`, with the
check's file from step 3, repository-relative (`eslint.config.mjs`, not a path on this machine). `<short sha>` is
the bed's last commit, printed by `git -C "<bed>" rev-parse --short HEAD` after your last commit: the close shares
the bed only when it names the bed's tip; with any other commit the bed stays in the site. It exits 1 and closes
nothing when its first sync is not `synced` or `local` or the claim is no longer this site's: stop and report its
line; the bed stays for the next pass. (The per-weed `close --id` closes above need no claim of this site's: when
their first sync is not `synced` or `local` they still close, and say `planned <state>` on stderr.) It prints
`closed <n>; <state>`: the close and the end of the claim land in the site's queue and, when the state is `synced`,
on `origin`, followed by the bed. Any other state shares them on the next `site open`. A line on stderr names a bed
`origin` did not take. A later weed of the class, anywhere, is then queued as `regrown` and names this bed and check.
Done when `close-class` prints `closed <n>; <state>`.

## 8. Report

- The class, its root cause, and the decision.
- The check: layer number and `checks.md` row (step 3), file, message, and step 5's three quoted outputs: the check
  on the untouched bed, the bed's status then, and the check on the paved road.
- Each refused lookup the pass went on without (the rules at the top), and what it would have shown.
- The weeds closed apart from the class (step 7), each with its id, kind and reason.
- Instances fixed, instances baselined, code deleted, and the bed's net line count
  (`git -C "<bed>" diff --shortstat <start>`); a tend pass usually leaves the codebase shorter.
- The lint, type-check and test commands run in the bed, with their summary lines from step 4's starting results
  and from after the change.
- A layer 3 proposal, if one would help, described but not built.
- How to land it, from the repository: `git fetch origin refs/garden/beds/<class>` when the bed was shared, or
  `git fetch ../<repo>.garden bed/<class>` when it was not (the close did not end `synced`, or a line on stderr named
  the bed); say which applies. Then review and merge the fetched commit the way the repository lands work, and
  delete `refs/garden/beds/<class>` on `origin` once it has landed.
