#!/usr/bin/env node
// The weeds queue: an append-only JSONL log of findings, one event per line. Rows are never edited; a close is a new
// row. The same class, place and source is one weed, so a loop that finds it again adds nothing.
// Usage (default file .garden/weeds.jsonl, override with --file <path>):
//   node weeds.ts add --class <kebab> --where <path[:line]> --source <kind:ref> --note <text> [--layer <1-6>]
//     Prints `added <id>`, `seen <id>` (already open), `regrown <id>` (it was closed and came back) or `kept <id>`
//     (it was closed with --keep: a weed left on purpose is never queued again).
//   node weeds.ts close --id <id> --by <commit or reason> [--keep]
//   node weeds.ts close-class --class <kebab> --by <commit or reason> [--keep]
//   node weeds.ts groups [--min <n>]     open weeds per class, most first; --min defaults to 1
//   node weeds.ts list [--class <kebab>] open weeds, one per line
// Exit 0 on success, 1 when a close finds nothing open, 2 on a usage error or a malformed queue.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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

export interface CloseRow {
  readonly op: 'close';
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly keep: boolean;
}

export type Row = AddRow | CloseRow;

export interface Weed extends AddRow {
  readonly regrown: number;
}

export interface Group {
  readonly class: string;
  readonly open: number;
  readonly places: number;
  readonly regrown: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly layer: number | null;
}

const classPattern = /^[a-z0-9][a-z0-9-]*$/;
const sourcePattern = /^[a-z][a-z-]*:\S/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const { by } = json;

    return typeof by === 'string' ? { op, id, at, by, keep: json['keep'] === true } : fail('close without by');
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

/** Replays the log: the open weeds, each with how often it came back after a close. */
export function openWeeds(rows: readonly Row[]): Weed[] {
  const open = new Map<string, Weed>();
  const closedOnce = new Map<string, number>();

  for (const row of rows) {
    if (row.op === 'close') {
      if (open.delete(row.id)) {
        closedOnce.set(row.id, (closedOnce.get(row.id) ?? 0) + 1);
      }

      continue;
    }

    if (!open.has(row.id)) {
      open.set(row.id, { ...row, regrown: closedOnce.get(row.id) ?? 0 });
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
        regrown: members.reduce((sum, weed) => sum + weed.regrown, 0),
        firstAt: times[0] ?? '',
        lastAt: times[times.length - 1] ?? '',
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

  if (!sourcePattern.test(input.source)) {
    return '--source must look like <kind>:<ref>, for example commit:1a2b3c4 or census:eslint-disable';
  }

  if (input.layer !== null && !(Number.isInteger(input.layer) && input.layer >= 1 && input.layer <= 6)) {
    return '--layer must be an integer from 1 to 6';
  }

  return null;
}

export function addWeed(rows: readonly Row[], input: AddInput, now: Date): { status: string; row: AddRow | null } {
  const id = weedId(input.class, input.where, input.source);
  const isOpen = openWeeds(rows).some((weed) => weed.id === id);

  if (isOpen) {
    return { status: `seen ${id}`, row: null };
  }

  if (rows.some((row) => row.op === 'close' && row.keep && row.id === id)) {
    return { status: `kept ${id}`, row: null };
  }

  const known = rows.some((row) => row.id === id);

  return {
    status: `${known ? 'regrown' : 'added'} ${id}`,
    row: { op: 'add', id, at: now.toISOString(), ...input },
  };
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
      where: { type: 'string' },
      source: { type: 'string' },
      note: { type: 'string' },
      layer: { type: 'string' },
      id: { type: 'string' },
      by: { type: 'string' },
      keep: { type: 'boolean', default: false },
      min: { type: 'string', default: '1' },
    },
  });
  const [command] = positionals;
  const { file } = values;
  const rows = readQueue(file);
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  switch (command) {
    case 'add': {
      const input: AddInput = {
        class: values.class ?? '',
        where: values.where ?? '',
        source: values.source ?? '',
        note: values.note ?? '',
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
      const { by } = values;
      const target = command === 'close' ? values.id : values.class;

      if (by === undefined || by.trim() === '' || target === undefined) {
        process.stderr.write(`weeds ${command}: needs ${command === 'close' ? '--id' : '--class'} and --by\n`);

        return 2;
      }

      const closing = openWeeds(rows).filter((weed) => (command === 'close' ? weed.id : weed.class) === target);

      if (closing.length === 0) {
        process.stderr.write(`weeds ${command}: nothing open for ${target}\n`);

        return 1;
      }

      const { keep } = values;
      append(
        file,
        closing.map((weed): CloseRow => ({ op: 'close', id: weed.id, at: now.toISOString(), by, keep })),
      );
      write(`${keep ? 'kept' : 'closed'} ${String(closing.length)}`);

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
        write(`${weed.id} ${weed.class} ${weed.where} [${weed.source}] ${weed.note}`);
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
