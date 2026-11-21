# Keeping the glossary and the ADRs current

`GLOSSARY.md` holds the plugin's words, and `docs/adr/` holds the decisions a later reader would otherwise undo. Both
go stale silently: nothing fails when code and words drift apart. This page says when each one changes and how.

## The glossary

### When to change it

Change `GLOSSARY.md` in the same commit as a change that:

- adds a word a user or an agent reads: a status, a close kind, a label, a place, a step of a pass;
- gives a defined word a new meaning, or stops using one;
- uses two words for one thing: keep the better one and list the other under `_Avoid_`;
- uses one word for two things: give each its own word, or narrow one use. Example: "one-off" named both a class
  with one open weed and weeds judged an isolated occurrence; the class now "waits for a second", and **One-off**
  keeps the second meaning, which a one-off close records.

Leave out flags, file formats, commands and general programming terms. The skills' docs and the CHANGELOG say how
the plugin behaves; the glossary says what its words mean.

### How

- Put each term under the heading it belongs to (Weeds, Watching, Tending, Places).
- Write `**Term**:`, then one or two sentences that say what it is, not what code does with it.
- Add `_Avoid_:` with the words it replaces, and a reason in parentheses when the avoided word means something else
  here: `_Avoid_: baseline (a baseline is what a check tolerates)`.
- Wrap at 120 characters, as the rest of the repository's Markdown does.
- After a change, search the shipped files for the avoided words, as whole words, and reword any hit that means the
  defined term. Search with `rg -n -i -w -e '<word>|<word>' plugins README.md AGENTS.md`.

## The ADRs

### When to write one

Write an ADR only when a decision passes all three tests:

1. **Hard to reverse.** Changing it later costs something real: a stored format, a printed status other tools read, a
   branch layout people fetch.
2. **Surprising without context.** A reader of the code would ask why, and might "fix" it.
3. **A real trade-off.** There were other options, and they lost for reasons someone stated.

A decision that fails one test gets no ADR. If a commit body or a skill's doc already gives its reason, that is
enough. Examples: the garden site runs no user hooks (explained in the site's reference), and a bed links
`node_modules` only from a matching plain lockfile.

Check the ADRs whenever a change touches what one covers. When the change reverses part of it, add a dated
`## Update, <YYYY-MM-DD>: <what changed>` section to that ADR, as ADR 0001 does. When it reverses all of it, write a
new ADR and give the old one front matter with `status: superseded by ADR-<NNNN>`.

### How

- Name the file `docs/adr/<NNNN>-<slug>.md`, with the next free number.
- Make the title the decision, as a sentence.
- Open with one to three sentences: the situation, the decision, and why.
- Add `## Considered Options` only for rejected options a reader would suggest again, each with why it lost. Add
  `## Consequences` only for effects a reader would not expect.
- Take every reason and rejected option from a record: a commit body, a measured spike, a review triage. Never invent
  an alternative to make the record look complete; when none was written down, leave the section out.
- Write for a reader outside the project: no planning IDs, no review round numbers, no session names.
