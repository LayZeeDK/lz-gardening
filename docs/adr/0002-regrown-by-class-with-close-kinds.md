# A weed is regrown when a tend pass closed its class, and every close records its kind

A regrown weed shows that the check a tend pass added did not hold its class. Matching a returning weed by class,
place and planting commit did not fire in practice, because a tick never queues the same weed twice. So a weed is
regrown when an earlier close of its class was a tend pass, wherever the weed comes back. It names the latest tend
pass's bed and check. Every close row records its kind: tended (with the bed and the check), one-off, or kept. The
queue then tells a tend pass from a one-off by a field, not by the text of a reason.

## Considered Options

- **An id made from the class and the file.** Merges different weeds in one file into one, and changes every weed's
  id, which is part of the queue format.
- **Look for an earlier close in the same file.** Misses a weed that comes back in another file or a renamed one, and
  calls a weed that comes back after a one-off close regrown, though no check was written to hold it.
- **Keep the narrow match on class, place and planting commit.** The tick's report of regrown weeds, and a tend pass
  that starts from the check that did not hold, would then almost never apply.
- **Tell a tend pass from a one-off by whether the close names a bed.** A convention in free text, not a field.

## Consequences

- A weed queued for the first time after a tend pass of its class reads as regrown: its class came back.
- A one-off close after a tend pass leaves the class tended, because the check the tend pass added still stands.
- Close rows written before kinds existed are read by rule: a keep is kept, a reason that names a bed is tended, and
  anything else is a one-off. They name no check.
- The close kind is stored in every close row, so changing the set of kinds changes the queue format, and existing rows
  then need a read rule of their own.

## Update, 2026-11-12: the queue is events

ADR 0004 keeps the queue as events in the site's `refs/garden/log` instead of rows in one file. The decision stands,
but three consequences above change:

- There are no close rows and no read rule for closes without a kind: a close event must carry its kind, and one
  without it is skipped as malformed. No queue had been released in the row format, so nothing needed the rule.
- A weed is regrown when the add saw a tended close of its class, not by a search of earlier closes at read time
  (ADR 0004).
- A tended close names one or more checks (ADR 0003's update of 2026-11-18).
