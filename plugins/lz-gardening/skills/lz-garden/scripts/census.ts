#!/usr/bin/env node
// Counts census-pattern hits in the tracked files of one git revision and reports what changed since the last census.
// It reads the revision with `git grep`, so it never checks anything out and works in a clone with no working tree.
// Usage, from the repository's checkout once site.ts open has planted the garden site:
//   node census.ts --rev <rev> [--seed]
//     Prints a table of counts with the change since the site's census (refs/garden/census), then the new hits, then
//     `+ duplicate <name>: new <path>, ...[; already <path>, ...]` per name newly defined in another file, then, with
//     --seed, the seed list (`= ` lines) and `census: <id> <count>, ...` (or `census: none`), then one JSON summary
//     line: sha, previousSha (null when there is no census or this checkout lacks its commit), behind (the census's
//     commit descends from sha), commits (non-merge commits from previousSha to sha, or null), grew, newHits and
//     newDuplicates. When the new census differs from the site's in more than the time taken, it is written to
//     refs/garden/pending/<sha>, named by the commit rev-parse gives, with the patterns it used; site.ts sync
//     --census <sha> records it. A patterns change that changes no count or hit
//     writes nothing: the next census at a new commit carries it.
//     Exit 0 on success, 2 on a usage or git error, no garden site, or a site census that is not a census.
// Patterns: patterns.json beside this script, extended or overridden (same id) by the site's .garden/patterns.json,
// or, when the site has none, by the patterns the site's census carries. A pattern without paths searches sourceGlobs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainModule, processIo } from './cli.ts';
import type { Io } from './cli.ts';
import { isRecord } from './log.ts';
import { gitAsync, gitEnv, inRun, runGitAsync } from './store-git.ts';
import { openSite } from './store-log.ts';
import type { Site } from './store-log.ts';
import { censusRef, readCensusAt, writePendingCensus } from './store-census.ts';
import type { Census, StoredCensus } from './store-census.ts';

type Env = Readonly<NodeJS.ProcessEnv>;

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

export interface PatternDelta {
  readonly id: string;
  readonly before: number | null;
  readonly after: number;
  readonly added: readonly string[];
}

// Hits are capped per pattern; counts stay exact, and a delta over a capped list can miss new hits.
const hitCap = 1000;

// The files duplicate helpers are looked for in, and those a pattern without paths searches.
const sourceGlobs = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map((extension) => `**/*.${extension}`);

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

  // A Map keeps the first place of an id and the last pattern given for it.
  const byId = new Map([...base.patterns, ...extra.patterns].map((pattern) => [pattern.id, pattern]));

  return { exclude: [...new Set([...base.exclude, ...extra.exclude])], patterns: [...byId.values()] };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseNamed(file: { readonly text: string; readonly source: string }): unknown {
  try {
    return JSON.parse(file.text);
  } catch (error: unknown) {
    throw new Error(`${file.source}: ${String(error)}`);
  }
}

function extraPatterns(
  site: string,
  recorded: StoredCensus | null,
): { readonly text: string; readonly source: string } | undefined {
  const siteFile = join(site, '.garden', 'patterns.json');

  if (existsSync(siteFile)) {
    return { text: readFileSync(siteFile, 'utf8'), source: siteFile };
  }

  return recorded?.patterns === undefined
    ? undefined
    : { text: recorded.patterns, source: `${censusRef}:patterns.json` };
}

