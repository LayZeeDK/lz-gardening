# Untrusted JSON is parsed with Zod schemas whose first issue is the reason

The scripts parse JSON that anyone who can push to `origin` can write: the event files and `garden.json` in
`refs/garden/log`, and `census.json` and the shared `patterns.json` in `refs/garden/census`; and a site's own
`.garden/patterns.json`. Each format is a Zod schema in the script that reads it (`log.ts`, `store-log.ts`,
`store-census.ts`, `census.ts`), so a format's rules read as one declaration, and Zod, pinned exact, is the plugin's
one npm package (ADR 0005 says how it is installed).

A skipped event and a refused pattern set report one reason each: the message of the schema's first issue. So each of
those schemas lists its checks in the order the reasons are reported, and each check carries the plugin's own text,
not Zod's. A census and `garden.json` are only accepted or refused; their callers print a fixed message.

Three parts look like they could be simpler, and each keeps a behaviour:

- The event reader does not hand the whole event to one schema. It checks the envelope (`uuid`, `clock`, `at`), then
  the file name, then the checks every op takes, and only then picks the op's schema. A schema's object refines run
  only once its fields have their types, which keeps a type fault ahead of a rule fault, and an event reports the
  same reason whatever op it names.
- `jsonNumber` (`z.custom`) takes any number JSON reads, where `z.number()` would do. JSON reads `1e400` as
  `Infinity`, which `z.number()` refuses as a type fault; the range check reports it instead.
- The records in a census (`counts`, `hits`, `duplicates`) are parsed as their entries and rebuilt with
  `Object.fromEntries`, where `z.record` would do. `z.record` drops a `"__proto__"` key, and `duplicates` is keyed by
  function name, so a duplicated function named `__proto__` would read as new on every census.

## Considered Options

- **Keep the hand-written parsers.** No package to install. The port is not much shorter (257 lines out, 208 in),
  but each format's rules read as one declaration instead of a run of `typeof` checks, and it has no copy of the
  string-list check, which the hand parsers wrote three times.
- **Zod with its own messages.** Shorter schemas, but the reasons users see on stderr and in a refused pattern set
  would change wording, and each op's `malformed <op>` reason would split into one message per field.

## Consequences

- Every user's plugin install carries Zod, about 6 MB unpacked, with no dependencies of its own.
- The port changed no result and no reason except two pattern-set refusals, which name the entry by its place
  (`patterns[0].regex`, `patterns[0].paths`), because a Zod reason cannot read the entry's id. A differential check
  of the old and new parsers over every one- and two-field corruption of a valid event, census and pattern set found
  no other difference. `garden.json` takes the same rule as before, a positive safe integer `format`.
