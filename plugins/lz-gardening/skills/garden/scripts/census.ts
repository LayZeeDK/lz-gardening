#!/usr/bin/env node
// Counts weed markers in the tracked files of one git revision and reports what changed since the last census.
// It reads the revision with `git grep`, so it never checks anything out and works in a clone with no working tree.
// Usage:
//   node census.ts --rev <rev> [--out <census.json>] [--patterns <extra.json>]
//     Prints a table of counts with the change since the previous census at --out, then the new hits, then one
//     JSON summary line. Writes the new census to --out. Exit 0 on success, 2 on a usage or git error.
// Patterns: patterns.json beside this script, extended or overridden (same id) by --patterns.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Pattern {
  readonly id: string;
  readonly regex: string;
  readonly paths: readonly string[];
  readonly note: string;
}

export interface PatternSet {
  readonly exclude: readonly string[];
  readonly patterns: readonly Pattern[];
}

export interface Census {
  readonly rev: string;
  readonly sha: string;
  readonly takenAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly hits: Readonly<Record<string, readonly string[]>>;
  readonly duplicates: Readonly<Record<string, readonly string[]>>;
}

export interface PatternDelta {
  readonly id: string;
  readonly before: number | null;
  readonly after: number;
  readonly added: readonly string[];
}

// Hits are capped per pattern; counts stay exact, and a delta over a capped list can miss new hits.
const hitCap = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${what} must be an array of strings`);
  }

  return value;
}

export function parsePatternSet(json: unknown, source: string): PatternSet {
  if (!isRecord(json)) {
    throw new Error(`${source}: expected an object with "patterns"`);
  }

  const patterns = json['patterns'] ?? [];

  if (!Array.isArray(patterns)) {
    throw new Error(`${source}: "patterns" must be an array`);
  }

  return {
    exclude: stringArray(json['exclude'], `${source}: "exclude"`),
    patterns: patterns.map((entry: unknown, index): Pattern => {
      if (!isRecord(entry)) {
        throw new Error(`${source}: patterns[${String(index)}] must be an object`);
      }

      const { id, regex, note } = entry;

      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        throw new Error(`${source}: patterns[${String(index)}].id must be a kebab-case string`);
      }

      if (typeof regex !== 'string' || regex === '') {
        throw new Error(`${source}: pattern ${id} needs a non-empty "regex"`);
      }

      return {
        id,
        regex,
        paths: stringArray(entry['paths'], `${source}: pattern ${id} "paths"`),
        note: typeof note === 'string' ? note : '',
      };
    }),
  };
}

export function mergePatternSets(base: PatternSet, extra: PatternSet | null): PatternSet {
  if (extra === null) {
    return base;
  }

  const byId = new Map(base.patterns.map((pattern) => [pattern.id, pattern]));

  for (const pattern of extra.patterns) {
    byId.set(pattern.id, pattern);
  }

  return { exclude: [...new Set([...base.exclude, ...extra.exclude])], patterns: [...byId.values()] };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 2,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function pathspecs(paths: readonly string[], exclude: readonly string[]): string[] {
  const include = paths.length > 0 ? paths.map((glob) => `:(glob)${glob}`) : ['.'];

  return [...include, ...exclude.map((glob) => `:(exclude,glob)${glob}`)];
}

/** One hit as `path:line: text`; the delta compares hits by path and text, so moved lines are not new. */
export function parseGrep(stdout: string, sha: string): string[] {
  const prefix = `${sha}:`;

  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .flatMap((line) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(line);

      if (match === null) {
        return [];
      }

      const [, path = '', lineNo = '', text = ''] = match;

      return [`${path}:${lineNo}: ${text.trim()}`];
    });
}

function splitHit(hit: string): { readonly path: string; readonly text: string } | null {
  const match = /^(.*?):\d+: (.*)$/.exec(hit);

  return match === null ? null : { path: match[1] ?? '', text: match[2] ?? '' };
}

export function hitKey(hit: string): string {
  const parts = splitHit(hit);

  return parts === null ? hit : `${parts.path}\u0000${parts.text}`;
}

async function grepRevision(
  cwd: string,
  sha: string,
  regex: string,
  specs: readonly string[],
  what: string,
): Promise<string[]> {
  const grep = await run(['grep', '-n', '-I', '-E', '-e', regex, sha, '--', ...specs], cwd);

  // git grep exits 1 when nothing matches; anything else above 0 is an error.
  if (grep.code > 1) {
    throw new Error(`git grep for ${what}: ${grep.stderr.trim()}`);
  }

  return parseGrep(grep.stdout, sha);
}

export async function takeCensus(cwd: string, rev: string, set: PatternSet, now: Date): Promise<Census> {
  const parsed = await run(['rev-parse', '--verify', `${rev}^{commit}`], cwd);

  if (parsed.code !== 0) {
    throw new Error(`git rev-parse ${rev}: ${parsed.stderr.trim()}`);
  }

  const sha = parsed.stdout.trim();
  const results = await Promise.all(
    set.patterns.map(
      async (pattern) =>
        [
          pattern.id,
          await grepRevision(cwd, sha, pattern.regex, pathspecs(pattern.paths, set.exclude), pattern.id),
        ] as const,
    ),
  );

  return {
    rev,
    sha,
    takenAt: now.toISOString(),
    counts: Object.fromEntries(results.map(([id, hits]) => [id, hits.length])),
    hits: Object.fromEntries(results.map(([id, hits]) => [id, hits.slice(0, hitCap)])),
    duplicates: await findDuplicates(cwd, sha, set.exclude),
  };
}

const sourceGlobs = ['ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((extension) => `**/*.${extension}`);
// A const holding a parenthesised expression (`const x = (a + b)`) also counts; a parser would not.
const definition =
  /^\s*(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function[\s(]|[A-Za-z_$][\w$]*\s*=>))/;
// git grep takes POSIX extended regex, which has no \s or (?:), so it prefilters and `definition` names the match.
const definitionPrefilter =
  '^[[:space:]]*(export[[:space:]]+)?((async[[:space:]]+)?function[[:space:]]+[A-Za-z_$]|const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=)';

/** Top-level function names defined in two or more files, each with its sorted file list. */
async function findDuplicates(cwd: string, sha: string, exclude: readonly string[]): Promise<Record<string, string[]>> {
  const specs = pathspecs(sourceGlobs, [...exclude, '**/*.spec.*', '**/*.test.*']);
  const hits = await grepRevision(cwd, sha, definitionPrefilter, specs, 'definitions');
  const definitions = hits.flatMap((hit) => {
    const parts = splitHit(hit);
    const match = definition.exec(parts?.text ?? '');
    const name = match?.[1] ?? match?.[2];

    return parts === null || name === undefined ? [] : [{ name, path: parts.path }];
  });
  const byName = Map.groupBy(definitions, (item) => item.name);

  return Object.fromEntries(
    [...byName.entries()]
      .map(([name, items]) => [name, [...new Set(items.map((item) => item.path))].sort()] as const)
      .filter(([, paths]) => paths.length > 1)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function parseCensus(json: unknown): Census | null {
  if (!isRecord(json) || !isRecord(json['counts']) || !isRecord(json['hits'])) {
    return null;
  }

  const { rev, sha, takenAt } = json;

  if (typeof rev !== 'string' || typeof sha !== 'string' || typeof takenAt !== 'string') {
    return null;
  }

  const counts: Record<string, number> = {};

  for (const [id, count] of Object.entries(json['counts'])) {
    if (typeof count === 'number') {
      counts[id] = count;
    }
  }

  return {
    rev,
    sha,
    takenAt,
    counts,
    hits: stringLists(json['hits']),
    duplicates: stringLists(json['duplicates']),
  };
}

function stringLists(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, list]) =>
      Array.isArray(list) ? [[key, list.filter((item): item is string => typeof item === 'string')] as const] : [],
    ),
  );
}

