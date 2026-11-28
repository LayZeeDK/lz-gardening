# Machine notes for this session

This machine runs Windows 11 on ARM64. The Bash tool is Git Bash (POSIX sh).

## What code is here

- The working directory is the only code on this machine for this task. Related repositories (a backend, other
  services, other clones) are not available, and directories outside the working directory are off limits. When a
  conclusion depends on code that is not here, say so and mark that part unconfirmed.

## Dependencies

- Reading or searching `node_modules` is denied on this machine, with every tool: a Read, Grep or Glob call into it
  is refused. That refusal is a machine rule, not a fault in the task, so carry on without it.
- Get an installed package's version with `npm ls <package>` or from the lockfile (`package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`). Learn what a package does from its documentation or by running it (a small script
  that imports it, or its CLI's `--help`), not by reading its files. When a conclusion still needs its source, say so
  and mark that part unconfirmed.

## Finding files

- Find a file by name with `rg --files <dir> -g '<name>'`, starting from a directory you have already seen (in
  `git diff --stat`, a listing, or a file you read). In a large repository, a Glob or Grep call without a `path`,
  or with a leading `**/` or `*/` over the whole tree, times out after 20 seconds.
- `rg` exit code `2` means a path in the command does not exist; look the file up by name before retrying.

## Searching

- Search with the Grep tool or `rg`, never `grep`: `grep` is denied here.
- A zero-hit `rg` is not proof of absence. Check the exit code first, and run a pattern you know is present
  against the same path.
- Git Bash rewrites a slash at the start of an argument, or after a symbol such as `^ ( + @ = " $ |`, into a Windows path, so
  `rg -F "/config"` and `rg '^// '` search for something else and exit 1. Search with the Grep tool, or write each
  slash as `[/]`: `rg -e '[/]config'`, `rg '^[/][/] '`.
- `rg` matches one line at a time; use `-U` for text that spans lines.

## Shell commands

- Write every command with literal paths and single-quoted patterns. A command containing a shell variable
  (`$f`, a `for` loop over a variable), `$(...)` or a backtick, even inside a double-quoted pattern, is refused
  before it runs. To search for text such as `items$(`, use `rg -F 'items$('`.
- Run commands from the working directory, one command per call, without a `cd <path> &&` prefix.
- Never pass `/dev/stdin`, `/dev/stdout` or `/dev/stderr` as a file path to a program; Git Bash hands
  `/dev/stdin` over as `/proc/self/fd/0`, which Node.js resolves on the current drive (`D:\proc\self\fd\0`) and fails to open. Use fd 0
  (`readFileSync(0)`) instead.
- Multi-line text reaches a command through a file, not a heredoc or a quoted literal.
