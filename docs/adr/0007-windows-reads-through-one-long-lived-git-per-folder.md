# On Windows a run reads git objects through one long-lived git per folder, kept synchronous by a worker thread

Starting a git process costs 40-100 ms on Windows and about 2 ms on Linux, and a command of the scripts starts 5 to
35 of them. On Windows a run therefore reads refs, objects and trees through one `git cat-file --batch-command` per
folder and environment, kept until the run ends; on Linux every read still starts its own git, which costs less there
than a long-lived one (19.3 ms for a reader's start, one read and its end, against 1.8 ms for one spawned read,
measured in an arm64 container). The internal `_LZ_GARDENING_INTERNAL_GIT_READS=spawn` or `reader`, which the tests set, picks either strategy on any
platform.

The store's API stays synchronous: a worker thread starts the git processes and moves their bytes, and the main
thread waits on a shared counter with `Atomics.wait` and reads the worker's messages with `receiveMessageOnPort`.

## Considered Options

- **An async store.** Plain `spawn` with no worker, but every caller, the retry loops and the CLI would have to await
  every read.
- **One protocol for both strategies, the spawn side running `cat-file --batch-command` once per read.** One parser,
  but Linux would run commands it does not run today, and the spawn strategy would lose the plain `rev-parse`,
  `--batch-check`, `--batch` and `ls-tree` it is tested against. The spawn strategy runs today's commands, and a
  contract test holds the two strategies to the same answers.
- **A worker thread per git process.** Each further folder would pay for a thread start as well as a git start; one
  worker serves every git process of the run.
- **An in-memory fake of the repository for the tests.** It would make the tests faster without making the scripts
  faster, and the refs' compare-and-set behaviour is where such a fake drifts from git.

## Consequences

- Windows does not rename or delete a folder that a running process has as its working directory. A run ends its
  readers when it returns or throws, and code that renames a folder within a run ends that folder's readers first
  (`closeReaders`, as the site's plant does before it moves the planted folder). Ending a reader costs about 4 ms on
  Windows (measured, median of 6 rounds).
- A reader sees what the run writes while it lives: refs moved and objects written after its start are read fresh
  (measured on git 2.54 and 2.56). One exception: a `packed-refs` file rewritten to the same size can stay stale in
  a reader for the rest of the run (measured on git 2.54 for Windows: 33 of 39 reads stale after a same-size
  `git pack-refs` within a second, still stale 3 s later). Only `pack-refs` rewrites it to the same size, so in a run
  only `git gc` or maintenance can cause it, such as the auto maintenance a `git fetch`, `git merge` or `git commit`
  may start in a user's repository. Every git the scripts start to write runs with `maintenance.auto=false`, so only a
  maintenance run outside the command can still do it.
- The reader's git starts in the worker thread, where the test module that counts git starts does not run, so the
  reader publishes each start on the `lz-gardening.git-start` diagnostics channel and the tests count it there.
- The worker runs from the source text of one function, so that function may name nothing outside its body.
