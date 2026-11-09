#!/usr/bin/env node
// The weeds queue: an append-only JSONL log of weeds, one event per line. Rows are never edited; a close is a new
// row. The same class, place and source is one weed, so a loop that finds it again adds nothing.
// Usage (--file defaults to .garden/weeds.jsonl, and any other path must also end in .garden/weeds.jsonl):
//   node weeds.ts add --class <kebab> --where <path[:line]> --source <kind:ref> --note <text> [--layer <1-6>]
//     Prints `added <id>`, `seen <id>` (already open), `kept <id>` (closed with --keep: a weed left on purpose is
//     never queued again) or `regrown <id> after bed/<class>@<commit> (check: <where>)` (a tend pass closed its
//     class, so the check that was meant to hold it did not; the latest tend pass is named).
//   node weeds.ts close --id <id> <kind of close>
//   node weeds.ts close-class --class <kebab> <kind of close>
//     The kind of close is exactly one of: --tended bed/<class>@<commit> --check <where the check lives> (a tend
//     pass added a check; close-class only), --one-off <reason> (no check written), --keep <reason> (the weed is
//     deliberate). Values are one line of text without control characters.
//   node weeds.ts groups [--min <n>]     open weeds per class, most first; --min defaults to 1
//   node weeds.ts list [--class <kebab>] open weeds, one per line; a regrown weed shows the bed and check
// Exit 0 on success, 1 when a close finds nothing open, 2 on a usage error or a malformed queue.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isRecord } from './census.ts';

export interface AddRow {
  readonly op: 'add';
  readonly id: string;
  readonly at: string;
  readonly class: string;
  readonly where: string;
  readonly source: string;
  readonly note: string;
  readonly layer: number | null;
}

export type CloseKind = 'tended' | 'one-off' | 'kept';

export interface CloseRow {
  readonly op: 'close';
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly kind: CloseKind;
  readonly check: string | null;
}

export type Row = AddRow | CloseRow;

export interface Weed extends AddRow {
  readonly regrownAfter: CloseRow | null;
}

export interface Group {
  readonly class: string;
  readonly open: number;
  readonly places: number;
  readonly regrown: number;
  readonly firstAt: string;
  readonly layer: number | null;
}

export const classPattern = /^[a-z0-9][a-z0-9-]*$/;
const sourcePattern = /^[a-z][a-z-]*:\S/;
// The skills allow this script with any arguments, so it writes nowhere but a garden queue.
const queuePattern = /[\\/]\.garden[\\/]weeds\.jsonl$/;

// list and the add status print flag values raw, so a value that breaks or hides a line is refused.
const unprintablePattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function firstUnprintable(values: Readonly<Record<string, string | undefined>>): string | null {
  const flag = Object.entries(values).find(([, value]) => unprintablePattern.test(value ?? ''))?.[0];

  return flag === undefined ? null : `--${flag} must be one line of text without control characters`;
}

// The bed a tend close names: bed/<class>@<commit>.
const bedPattern = /^bed\/([a-z0-9][a-z0-9-]*)@[0-9a-f]{4,40}$/;

// A close row written before close kinds existed: a tend pass wrote its bed as `by`.
function kindBefore(by: string, keep: boolean): CloseKind {
  if (keep) {
    return 'kept';
  }

  return bedPattern.test(by) ? 'tended' : 'one-off';
}

export function weedId(weedClass: string, where: string, source: string): string {
  return createHash('sha256').update(`${weedClass}\u0000${where}\u0000${source}`).digest('hex').slice(0, 10);
}

export function parseRow(line: string, lineNo: number): Row {
  const fail = (why: string): never => {
    throw new Error(`queue line ${String(lineNo)}: ${why}`);
  };
  let json: unknown;

  try {
    json = JSON.parse(line);
  } catch {
    return fail('not JSON');
  }

  if (!isRecord(json)) {
    return fail('not an object');
  }

  const { op, id, at } = json;

  if (typeof id !== 'string' || typeof at !== 'string') {
    return fail('missing id or at');
  }

  if (op === 'close') {
    const { by, kind, check } = json;

    if (typeof by !== 'string') {
      return fail('close without by');
    }

    if (kind === undefined) {
      return { op, id, at, by, kind: kindBefore(by, json['keep'] === true), check: null };
    }

    if (kind !== 'tended' && kind !== 'one-off' && kind !== 'kept') {
      return fail(`unknown close kind ${JSON.stringify(kind)}`);
    }

    return { op, id, at, by, kind, check: typeof check === 'string' ? check : null };
  }

  if (op !== 'add') {
    return fail(`unknown op ${JSON.stringify(op)}`);
  }

  const { where, source, note, layer } = json;
  const weedClass = json['class'];

  if (typeof weedClass !== 'string' || typeof where !== 'string' || typeof source !== 'string') {
    return fail('add without class, where or source');
  }

  return {
    op,
    id,
    at,
    class: weedClass,
    where,
    source,
    note: typeof note === 'string' ? note : '',
    layer: typeof layer === 'number' ? layer : null,
  };
}

