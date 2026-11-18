#!/usr/bin/env node
// Counts census-pattern hits in the tracked files of one git revision and reports what changed since the last census.
// It reads the revision with `git grep`, so it never checks anything out and works in a clone with no working tree.
// Usage, from the repository's checkout once site.ts open has planted the garden site:
//   node census.ts --rev <rev> [--seed]
//     Prints `site pattern <id>: <regex>[ in <path>, ...]` per pattern the site adds or overrides, then a table of
//     counts with the change since the site's census (refs/garden/census), then the new hits, then
//     `+ duplicate <name>: new <path>, ...[; already <path>, ...]` per name newly defined in another file, then, with
//     --seed, the seed list (`= ` lines) and `census: <id> <count>, ...` (or `census: none`), then one JSON summary
//     line: sha, previousSha (null when there is no census or this checkout lacks its commit), behind (the census's
//     commit descends from sha), commits (non-merge commits from previousSha to sha, or null), grew, newHits and
//     newDuplicates. When the new census differs from the site's in more than the time taken, it is written to
//     refs/garden/pending/<sha>, named by the commit rev-parse gives, with the site's extra patterns; site.ts sync
//     --census <sha> records it. A patterns change that changes no count or hit
//     writes nothing: the next census at a new commit carries it.
//     Exit 0 on success, 2 on a usage or git error, no garden site, or a site census that is not a census.
// Patterns: patterns.json beside this script, extended or overridden (same id) by the site's .garden/patterns.json,
// or, when the site has none, by the patterns the site's census carries. A pattern without paths searches sourceGlobs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { commandFailed, escapeUnprintable, isMainModule, processIo } from './cli.ts';
import bundledPatterns from './patterns.json' with { type: 'json' };
import type { Io } from './cli.ts';
import { classPattern, firstReason } from './log.ts';
import type { GardenEvent } from './log.ts';
import { gitAsync, gitEnv, inRun, runGitAsync } from './store-git.ts';
import { openSite } from './store-log.ts';
import type { Site } from './store-log.ts';
import { censusRef, pendingCensusRef, readableCensus, readCensusAt, writePendingCensus } from './store-census.ts';
import type { Census, StoredCensus } from './store-census.ts';

// An env in this file is the store's git environment for the run (gitEnv), which drops what would point git at another
// repository.
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

// The files duplicate functions are looked for in, and those a pattern without paths searches.
const sourceGlobs = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map((extension) => `**/*.${extension}`);

function patternSetSchema(source: string): z.ZodType<PatternSet> {
  const entryFault = (
    fault: string,
  ): { readonly error: (issue: { readonly path?: readonly PropertyKey[] | undefined }) => string } => ({
    error: (issue) => `${source}: patterns[${String(issue.path?.[1])}]${fault}`,
  });
  const notStrings = { error: `${source}: "exclude" must be an array of strings` };
  const id = entryFault('.id must be a kebab-case string');
  const regex = entryFault('.regex must be a non-empty string');
  const paths = entryFault('.paths must be an array of strings');

  return z
    .object(
      {
        patterns: z
          .array(z.unknown(), { error: `${source}: "patterns" must be an array` })
          .nullish()
          .transform((patterns) => patterns ?? []),
        exclude: z.array(z.string(notStrings), notStrings).default([]),
      },
      { error: `${source}: expected an object with "patterns"` },
    )
    .pipe(
      z.object({
        exclude: z.array(z.string()),
        patterns: z.array(
          z.object(
            {
              id: z.string(id).regex(classPattern, id),
              regex: z.string(regex).min(1, regex),
              paths: z.array(z.string(paths), paths).default([]),
              note: z.string().catch(''),
            },
            entryFault(' must be an object'),
          ),
        ),
      }),
    );
}

export function parsePatternSet(json: unknown, source: string): PatternSet {
  const parsed = patternSetSchema(source).safeParse(json);

  if (!parsed.success) {
    throw new Error(firstReason(parsed.error));
  }

  return parsed.data;
}

