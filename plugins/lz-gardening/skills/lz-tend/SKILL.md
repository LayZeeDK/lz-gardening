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
another clone can tend the class; the bed and its commits stay in the site for the next pass. When you continue a pass
that stopped (a usage limit, a restart), first renew the claim from the repository's checkout with
`weeds claim --class <class>`; when that prints anything but `claimed`, stop and report its line.

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
  `<site>/beds/<class>`) with its own directory flag. Git: `git -C "<bed>" ...`. The repository's package scripts:
  `npm --prefix "<bed>" run <script> [-- <args>]` (`pnpm -C "<bed>" run <script>`, `yarn --cwd "<bed>" <script>`),
  which run in the bed. A tool with no script runs from the bed's root, where it finds the bed's config and ignore
  files (Prettier's ignore files, ESLint's config and Nx's workspace are all found from the directory a tool starts
  in): `cd "<bed>" && npx --no -- <tool> <args>`, with paths relative to the bed, such as
  `cd "<bed>" && npx --no -- prettier --check .` or
  `cd "<bed>" && npx --no -- nx run-many -t lint --output-style=static`. `--no` makes it fail when the tool is not
  installed, where plain `npx` downloads a package of that name from the registry and runs it; `--` keeps npm from
  reading the tool's options (`--check`) as its own, which npm 12 refuses. Never `npx` `node`: run a test file
  through the project's test script, or `cd "<bed>" && node --test <file>`.
  Put options before file and path arguments: many tools read what follows the files as more files. In an Nx
  workspace, add `--output-style=static` to every `nx run` and `nx run-many`, so each task's output is in the tool
  result. `site` and `weeds` find the site from the checkout.
- Learn what an installed tool does from its `--help` or its documentation, and its version from the lockfile or
  `npm --prefix "<bed>" ls <package>`; never read `node_modules`.
- After every `cd "<bed>" && <command>`, send `cd "<checkout>"` as your very next call: the shell stays in the bed
  after a `cd`, and the other commands expect the checkout. `cd` to the bed's root, never to a folder inside it, and
  put nothing after the command. Never put git after a `cd`: Claude Code refuses such a chain, whatever the allow
  list says.
- Send each command bare: no pipe (`| tail`, `| head`, `| node -e`), no redirect (`>`, `2>&1`) and no second command
  after `;` or `&&` (the `cd "<bed>" &&` above aside). Claude Code refuses those forms in the bed and the site. Read
  the summary lines in the tool result. A passing command's long output is saved to a file the result names; a
  failing command's output is not, and loses its middle. When a starting command (step 4) prints more than the
  result shows, run a narrower one (one project's tests, one file's lint); a rerun after the change follows step 6.
  Write files only in the bed, with the Edit and Write tools: a rename across a file with Edit's `replace_all`,
  never a `node -e` or `sed` rewrite. Before a `replace_all`, Grep the file for the old name with a word character
  before or after it (`\w<old>|<old>\w`); when that matches, a longer name holds it, so rename each place with an Edit
  of its own. Delete a tracked file with `git -C "<bed>" rm <path>`, never `rm`.
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
weed too (`git show <commit>` for a `commit:` source). Then answer in two sentences, which open the report (step
8): what were the agents trying to do, and why was the shortcut the nearest example? For copies (a function
defined twice, a block repeated), first read why each copy exists: a comment, a doc or a test that pins the copies
alike can say a copy must stay (a file loaded or copied alone, which cannot import the shared one). Such a copy is
kept, not removed, and the check pins the copies instead. A copy is kept only on such words, cited by
`<path>:<line>` in its `--keep` reason. The cited line must say that this copy stays or cannot import the shared
one: a file's description, or a decision about something else, says neither. Your own judgement that a copy should
stay is no reason to keep it, so fix it or baseline it (step 6). For copies in two projects, search the repository's
records (ADRs, glossary or context maps, agent instructions, package READMEs) for both projects' names before you
decide: a line that says one may not import the other keeps both copies. A line that says what a project imports
today, such as a context map's "neither imports the other", is a description and keeps no copy. A check's message
never names an import the repository rules out.
A class whose weeds were `regrown` had a check that did not hold: start from the bed and
check that `weeds list` shows on each regrown weed (`[regrown after bed/<class>@<sha> (check: <where>)]`),
and find why (a rule too narrow, a suppression, an exception that spread, a bed not landed yet) before writing
another. The check reads `(check: <where> not on the base)` when its bed had not landed as of the garden's last
census, or one of its check files is gone from the base (`<where>` holds each check file, separated by `, `); a tend
pass takes no census, so a bed that landed since still reads so. When the bed has not landed, its check never ran on
the base: tend the class again in the same bed, which step 4 brings up to the base, and change the check only if it
misses the new weeds. The check reads `(check: <where>, base unknown)` when the site could not judge the base (no
readable census, the bed's or the census's commit is missing, or the bed shares no history with the base): read the
base yourself (`git show <base>:<path>` for each path in `<where>`) to see whether the check landed before you decide
which case it is.

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
file that cannot import it), the check pins it as step 2 says. The exception is a home that would be a new project
or a new public entry point of a published package (a new export path, say): that is the maintainers' change to
make, not the bed's. Make no such home; baseline the copies that need it (step 6) and name in the report the home
they wait for.

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
- the tests of the projects your change will touch (a root config counts as touching only the projects whose files
  you will edit, unless a test reads that config), one command per project even when the lint and type-check above
  run for all of them, so each summary comes back whole: each package's own test script, or in an Nx workspace
  `cd "<bed>" && npx --no -- nx run-many -t test -p <project> --output-style=static` (Nx finds its workspace from the
  directory it runs in, so it needs the `cd`). Run the whole suite only when the repository's done check requires
  it (CI, `AGENTS.md`, a pre-commit rule), still one command per project, and when that suite outruns the Bash
  tool's 10 minutes, report it as not run.
