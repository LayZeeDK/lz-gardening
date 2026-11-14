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
  `npm --prefix "<bed>" exec -- <tool> <args>`, which takes the bed's installed tool but runs in the checkout, so
  give it the bed's files by full path, and use it only for a tool that finds its config beside the files it reads
  (Prettier, say). `site` finds the site from the checkout.
- When nothing above fits, run `cd "<bed>" && <command>` with nothing after the command, and send `cd "<checkout>"`
  as your very next call: the shell stays in the bed after a `cd`, and the commands above expect the checkout. Never
  put git after a `cd`: Claude Code refuses such a chain, whatever the allow list says.
- Send each command bare: no pipe (`| tail`, `| head`, `| node -e`), no redirect (`>`, `2>&1`) and no second command
  after `;` or `&&` (the `cd "<bed>" &&` above aside). Claude Code refuses those forms in the bed and the site. Read
  the summary lines in the tool result; when a command prints more than the result shows, run a narrower one (one
  project's tests, one file's lint). Write files only in the bed, with the Edit and Write tools.
- Run each command in the foreground and read its output in the tool result; for a long one, raise the Bash tool's
  timeout, up to its limit of 10 minutes. A command that runs longer moves to the background, and its output file
  cannot be read: run the tests of the projects the change touches instead (step 4).
- Stop at a refused command: report it and end the tend pass, as when a step's done condition is not met. The
  refusal is the user's answer to the command in every form, the forms above included, so the pass ends there.
- Read, search and list files with the Read, Grep and Glob tools, not `cat`, `grep` or `ls`.
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

Read every open weed at the base (`git show <base>:<path>`) and the commit that planted it (`--source`).
Answer in two sentences: what were the agents trying to do, and why was the shortcut the nearest example? For
copies (a helper defined twice, a block repeated), first read why each copy exists: a comment, a doc or a test that
pins the copies alike can say a copy must stay (a file loaded or copied alone, which cannot import the shared one).
Such a copy is kept, not removed, and the check pins the copies instead. A class
whose weeds were `regrown` had a check that did not hold: start from the bed and check that `weeds list` shows on
each regrown weed (`[regrown after bed/<class>@<sha> (check: <where>)]`), and find why (a rule too narrow, a
suppression, an exception that spread, a bed not landed yet) before writing another. The check reads
`(check: <where> not on the base)` when its bed had not landed as of the garden's last census, or the check's file is
gone from the base; a tend pass takes no census, so a bed that landed since still reads so. When the bed has not
landed, its check never ran on the base: tend the class again in the same bed, which step 4 brings up to
the base, and change the check only if it misses the new weeds. The check reads `(check: <where>, base unknown)` when
the site could not judge the base (no readable census, the bed's or the census's commit is missing, or the bed shares
no history with the base): read the base
yourself (`git show <base>:<where>`) to see whether the check landed before you decide which case it is.

Then decide, and say which:

- **Keep**: the pattern is deliberate and right here. `weeds close-class --class <class> --keep "<reason>"`,
  report, stop.
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

Take the strongest layer that can hold the class, from the layer list in
`${CLAUDE_PLUGIN_ROOT}/skills/lz-garden/references/weeds.md`. `${CLAUDE_SKILL_DIR}/references/checks.md` lists, per
stack, the checks that hold common classes; read the rows for the repository's stack. Prefer, in order: change the
code so the weed cannot be written (one helper, one paved road, delete the bad examples); a type or compiler flag; a
lint rule whose message names the fix; a test. Layer 3 (hooks, permissions) is proposed in the report, never built.
Layers 4 to 6 (instructions, skills, style guide) only when nothing stronger can hold it; say why.

Done when you can name the check, its layer by the number `weeds.md` gives it (a type, lint rule or test is
layer 2; a change to the code itself is layer 1), where it lives, and the message it prints.

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
  such as `check:<part>`;
- the tests of the projects your change will touch: each package's own test script, or in an Nx workspace
  `cd "<bed>" && npx nx run-many -t test -p <project>,<project>` (Nx finds its workspace from the directory it runs
  in, so it needs the `cd`). Run the whole suite only when the repository's done check requires it (CI,
  `AGENTS.md`, a pre-commit rule), and when that suite outruns the Bash tool's 10 minutes, report it as not run.