export function diffDuplicates(before: Census | null, after: Census): string[] {
  if (before === null) {
    return [];
  }

  return Object.entries(after.duplicates)
    .filter(([name, paths]) => paths.some((path) => !(before.duplicates[name] ?? []).includes(path)))
    .map(([name]) => name);
}

export function diffCensus(before: Census | null, after: Census): PatternDelta[] {
  return Object.keys(after.counts).map((id) => {
    const previous = before?.hits[id];
    const seen = new Map<string, number>();

    for (const hit of previous ?? []) {
      const key = hitKey(hit);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const added = (after.hits[id] ?? []).filter((hit) => {
      const key = hitKey(hit);
      const left = seen.get(key) ?? 0;

      if (left > 0) {
        seen.set(key, left - 1);

        return false;
      }

      return true;
    });

    return {
      id,
      before: before?.counts[id] ?? null,
      after: after.counts[id] ?? 0,
      added: previous === undefined ? [] : added,
    };
  });
}

function formatDelta(deltas: readonly PatternDelta[]): string {
  const rows = deltas.map((delta) => {
    const change = delta.before === null ? 'new' : String(delta.after - delta.before).replace(/^(?=\d)/, '+');

    return `${delta.id.padEnd(30)} ${String(delta.after).padStart(6)}  ${change}`;
  });
  const added = deltas.flatMap((delta) => delta.added.map((hit) => `+ [${delta.id}] ${hit}`));

  return [`${'pattern'.padEnd(30)} ${'count'.padStart(6)}  change`, ...rows, '', ...added].join('\n');
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: readonly string[]): Promise<number> {
  const rev = argValue(argv, '--rev');

  if (rev === undefined) {
    process.stderr.write('usage: census.ts --rev <rev> [--out <census.json>] [--patterns <extra.json>]\n');

    return 2;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const extraPath = argValue(argv, '--patterns');
  const extra =
    extraPath !== undefined && existsSync(extraPath) ? parsePatternSet(readJson(extraPath), extraPath) : null;
  const set = mergePatternSets(parsePatternSet(readJson(join(here, 'patterns.json')), 'patterns.json'), extra);
  const out = argValue(argv, '--out');
  const before = out !== undefined && existsSync(out) ? parseCensus(readJson(out)) : null;
  const after = await takeCensus(process.cwd(), rev, set, new Date());
  const deltas = diffCensus(before, after);

  if (out !== undefined) {
    writeFileSync(out, `${JSON.stringify(after, null, 2)}\n`);
  }

  const grew = deltas.filter((delta) => delta.before !== null && delta.after > delta.before).map((delta) => delta.id);
  const newDuplicates = diffDuplicates(before, after);
  const duplicateLines = newDuplicates.map(
    (name) => `+ duplicate ${name}: ${(after.duplicates[name] ?? []).join(', ')}`,
  );
  const summary = {
    sha: after.sha,
    previousSha: before?.sha ?? null,
    grew,
    newHits: deltas.reduce((sum, delta) => sum + delta.added.length, 0),
    newDuplicates,
  };
  process.stdout.write(`${[formatDelta(deltas), ...duplicateLines].join('\n')}\n${JSON.stringify(summary)}\n`);

  return 0;
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
if (
  process.argv[1] &&
  realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`census: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