- the tests that load each file your change will touch, wherever they live: Grep the repository's test files for
  the file's name, and run every test file that imports it, reads it or copies it, with the command that runs that
  file (a root `node --test` suite that loads a module alone, say). A project's test script often leaves these out.
  A fixture project or a sample that a test copies or mutates counts too, since that test pins its text (a mutant's
  line and column, say): run that one test file, or, when it cannot finish within the Bash tool's limit, leave the
  fixture's names as they are and make it the file that keeps the shared definition.

Keep each command and its summary lines: the lines that count passes and failures, and the name of each failing
check or test. A failing command is a starting result too: its failures are the ones step 6 may see again. When the
tool result says a command's output was saved to a file, Read the end of that file for its summary lines. When you
cannot read a command's summary lines (the output was cut, or the command timed out), it is no starting result:
replace it with narrower commands whose summary lines you can read (one project's tests, one test folder) and keep
those. Step 6 runs the same commands, word for word and from the same directory, so their results compare. Done when
each has run before any edit and you hold its summary lines, with one test command per project: no `-p` that lists
two projects, and no `run-many -t test` without `-p`.

## 5. Rule first, proved on a real weed

Add the check, with its own test when it is a custom rule, and change nothing else yet: no edit to the code it
checks, and no commit. Write it with no baseline or exemption list (a list of allowed owners that names a copy you
will baseline is one), so its first output names every queued weed it will hold, the ones you will baseline
included; the baseline comes in step 6. When the class needs two checks, add and
prove both here, before the first fix. Run it in the bed while the code is as the base has it: it must report at
least one queued weed by the path `weeds list` shows. Run the check alone, on the weeds' files or the projects that
hold them (`cd "<bed>" && npx --no -- eslint <path> <path>`, one Nx project's lint); the run over every file it
covers comes last in this step. A file you wrote to trip it is no weed. A check that reports none
does not hold this class; change it until it does. Keep this first output: it lists the weeds the check holds (step
7). Then run `git -C "<bed>" status --short`: it must show only the check's own files.

Then run the check on code that does the same job the right way (the paved road, the simplest correct form): it must
report nothing there. Code the check skips through a baseline or an exemption list is not that code. A check that
also flags correct code teaches agents to suppress it.

Then run the check over every file it covers, still before any fix: the lint or test command of each project it
reaches, as step 6 will run it again. Each report of the check you added must be a queued weed. A report of anything
else means the check is too wide or the queue missed a copy. When the check is too wide, narrow it, say why in the
report, and run it again on the untouched bed and on the paved road, so the proof shows the check you keep. When the
queue missed a copy, queue it from the repository's checkout:
`weeds add --class <class> --where <path:line> --source commit:<sha> --note "<root cause>"`, where `<sha>` is what
`git log -n 1 --format=%h -S '<the copy's name>' -- <path>` prints; step 6 then fixes or baselines it like the rest.
When `add` prints `kept`, the copy was left on purpose: exempt it in the check, citing the keep's reason. Never rename
or narrow code the queue does not hold to quiet the check. Quote the first output, the status, the second output and
this run in the report: they are the proof. Done when you have all four.

## 6. Clear the bed

Fix every instance the check reports. Delete code the weeds made unused. Merging copies keeps what each caller
relies on: where the copies differ (a message, an edge case), keep the behaviour their tests pin, never edit a test
only so the merged copy passes it, and name each difference the merge removed in the report. Renaming a copy that
does the same job is no fix: it only moves the copy out of the check's reach. While you fix, rerun the check and
the tests of the projects you changed, no more. When the instances are too many or too risky for one pass, record
the rest in a baseline that can only shrink (the tool's own suppression or baseline file, or a list whose length the
check asserts as a maximum) and never raise one. A missing shared home is no reason to baseline: making it is step
3's job, unless step 3 leaves it to the maintainers (a new project or public entry point). For each group you
baseline, say in the report whether it was too large, too risky, or waiting for such a home, and why. Make no copy
of the home in a project that cannot import it: leave that project's instances as they are, in the baseline, and the
check never names such a copy as a second owner. Every exception left in the code names its rule and a reason.
Change a dependency list only through the package manager (`npm --prefix "<bed>/<project>" install <pkg>@<version>`,
or the repository's own manager), so its lockfile follows; in a bed whose `deps` is `linked`, install first (step 4).

Then run every command of step 4's starting results again in the bed, all of them, and the tests of any project or
file the change touched that step 4 did not run. Skip none: not because you expect the same result, not because the
change touches none of the files it covers, and not because it failed or ran long at the start. A command that failed
at the start runs again too, however long its output: its rerun shows whether the same checks or tests fail and no
others.

A rerun that exits non-zero, or whose summary lines you cannot read, has failed. Handle it in this order:

1. When its own output shows a format or lint error in a file you changed, fix it and run that command again; run
   another command again only when the fix touched code or config it covers (a format fix touches no test). Do not
   start the whole set over. A report of the check you added is no such error: it goes to 2. When it still fails, go
   on to 2.
2. Otherwise run the identical command once more, word for word and from the same directory, to tell a flaky failure
   from a real one.
3. When that fails or is cut too, you may run each failing project's target alone to read its failures. A narrower or
   changed command (another project list, `--parallel=1`, another reporter) is never the rerun's result.
4. When every failure is in the check you added in step 5 or its own test, and the fix touches only those files, fix
   it without narrowing what the check reports, and run the identical command once more.
5. Any other failure, or a failure after that run, counts as one the change may have caused (below): report it and
   release the claim, without looking further for its cause.

A command that fails after the change and has no starting result, or fails with a failure it did not have at the
start, may be a failure your change caused: stop before step 7 and report it with its output, so a human judges it.
The class stays open and the bed stays as it is. Quote the summary lines in one table, each command with its result
before and after the change; a row with no result after the change means this step is not done, so run that command.
Done when each command has run again and passes, or fails with exactly the failures it had at the start, by name.

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

A tended close names the check as the one that holds every weed it closes. Go through `weeds list --class <class>`
weed by weed and give each exactly one of these fates, and say which:

- **Held**: step 5's first output reported its path, or the bed fixed it and the check would report the weed if it
  came back. The tended close closes it.
- **Baselined**: its copy stays in the check's baseline (step 6). Name it in `--baselined` below: it stays open, for
  the pass that shrinks the baseline. Every weed of a group that keeps a copy in the baseline is baselined, the file
  that keeps the shared definition included: the group closes when its last copy goes. A weed in a file the check
  cannot reach (one its tool ignores) is first widened to or fixed (below); a fixture a test pins (step 4) is
  baselined, its path named in the check's ignore list, and the report says no check reaches it. A check that lists
  names holds no weed whose name it leaves out: add the name to the list, with its copies in the baseline, or the
  weed has no fate (below). The close refuses a baselined weed whose file no `--check` file names. When the check
  reads its baseline from a file of its own, pass that file as a `--check` too; otherwise the weed is in no baseline
  and needs another fate.
- **Kept**: the repository says it is deliberate, in words cited as step 2 says, even when the check names it as an
  allowed owner. `weeds close --id <id> --keep "<reason>"`, before the class close.
- **One-off**: it has nothing to fix and shares no cause with the rest. `weeds close --id <id> --one-off "<reason>"`.
  A function that shares a queued name but does another job is no one-off: it is a naming weed, fixed by a rename
  that says its job, after which the check holds it.

A weed with none of these fates means the class is not tended yet: widen the check (step 5) or fix the weed (step 6).
When the class holds several groups of copies, each with its own shared home, tend each group in the same bed, so
each weed ends held or baselined; a group that differs from the rest is not a one-off for that reason. Name each weed
closed one by one, and each weed baselined, in the report. Then close the class:
`weeds close-class --class <class> --tended "bed/<class>@<short sha>" --check "<where the check lives>"`, with one
`--check` per check file from step 3 (a lint rule and a test that holds what the rule cannot are two),
repository-relative (`eslint.config.mjs`, not a path on this machine), and
`--baselined <id>,<id>` naming the baselined weeds when there are any. It refuses an id that is no open weed of the
class, a baselined weed whose file no `--check` file names, a close that would baseline every open weed (the check
then holds none of them), and a `--check` file the named commit does not hold: fix the list and run it again. `<short sha>` is
the bed's last commit, printed by `git -C "<bed>" rev-parse --short HEAD` after your last commit: the close shares
the bed only when it names the bed's tip; with any other commit the bed stays in the site. It exits 1 and closes
nothing when its first sync is not `synced` or `local` or the claim is no longer this site's: stop and report its
line; the bed stays for the next pass. (The per-weed `close --id` closes above need no claim of this site's: when
their first sync is not `synced` or `local` they still close, and say `planned <state>` on stderr.) It prints
`closed <n>; <state>`: the close and the end of the claim land in the site's queue and, when the state is `synced`,
on `origin`, followed by the bed. Any other state shares them on the next `site open`. Lines on stderr name what its
last sync left out, kept local or gave back, such as a bed `origin` did not take. A later weed of the class,
anywhere, is then queued as `regrown` and names this bed and check. Done when `close-class` prints
`closed <n>; <state>`.

## 8. Report

- The class, its root cause in step 2's two sentences, and the decision.
- The check: layer number and `checks.md` row (step 3), file, message, and step 5's four quoted outputs: the check
  on the untouched bed, the bed's status then, the check on the paved road, and its run over every file it covers.
- Each refused lookup the pass went on without (the rules at the top), and what it would have shown.
- The weeds closed apart from the class (step 7), each with its id, kind and reason, and the weeds left open as
  baselined, each with its id.
- Each difference between copies that a merge removed (step 6).
- Instances fixed, instances baselined, code deleted, and the bed's net line count
  (`git -C "<bed>" diff --shortstat <start>`); a tend pass usually leaves the codebase shorter.
- The lint, type-check and test commands run in the bed, with their summary lines from step 4's starting results
  and from after the change.
- A layer 3 proposal, if one would help, described but not built.
- How to land it, from the repository: `git fetch origin refs/garden/beds/<class>` when the bed was shared, or
  `git fetch ../<repo>.garden bed/<class>` when it was not (the close did not end `synced`, or a line on stderr named
  the bed); say which applies. Then review and merge the fetched commit the way the repository lands work, and
  delete `refs/garden/beds/<class>` on `origin` once it has landed.