- the tests that load each file your change will touch, wherever they live: Grep the repository's test files for
  the file's name, and run every test file that imports it, reads it or copies it, with the command that runs that
  file (a root `node --test` suite that loads a module alone, say). A project's test script often leaves these out.

Keep each command and its summary lines. Step 6 runs the same commands. Done when each has run before any edit.

## 5. Rule first, proved on a real weed

Add the check, with its own test when it is a custom rule. Run it in the bed before fixing anything: it must report
at least one queued weed by path. A check that reports none does not hold this class; change it until it does.
Then run it on code that does the same job the right way (the paved road, the simplest correct form): it must
report nothing there. A check that also flags correct code teaches agents to suppress it. Quote both outputs in the
report: they are the proof. Done when you have both outputs.

## 6. Clear the bed

Fix every instance the check reports. Delete code the weeds made unused. When the instances are too many or too
risky for one pass, record the rest in a baseline that can only shrink (the tool's own suppression or baseline
file, or a count the check enforces as a maximum) and never raise one. Every exception left in the code names its
rule and a reason.

Then run every command of step 4's starting results again in the bed, all of them, and the tests of any project or
file the change touched that step 4 did not run. Done when each has run again and passes, apart from the same
failures as in the starting results. Quote their summary lines. A command that fails after the change and has no
starting result may be a failure your change caused: stop before step 7 and report it with its output, so a human
judges it. The class stays open and the bed stays as it is.

## 7. Commit and close

Commit the bed change, one commit per check, holding the check and its clean-up together. Send each git write as a
call of its own, and read its result before you send the next:

1. `git -C "<bed>" status --short` lists what changed.
2. `git -C "<bed>" add <path> <path> ...` stages the files you changed, by path. Stage by name only: `git add -A` and
   `git add .` are refused by many users' rules, and they stage whatever else the bed holds.
3. `git -C "<bed>" status --short` again: every change you made is staged, and nothing else.
4. `git -C "<bed>" commit` with a message in the repository's own convention. Read it from the last commits
   (`git -C "<bed>" log -10`): their subject form, body and trailers. The convention decides every trailer: add one
   (`Co-Authored-By`, `Signed-off-by`) only when those commits carry it.

Then, from the repository's checkout, renew the claim with `weeds claim --class <class>`: a long pass can outlast it.
When that prints anything but `claimed`, stop and report its line; the bed stays for the next pass.

A tended close names the check as the one that holds every weed it closes. So first close, one by one, each open
weed of `weeds list --class <class>` that the check does not hold (a function that shares the name but not the job,
say): `weeds close --id <id> --keep "<reason>"` when it is deliberate or not this class's mistake, else
`weeds close --id <id> --one-off "<reason>"`. Name each in the report. Then close the class:
`weeds close-class --class <class> --tended "bed/<class>@<short sha>" --check "<where the check lives>"`, with the
check's file from step 3, repository-relative (`eslint.config.mjs`, not a path on this machine). `<short sha>` is
the bed's last commit, printed by `git -C "<bed>" rev-parse --short HEAD` after your last commit: the close shares
the bed only when it names the bed's tip; with any other commit the bed stays in the site. It exits 1 and closes
nothing when its first sync is not `synced` or `local` or the claim is no longer this site's: stop and report its
line; the bed stays for the next pass. (The keep and one-off closes need no claim of this site's: when their first
sync is not `synced` or `local` they still close, and say `planned <state>` on stderr.) It prints
`closed <n>; <state>`: the
close and the end of the claim land in the site's queue and, when the state is `synced`, on `origin`, followed by
the bed. Any other state shares them on the next `site open`. A line on stderr names a bed `origin` did not take. A
later weed of the class, anywhere, is then queued as `regrown` and names this bed and check. Done when `close-class`
prints `closed <n>; <state>`.

## 8. Report

- The class, its root cause, and the decision.
- The check: layer number (step 3), file, message, and the quoted output that proved it rejects a real weed.
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