export function readQueue(file: string): Row[] {
  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => (line.trim() === '' ? [] : [parseRow(line, index + 1)]));
}

/** Replays the log: the open weeds, each with the latest tend close of its class before it, if any. */
export function openWeeds(rows: readonly Row[]): Weed[] {
  const open = new Map<string, Weed>();
  const classOf = new Map<string, string>();
  const lastTended = new Map<string, CloseRow>();

  for (const row of rows) {
    if (row.op === 'close') {
      open.delete(row.id);
      const weedClass = classOf.get(row.id);

      if (row.kind === 'tended' && weedClass !== undefined) {
        lastTended.set(weedClass, row);
      }

      continue;
    }

    classOf.set(row.id, row.class);

    if (!open.has(row.id)) {
      open.set(row.id, { ...row, regrownAfter: lastTended.get(row.class) ?? null });
    }
  }

  return [...open.values()];
}

export function groupWeeds(weeds: readonly Weed[]): Group[] {
  const byClass = new Map<string, Weed[]>();

  for (const weed of weeds) {
    byClass.set(weed.class, [...(byClass.get(weed.class) ?? []), weed]);
  }

  return [...byClass.entries()]
    .map(([weedClass, members]): Group => {
      const times = members.map((weed) => weed.at).sort();
      const layers = members.flatMap((weed) => (weed.layer === null ? [] : [weed.layer]));

      return {
        class: weedClass,
        open: members.length,
        places: new Set(members.map((weed) => weed.where.replace(/:\d+$/, ''))).size,
        regrown: members.filter((weed) => weed.regrownAfter !== null).length,
        // Stryker disable next-line StringLiteral: a group always has a member, so times[0] is never missing
        firstAt: times[0] ?? '',
        layer: layers.length === 0 ? null : Math.min(...layers),
      };
    })
    .sort((a, b) => b.open - a.open || b.regrown - a.regrown || a.class.localeCompare(b.class));
}

export interface AddInput {
  readonly class: string;
  readonly where: string;
  readonly source: string;
  readonly note: string;
  readonly layer: number | null;
}

export function validateAdd(input: AddInput): string | null {
  if (!classPattern.test(input.class)) {
    return '--class must be kebab-case';
  }

  if (input.where.trim() === '') {
    return '--where must not be empty';
  }

  const unprintable = firstUnprintable({ where: input.where, source: input.source, note: input.note });

  if (unprintable !== null) {
    return unprintable;
  }

  if (!sourcePattern.test(input.source)) {
    return '--source must look like <kind>:<ref>, for example commit:1a2b3c4 or census:eslint-disable';
  }

  if (input.layer !== null && !(Number.isInteger(input.layer) && input.layer >= 1 && input.layer <= 6)) {
    return '--layer must be an integer from 1 to 6';
  }

  return null;
}

export interface CloseFlags {
  readonly id?: string | undefined;
  readonly class?: string | undefined;
  readonly tended?: string | undefined;
  readonly 'one-off'?: string | undefined;
  readonly keep?: string | undefined;
  readonly check?: string | undefined;
}

export interface CloseRequest {
  readonly target: string;
  readonly kind: CloseKind;
  readonly by: string;
  readonly check: string | null;
}

/** The close a command's flags ask for, or what is wrong with them. */
export function parseClose(command: 'close' | 'close-class', flags: CloseFlags): CloseRequest | string {
  const kinds = (
    [
      ['tended', flags.tended],
      ['one-off', flags['one-off']],
      ['kept', flags.keep],
    ] as const
  ).flatMap(([kind, by]) => (by === undefined ? [] : [{ kind, by }]));
  const chosen = kinds.length === 1 ? kinds[0] : undefined;
  const target = command === 'close' ? flags.id : flags.class;

  if (chosen === undefined || chosen.by.trim() === '' || target === undefined) {
    return `needs ${command === 'close' ? '--id' : '--class'} and exactly one of --tended, --one-off or --keep`;
  }

  const unprintable = firstUnprintable({
    tended: flags.tended,
    'one-off': flags['one-off'],
    keep: flags.keep,
    check: flags.check,
  });

  if (unprintable !== null) {
    return unprintable;
  }

  const { kind, by } = chosen;
  const { check } = flags;

  if (kind !== 'tended') {
    return check === undefined ? { target, kind, by, check: null } : '--check goes with --tended only';
  }

  if (command === 'close') {
    return '--tended closes a whole class; use close-class --class <class>';
  }

  if (check === undefined || check.trim() === '') {
    return '--tended needs --check <where the check lives>';
  }

  return bedPattern.exec(by)?.[1] === target
    ? { target, kind, by, check }
    : `--tended must be bed/${target}@<commit>, got ${by}`;
}