export function mergePatternSets(base: PatternSet, extra: PatternSet | null): PatternSet {
  if (extra === null) {
    return base;
  }

  // A Map keeps the first place of an id and the last pattern given for it.
  const byId = new Map([...base.patterns, ...extra.patterns].map((pattern) => [pattern.id, pattern]));

  return { exclude: [...new Set([...base.exclude, ...extra.exclude])], patterns: [...byId.values()] };
}

interface PatternsFile {
  readonly text: string;
  readonly source: string;
}

function parseNamed(file: PatternsFile): unknown {
  try {
    return JSON.parse(file.text);
  } catch (error: unknown) {
    throw new Error(`${file.source}: ${String(error)}`);
  }
}

function extraPatterns(site: string, recorded: StoredCensus | null): PatternsFile | undefined {
  const siteFile = join(site, '.garden', 'patterns.json');

  if (existsSync(siteFile)) {
    return { text: readFileSync(siteFile, 'utf8'), source: siteFile };
  }

  return recorded?.patterns === undefined ? undefined : { text: recorded.patterns, source: censusPatterns };
}

const censusPatterns = `${censusRef}:patterns.json (a .garden/patterns.json written in the site is read instead)`;

function branchName(rev: string): string {
  return rev.replace(/^origin\//, '');
}

function pathspecs(paths: readonly string[], exclude: readonly string[]): string[] {
  return [...paths.map((glob) => `:(top,glob)${glob}`), ...exclude.map((glob) => `:(top,exclude,glob)${glob}`)];
}

// A hit's text is cut to this many characters, so a minified or scraped line does not swell the shared census.
const hitTextCap = 200;

const characterSegmenter = new Intl.Segmenter();

function cut(text: string): string {
  const characters = Array.from(characterSegmenter.segment(text), ({ segment }) => segment);

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

function hitKey(hit: string): string {
  const parts = splitHit(hit);

  return parts === null ? hit : `${parts.path}\u0000${parts.text}`;
}

/** One commit of the checkout, read without checking it out. */
interface Revision {
  readonly sha: string;
  /** The hits of an extended regex in the files that match specs; what names the search in an error. */
  readonly grep: (regex: string, specs: readonly string[], what: string) => Promise<readonly string[]>;
}

function revisionAt(cwd: string, env: Env, sha: string): Revision {
  return {
    sha,
    grep: async (regex, specs, what) => {
      const grep = await runGitAsync(
        cwd,
        [
          '-c',
          'core.quotePath=false',
          'grep',
          '--no-color',
          '--full-name',
          '-n',
          '-I',
          '-E',
          '-e',
          regex,
          sha,
          '--',
          ...specs,
        ],
        env,
      );

      // git grep exits 1 when nothing matches, and also when it could not read a file, which it reports only on stderr.
      // Stryker disable next-line LzJsNumericLiteral: git exits 0, 1 or 128 and above, so > 1 and > 2 split them alike
      if (grep.code > 1 || /^error: /m.test(grep.stderr)) {
        throw new Error(`git grep for ${what}: ${grep.stderr.trim()}`);
      }

      return parseGrep(grep.stdout, sha);
    },
  };
}

/** The commit as a Revision, or null when the checkout lacks it. */
async function presentRevision(cwd: string, env: Env, sha: string): Promise<Revision | null> {
  const has = (await runGitAsync(cwd, ['cat-file', '-e', `${sha}^{commit}`], env)).code === 0;

  return has ? revisionAt(cwd, env, sha) : null;
}

export async function takeCensus(
  cwd: string,
  rev: string,
  set: PatternSet,
  now: Date,
  env: Env,
  nameInErrors: (id: string) => string,
): Promise<Census> {
  const sha = await gitAsync(cwd, ['rev-parse', '--verify', `${rev}^{commit}`], env);
  const revision = revisionAt(cwd, env, sha);
  const greps = set.patterns.map(
    async (pattern) =>
      [
        pattern.id,
        await revision.grep(
          pattern.regex,
          pathspecs(pattern.paths.length === 0 ? sourceGlobs : pattern.paths, set.exclude),
          nameInErrors(pattern.id),
        ),
      ] as const,
  );
  const found = findDuplicates(revision, set.exclude);
  await Promise.allSettled([...greps, found]);
  const results = await Promise.all(greps);
  const duplicates = await found;

  return {
    rev: branchName(rev),
    sha,
    takenAt: now.toISOString(),
    counts: Object.fromEntries(results.map(([id, hits]) => [id, hits.length])),
    hits: Object.fromEntries(results.map(([id, hits]) => [id, hits.slice(0, hitCap)])),
    duplicates,
  };
}

// A const holding a parenthesised expression (`const x = (a + b)`) also counts; a parser would not.
const definition =
  /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function[\s(]|[A-Za-z_$][\w$]*\s*=>))/;
// git grep takes POSIX extended regex, which has no \s or (?:), so it prefilters and `definition` names the match.
// The prefilter alone keeps the definitions at the start of a line, the module's own: a hit's text is trimmed.
const definitionPrefilter =
  // Stryker disable next-line StringLiteral: past its start, the prefilter only narrows what git returns, and the definition regex decides every match; they differ only on non-ASCII whitespace such as a no-break space, which no rule depends on
  '^(export[[:space:]]+)?((async[[:space:]]+)?function[[:space:]]+[A-Za-z_$]|const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=)';

const dotDirectories = '**/.*/**';

interface Definition {
  readonly name: string;
  readonly path: string;
}

async function definitionsAt(revision: Revision, exclude: readonly string[]): Promise<readonly Definition[]> {
  const specs = pathspecs(sourceGlobs, [...exclude, '**/*.spec.*', '**/*.test.*', '**/*.d.ts', dotDirectories]);
  const hits = await revision.grep(definitionPrefilter, specs, 'definitions');

  return hits.flatMap((hit) => {
    const parts = splitHit(hit);
    // Stryker disable next-line StringLiteral: every hit has the path:line: text shape, and neither default is a definition
    const match = definition.exec(parts?.text ?? '');
    const name = match?.[1] ?? match?.[2];

    return parts === null || name === undefined ? [] : [{ name, path: parts.path }];
  });
}

async function findDuplicates(
  revision: Revision,
  exclude: readonly string[],
): Promise<Readonly<Record<string, readonly string[]>>> {
  const byName = Map.groupBy(await definitionsAt(revision, exclude), (item) => item.name);

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
    .filter(([name, paths]) => paths.some((path) => ownEntry(before.duplicates, name)?.includes(path) !== true))
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
          ownEntry(before?.duplicates, name)?.includes(path) === true ||
          earlier.some((item) => item.name === name && item.path === path),
      );
      const added = paths.filter((path) => !already.includes(path));

      return `+ duplicate ${name}: new ${added.join(', ')}${already.length === 0 ? '' : `; already ${already.join(', ')}`}`;
    });
}

function ownEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function diffCensus(before: Census | null, after: Census): readonly PatternDelta[] {
  return Object.entries(after.counts).map(([id, count]) => {
    const previous = ownEntry(before?.hits, id);
    const seen = new Map<string, number>();

    // Stryker disable next-line ArrayDeclaration: with no previous hits, added is replaced by [] below
    for (const hit of previous ?? []) {
      const key = hitKey(hit);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const added = (ownEntry(after.hits, id) ?? []).filter((hit) => {
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
      before: ownEntry(before?.counts, id) ?? null,
      after: count,
      added: previous === undefined ? [] : added,
    };
  });
}

const seedFilesPerPattern = 20;
const seedDuplicateNames = 30;

/** A line of the seed list: the weeds of `class` it asks a seed pass to queue or decline, in `paths`. */
export interface SeedLine {
  readonly line: string;
  readonly class: string;
  readonly paths: readonly string[];
}

export function seedLines(census: Census): SeedLine[] {
  const files = Object.entries(census.hits).flatMap(([id, hits]) =>
    [...Map.groupBy(hits, (hit) => splitHit(hit)?.path ?? hit)]
      .map(([path, items]) => ({ path, count: items.length }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, seedFilesPerPattern)
      .map(({ path, count }) => ({ line: `= [${id}] ${path} ${String(count)}`, class: id, paths: [path] })),
  );
  const listed = Object.entries(census.duplicates)
    .sort(([a, aPaths], [b, bPaths]) => bPaths.length - aPaths.length || a.localeCompare(b))
    .slice(0, seedDuplicateNames)
    .map(([name, paths]) => ({ line: `= duplicate ${name}: ${paths.join(', ')}`, class: 'duplicate-function', paths }));

  return [...files, ...listed];
}

/** The census taken of `sha` and not yet recorded, else the site's census. */
export function censusIn(site: string, sha: string | undefined): Census | undefined {
  return (
    (sha === undefined ? undefined : readableCensus(site, pendingCensusRef(sha))) ?? readableCensus(site, censusRef)
  );
}

/** The seed list of the census taken of `sha` and not yet recorded, else of the garden's census; none without one. */
export function seedLinesIn(site: string, sha: string | undefined): readonly SeedLine[] {
  const census = censusIn(site, sha);

  return census === undefined ? [] : seedLines(census);
}

/** The path of a weed's `--where`, its `:<line>` dropped: the form a seed line names files in. */
export function seedPath(where: string): string {
  return where.replace(/:\d+$/, '');
}

/** Whether a weed of `weedClass` at `where` (a path, with or without `:<line>`) is one the seed line asks about. */
export function onSeedLine(seed: SeedLine, weedClass: string, where: string): boolean {
  return seed.class === weedClass && seed.paths.includes(seedPath(where));
}

/** Why a weed of `weedClass` at `where` cannot take --source census:seed, or null when a line of `seeds` names it. */
export function offSeedList(seeds: readonly SeedLine[], weedClass: string, where: string): string | null {
  return seeds.some((seed) => onSeedLine(seed, weedClass, where))
    ? null
    : `no line of the seed list is ${weedClass} in ${seedPath(where)}; census:seed is for those lines alone`;
}

/** The seed lines some path of which no add of the line's class covers: not yet queued or declined in full. */
export function seedLinesLeft(seeds: readonly SeedLine[], events: readonly GardenEvent[]): readonly SeedLine[] {
  const adds = events.filter((event) => event.op === 'add');

  return seeds.filter(
    (seed) => !seed.paths.every((path) => adds.some((add) => add.class === seed.class && seedPath(add.where) === path)),
  );
}

function seedList(census: Census): string[] {
  const lines = seedLines(census);
  const rest = Object.keys(census.duplicates).length - seedDuplicateNames;
  const counted = Object.entries(census.counts)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id} ${String(count)}`);

  return [
    ...lines.map((seed) => seed.line),
    ...(rest > 0 ? [`${String(rest)} more duplicate names not listed`] : []),
    `census: ${counted.length === 0 ? 'none' : counted.join(', ')}`,
  ];
}

function formatDelta(deltas: readonly PatternDelta[]): readonly string[] {
  const rows = deltas.map((delta) => {
    const change = delta.before === null ? 'new' : String(delta.after - delta.before).replace(/^(?=\d)/, '+');

    return `${delta.id.padEnd(30)} ${String(delta.after).padStart(6)}  ${change}`;
  });
  const added = deltas.flatMap((delta) => delta.added.map((hit) => `+ [${delta.id}] ${hit}`));

  return [`${'pattern'.padEnd(30)} ${'count'.padStart(6)}  change`, ...rows, '', ...added];
}

function readSite(cwd: string): {
  readonly site: Site;
  readonly recorded: StoredCensus | null;
  readonly extraFile: PatternsFile | undefined;
} {
  const site = openSite(cwd);
  const read = readCensusAt(site.path, censusRef);

  if (read.kind === 'not a census') {
    throw new Error(
      `${censusRef} in ${site.path} is not a census; delete it (git -C "${site.path}" update-ref -d ${censusRef}), and the next tick records a new one`,
    );
  }

  const recorded = read.kind === 'census' ? read : null;

  return { site, recorded, extraFile: extraPatterns(site.path, recorded) };
}

function sitePatternLine({ id, regex, paths }: Pattern): string {
  return `site pattern ${id}: ${regex}${paths.length === 0 ? '' : ` in ${paths.join(', ')}`}`;
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
  const before = recorded?.census ?? null;
  const extra = extraFile === undefined ? null : parsePatternSet(parseNamed(extraFile), extraFile.source);
  // Stryker disable next-line StringLiteral: the bundled patterns.json is valid, so its name appears in no message
  const set = mergePatternSets(parsePatternSet(bundledPatterns, 'patterns.json'), extra);
  const fromExtra = new Set(extra?.patterns.map(({ id }) => id));
  const nameInErrors = (id: string): string =>
    extraFile !== undefined && fromExtra.has(id) ? `${id} from ${extraFile.source}` : id;
  const after = await takeCensus(io.cwd, rev, set, new Date(), env, nameInErrors);
  const deltas = diffCensus(before, after);
  const serialize = (census: Census): string => `${JSON.stringify(census, null, 2)}\n`;
  const changed = recorded === null || serialize({ ...after, takenAt: recorded.census.takenAt }) !== recorded.text;
  // The previous census's commit, when this checkout has it.
  const previous = before === null ? null : await presentRevision(io.cwd, env, before.sha);

  const grew = deltas.filter((delta) => delta.before !== null && delta.after > delta.before).map((delta) => delta.id);
  const newDuplicates = diffDuplicates(before, after);
  // A name that was defined in one file only had no entry in the previous census, so that file is found at its commit.
  const earlier = previous === null || newDuplicates.length === 0 ? [] : await definitionsAt(previous, set.exclude);
  const summary = {
    sha: after.sha,
    previousSha: previous?.sha ?? null,
    behind:
      previous !== null &&
      previous.sha !== after.sha &&
      (await runGitAsync(io.cwd, ['merge-base', '--is-ancestor', after.sha, previous.sha], env)).code === 0,
    commits:
      previous === null
        ? null
        : Number(await gitAsync(io.cwd, ['rev-list', '--no-merges', '--count', `${previous.sha}..${after.sha}`], env)),
    grew,
    newHits: deltas.reduce((sum, delta) => sum + delta.added.length, 0),
    newDuplicates,
  };

  if (changed) {
    inRun(io.env, () => {
      writePendingCensus(site, after.sha, serialize(after), extraFile?.text);
    });
  }

  const seed = values.seed ? seedList(after) : [];
  const capped = Object.entries(after.counts)
    .filter(([, count]) => count > hitCap)
    .map(([id]) => id);
  const lines = [
    ...(extra?.patterns.map(sitePatternLine) ?? []),
    ...formatDelta(deltas),
    ...(capped.length === 0 ? [] : [`hits capped at ${String(hitCap)}: ${capped.join(', ')}`]),
    ...duplicateLines(before, after, newDuplicates, earlier),
    ...seed,
  ];
  io.out(`${lines.map(escapeUnprintable).join('\n')}\n${JSON.stringify(summary)}\n`);

  return 0;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    return await main(argv, io);
  } catch (error: unknown) {
    return commandFailed('census', io, error);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), processIo());
}