function branchName(rev: string): string {
  return rev.replace(/^origin\//, '');
}

// env, in every git call below, is the store's git environment for the run (gitEnv), which drops what would point git
// at another repository.
async function hasCommit(cwd: string, env: Env, sha: string): Promise<boolean> {
  return (await runGitAsync(cwd, ['cat-file', '-e', `${sha}^{commit}`], env)).code === 0;
}

function pathspecs(paths: readonly string[], exclude: readonly string[]): string[] {
  return [...paths.map((glob) => `:(glob)${glob}`), ...exclude.map((glob) => `:(exclude,glob)${glob}`)];
}

// A hit's text is cut to this many characters, so a minified or scraped line does not swell the shared census.
const hitTextCap = 200;

function cut(text: string): string {
  if (text.length <= hitTextCap) {
    return text;
  }

  const characters = Array.from(new Intl.Segmenter().segment(text), ({ segment }) => segment);

  return characters.length > hitTextCap ? `${characters.slice(0, hitTextCap).join('')}...` : text;
}

/**
 * One hit as `path:line: text`, its text cut to hitTextCap; the delta compares hits by path and text, so moved lines
 * are not new, and both censuses it compares cut their text here.
 */
export function parseGrep(stdout: string, sha: string): readonly string[] {
  const prefix = `${sha}:`;

  return stdout
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .flatMap((line) => {
      const match = /(.*?):(\d+):(.*)/s.exec(line);

      if (match === null) {
        return [];
      }

      // Stryker disable next-line StringLiteral: a match fills every group, so no default applies
      const [, path = '', lineNo = '', text = ''] = match;

      return [`${path}:${lineNo}: ${cut(text.trim())}`];
    });
}

function splitHit(hit: string): { readonly path: string; readonly text: string } | null {
  const match = /(.*?):\d+: (.*)/s.exec(hit);

  // Stryker disable next-line StringLiteral: a match fills both groups, so no default applies
  return match === null ? null : { path: match[1] ?? '', text: match[2] ?? '' };
}

export function hitKey(hit: string): string {
  const parts = splitHit(hit);

  return parts === null ? hit : `${parts.path}\u0000${parts.text}`;
}

async function grepRevision(
  cwd: string,
  env: Env,
  sha: string,
  regex: string,
  specs: readonly string[],
  what: string,
): Promise<readonly string[]> {
  const grep = await runGitAsync(cwd, ['grep', '-n', '-I', '-E', '-e', regex, sha, '--', ...specs], env);

  // git grep exits 1 when nothing matches; anything else above 0 is an error.
  // Stryker disable next-line LzJsNumericLiteral: git exits 0, 1 or 128 and above, so > 1 and > 2 split them alike
  if (grep.code > 1) {
    throw new Error(`git grep for ${what}: ${grep.stderr.trim()}`);
  }

  return parseGrep(grep.stdout, sha);
}

export async function takeCensus(cwd: string, rev: string, set: PatternSet, now: Date, env: Env): Promise<Census> {
  const sha = await gitAsync(cwd, ['rev-parse', '--verify', `${rev}^{commit}`], env);
  const results = await Promise.all(
    set.patterns.map(
      async (pattern) =>
        [
          pattern.id,
          await grepRevision(
            cwd,
            env,
            sha,
            pattern.regex,
            pathspecs(pattern.paths.length === 0 ? sourceGlobs : pattern.paths, set.exclude),
            pattern.id,
          ),
        ] as const,
    ),
  );

  return {
    rev: branchName(rev),
    sha,
    takenAt: now.toISOString(),
    counts: Object.fromEntries(results.map(([id, hits]) => [id, hits.length])),
    hits: Object.fromEntries(results.map(([id, hits]) => [id, hits.slice(0, hitCap)])),
    duplicates: await findDuplicates(cwd, env, sha, set.exclude),
  };
}

// A const holding a parenthesised expression (`const x = (a + b)`) also counts; a parser would not.
const definition =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function[\s(]|[A-Za-z_$][\w$]*\s*=>))/;
// git grep takes POSIX extended regex, which has no \s or (?:), so it prefilters and `definition` names the match.
const definitionPrefilter =
  // Stryker disable next-line StringLiteral: the prefilter only narrows what git returns, and the definition regex decides every match; they differ only on non-ASCII whitespace such as a no-break space, which no rule depends on
  '^[[:space:]]*(export[[:space:]]+)?((async[[:space:]]+)?function[[:space:]]+[A-Za-z_$]|const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=)';

const dotDirectories = '**/.*/**';

interface Definition {
  readonly name: string;
  readonly path: string;
}

