# Search commands

Read only when a Grep or Glob call answered `No such tool available`, or the session has neither tool: Claude Code's
native macOS and Linux builds. Where the two tools exist, none of this applies and no command below runs.

On such a build, where the skill says Grep or Glob, the command below does the same, through Bash, one command per
call:

- Search the checkout: `git grep --untracked -nE -e '<pattern>' -- '<path>'`.
- Search the base: `git grep -nE -e '<pattern>' <base> -- '<path>'`.
- List files: `find '<path>' -not -path '*/node_modules/*' -not -path '*/.git/*' -name '<glob>' -print`, with no
  other `find` action and no redirect.

How to write them:

- `-e` keeps a pattern that starts with `-` from reading as an option.
- A path goes in single quotes, as Claude Code refuses an unquoted glob.
- A pattern holds no `$` or backtick, not even as an end-of-line anchor or inside `[...]`, as Claude Code refuses
  those even in single quotes: match either character with `.`.
- Patterns are POSIX extended regular expressions.

Like Grep, `git grep` skips the files git ignores. Its exit 1 with no output means no match, not a failure. Leave no
search undone for the missing tool.