function after(tended: CloseRow): string {
  return `after ${tended.by}${tended.check === null ? '' : ` (check: ${tended.check})`}`;
}

export function addWeed(rows: readonly Row[], input: AddInput, now: Date): { status: string; row: AddRow | null } {
  const id = weedId(input.class, input.where, input.source);
  const isOpen = openWeeds(rows).some((weed) => weed.id === id);

  if (isOpen) {
    return { status: `seen ${id}`, row: null };
  }

  if (rows.some((row) => row.op === 'close' && row.kind === 'kept' && row.id === id)) {
    return { status: `kept ${id}`, row: null };
  }

  const row: AddRow = { op: 'add', id, at: now.toISOString(), ...input };
  const tended = openWeeds([...rows, row]).find((weed) => weed.id === id)?.regrownAfter ?? null;

  return { status: tended === null ? `added ${id}` : `regrown ${id} ${after(tended)}`, row };
}

function append(file: string, rows: readonly Row[]): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

function main(argv: readonly string[], now: Date): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      file: { type: 'string', default: '.garden/weeds.jsonl' },
      class: { type: 'string' },
      where: { type: 'string', default: '' },
      // Stryker disable next-line StringLiteral: an add without --source fails validation, and so does the mutant's text
      source: { type: 'string', default: '' },
      note: { type: 'string', default: '' },
      layer: { type: 'string' },
      id: { type: 'string' },
      tended: { type: 'string' },
      'one-off': { type: 'string' },
      keep: { type: 'string' },
      check: { type: 'string' },
      min: { type: 'string', default: '1' },
    },
  });
  const command = positionals.length === 1 ? positionals[0] : undefined;
  const { file } = values;

  if (!queuePattern.test(resolve(file))) {
    process.stderr.write(`weeds: --file must be a .garden/weeds.jsonl file, got ${file}\n`);

    return 2;
  }

  const rows = readQueue(file);
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  switch (command) {
    case 'add': {
      const input: AddInput = {
        // Stryker disable next-line StringLiteral: an add without --class fails validation, and so does the mutant's text
        class: values.class ?? '',
        where: values.where,
        source: values.source,
        note: values.note,
        layer: values.layer === undefined ? null : Number(values.layer),
      };
      const problem = validateAdd(input);

      if (problem !== null) {
        process.stderr.write(`weeds add: ${problem}\n`);

        return 2;
      }

      const { status, row } = addWeed(rows, input, now);

      if (row !== null) {
        append(file, [row]);
      }

      write(status);

      return 0;
    }
    case 'close':
    case 'close-class': {
      const request = parseClose(command, values);

      if (typeof request === 'string') {
        process.stderr.write(`weeds ${command}: ${request}\n`);

        return 2;
      }

      const { kind, by, check, target } = request;
      const closing = openWeeds(rows).filter((weed) => (command === 'close' ? weed.id : weed.class) === target);

      if (closing.length === 0) {
        process.stderr.write(`weeds ${command}: nothing open for ${target}\n`);

        return 1;
      }

      append(
        file,
        closing.map((weed): CloseRow => ({ op: 'close', id: weed.id, at: now.toISOString(), by, kind, check })),
      );
      write(`${kind === 'kept' ? 'kept' : 'closed'} ${String(closing.length)}`);

      return 0;
    }
    case 'groups': {
      const min = Number(values.min);

      if (!Number.isInteger(min) || min < 1) {
        process.stderr.write(`weeds groups: --min must be a whole number of at least 1, got ${values.min}\n`);

        return 2;
      }

      const groups = groupWeeds(openWeeds(rows)).filter((group) => group.open >= min);
      write(`${'class'.padEnd(36)} open places regrown layer first-seen`);

      for (const group of groups) {
        write(
          `${group.class.padEnd(36)} ${String(group.open).padStart(4)} ${String(group.places).padStart(6)} ${String(group.regrown).padStart(7)} ${String(group.layer ?? '-').padStart(5)} ${group.firstAt.slice(0, 10)}`,
        );
      }

      return 0;
    }
    case 'list': {
      const only = values.class;

      for (const weed of openWeeds(rows).filter((item) => only === undefined || item.class === only)) {
        const regrown = weed.regrownAfter === null ? '' : ` [regrown ${after(weed.regrownAfter)}]`;
        write(`${weed.id} ${weed.class} ${weed.where} [${weed.source}]${regrown} ${weed.note}`);
      }

      return 0;
    }
    default: {
      process.stderr.write('usage: weeds.ts add|close|close-class|groups|list ... (see the header of weeds.ts)\n');

      return 2;
    }
  }
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
if (
  process.argv[1] &&
  realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main(process.argv.slice(2), new Date());
  } catch (error: unknown) {
    process.stderr.write(`weeds: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