/** Every top-level function definition in the source files of a commit. */
async function definitionsAt(
  cwd: string,
  env: Env,
  sha: string,
  exclude: readonly string[],
): Promise<readonly Definition[]> {
  const specs = pathspecs(sourceGlobs, [...exclude, '**/*.spec.*', '**/*.test.*', dotDirectories]);
  const hits = await grepRevision(cwd, env, sha, definitionPrefilter, specs, 'definitions');

  return hits.flatMap((hit) => {
    const parts = splitHit(hit);
    // Stryker disable next-line StringLiteral: every hit has the path:line: text shape, and neither default is a definition
    const match = definition.exec(parts?.text ?? '');
    const name = match?.[1] ?? match?.[2];

    return parts === null || name === undefined ? [] : [{ name, path: parts.path }];
  });
}

/** Top-level function names defined in two or more files, each with its sorted file list. */
async function findDuplicates(
  cwd: string,
  env: Env,
  sha: string,
  exclude: readonly string[],
): Promise<Readonly<Record<string, readonly string[]>>> {
  const byName = Map.groupBy(await definitionsAt(cwd, env, sha, exclude), (item) => item.name);

  return Object.fromEntries(
    [...byName.entries()]
      .map(([name, items]) => [name, [...new Set(items.map((item) => item.path))].sort()] as const)
      .filter(([, paths]) => paths.length > 1)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function diffDuplicates(before: Census | null, after: Census): readonly string[] {
  if (before === null) {
    return [];
  }

  return Object.entries(after.duplicates)
    .filter(([name, paths]) => paths.some((path) => before.duplicates[name]?.includes(path) !== true))
    .map(([name]) => name);
}

/**
 * One `+ duplicate` line per new duplicate: its files that define the name since the previous census apart from
 * those that did before, by the previous census or, for a name it did not list, by the definitions at its commit.
 */
function duplicateLines(
  before: Census | null,
  after: Census,
  newDuplicates: readonly string[],
  earlier: readonly Definition[],
): readonly string[] {
  return Object.entries(after.duplicates)
    .filter(([name]) => newDuplicates.includes(name))
    .map(([name, paths]) => {
      const already = paths.filter(
        (path) =>
          before?.duplicates[name]?.includes(path) === true ||
          earlier.some((item) => item.name === name && item.path === path),
      );
      const added = paths.filter((path) => !already.includes(path));

      return `+ duplicate ${name}: new ${added.join(', ')}${already.length === 0 ? '' : `; already ${already.join(', ')}`}`;
    });
}

export function diffCensus(before: Census | null, after: Census): readonly PatternDelta[] {
  return Object.entries(after.counts).map(([id, count]) => {
    const previous = before?.hits[id];
    const seen = new Map<string, number>();

    // Stryker disable next-line ArrayDeclaration: with no previous hits, added is replaced by [] below
    for (const hit of previous ?? []) {
      const key = hitKey(hit);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const added = (after.hits[id] ?? []).filter((hit) => {
      const key = hitKey(hit);
      // Stryker disable next-line LzJsNumericLiteral: an unseen key fails left > 0 at -1 as at 0
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
      after: count,
      added: previous === undefined ? [] : added,
    };
  });
}

const seedFilesPerPattern = 20;
const seedDuplicateNames = 30;

function seedList(census: Census): string[] {
  const files = Object.entries(census.hits).flatMap(([id, hits]) =>
    [...Map.groupBy(hits, (hit) => splitHit(hit)?.path ?? hit)]
      .map(([path, items]) => ({ path, count: items.length }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, seedFilesPerPattern)
      .map(({ path, count }) => `= [${id}] ${path} ${String(count)}`),
  );
  const duplicates = Object.entries(census.duplicates).sort(
    ([a, aPaths], [b, bPaths]) => bPaths.length - aPaths.length || a.localeCompare(b),
  );
  const listed = duplicates
    .slice(0, seedDuplicateNames)
    .map(([name, paths]) => `= duplicate ${name}: ${paths.join(', ')}`);
  const rest = duplicates.length - listed.length;
  const counted = Object.entries(census.counts)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id} ${String(count)}`);

  return [
    ...files,
    ...listed,
    ...(rest > 0 ? [`${String(rest)} more duplicate names not listed`] : []),
    `census: ${counted.length === 0 ? 'none' : counted.join(', ')}`,
  ];
}

function formatDelta(deltas: readonly PatternDelta[]): string {
  const rows = deltas.map((delta) => {
    const change = delta.before === null ? 'new' : String(delta.after - delta.before).replace(/^(?=\d)/, '+');

    return `${delta.id.padEnd(30)} ${String(delta.after).padStart(6)}  ${change}`;
  });
  const added = deltas.flatMap((delta) => delta.added.map((hit) => `+ [${delta.id}] ${hit}`));

  return [`${'pattern'.padEnd(30)} ${'count'.padStart(6)}  change`, ...rows, '', ...added].join('\n');
}

function readSite(cwd: string): {
  readonly site: Site;
  readonly recorded: StoredCensus | null;
  readonly extraFile: { readonly text: string; readonly source: string } | undefined;
} {
  const site = openSite(cwd);
  const recorded = readCensusAt(site.path, censusRef);

  if (recorded === 'not a census') {
    throw new Error(
      `${censusRef} in ${site.path} is not a census; delete it (git -C "${site.path}" update-ref -d ${censusRef}), and the next tick records a new one`,
    );
  }

  return { site, recorded, extraFile: extraPatterns(site.path, recorded) };
}

async function main(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      rev: { type: 'string' },
      seed: { type: 'boolean', default: false },
    },
  });
  const { rev } = values;

  if (rev === undefined) {
    io.err('usage: census.ts --rev <rev> [--seed]\n');

    return 2;
  }

  const { site, recorded, extraFile, env } = inRun(io.env, () => ({ ...readSite(io.cwd), env: gitEnv(io.cwd) }));
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'patterns.json');
  const before = recorded?.census ?? null;
  const extra = extraFile === undefined ? null : parsePatternSet(parseNamed(extraFile), extraFile.source);
  // Stryker disable next-line StringLiteral: the bundled patterns.json is valid, so its name appears in no message
  const set = mergePatternSets(parsePatternSet(readJson(bundled), 'patterns.json'), extra);
  const after = await takeCensus(io.cwd, rev, set, new Date(), env);
  const deltas = diffCensus(before, after);
  const serialize = (census: Census): string => `${JSON.stringify(census, null, 2)}\n`;
  const changed = recorded === null || serialize({ ...after, takenAt: recorded.census.takenAt }) !== recorded.text;

  if (changed) {
    inRun(io.env, () => {
      writePendingCensus(site, after.sha, serialize(after), extraFile?.text);
    });
  }

  const previousSha = before !== null && (await hasCommit(io.cwd, env, before.sha)) ? before.sha : null;

  const grew = deltas.filter((delta) => delta.before !== null && delta.after > delta.before).map((delta) => delta.id);
  const newDuplicates = diffDuplicates(before, after);
  // A name that was defined in one file only had no entry in the previous census, so that file is found at its commit.
  const earlier =
    previousSha === null || newDuplicates.length === 0
      ? []
      : await definitionsAt(io.cwd, env, previousSha, set.exclude);
  const summary = {
    sha: after.sha,
    previousSha,
    behind:
      previousSha !== null &&
      previousSha !== after.sha &&
      (await runGitAsync(io.cwd, ['merge-base', '--is-ancestor', after.sha, previousSha], env)).code === 0,
    commits:
      previousSha === null
        ? null
        : Number(await gitAsync(io.cwd, ['rev-list', '--no-merges', '--count', `${previousSha}..${after.sha}`], env)),
    grew,
    newHits: deltas.reduce((sum, delta) => sum + delta.added.length, 0),
    newDuplicates,
  };
  const seed = values.seed ? seedList(after) : [];
  io.out(
    `${[formatDelta(deltas), ...duplicateLines(before, after, newDuplicates, earlier), ...seed].join('\n')}\n${JSON.stringify(summary)}\n`,
  );

  return 0;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    return await main(argv, io);
  } catch (error: unknown) {
    io.err(`census: ${error instanceof Error ? error.message : String(error)}\n`);

    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), processIo());
}
