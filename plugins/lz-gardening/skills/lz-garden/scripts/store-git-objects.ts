// What an object read asks git and what git answers: the requests and answers of `git cat-file`, a tree object's
// entries, and the walk that lists a commit's files from them.
import { objectIdPattern } from './log-fields.ts';

export interface ObjectHeader {
  readonly oid: string;
  readonly type: string;
  readonly size: number;
}

export type ObjectInfo = { readonly kind: 'missing' } | ({ readonly kind: 'object' } & ObjectHeader);

export type ObjectContents =
  { readonly kind: 'missing' } | ({ readonly kind: 'object'; readonly bytes: Buffer } & ObjectHeader);

// The answers whole in the output, and the byte after the last of them; done when every item has its answer.
export interface Parse<T, TAnswer> {
  readonly done: boolean;
  readonly answers: readonly (readonly [T, TAnswer])[];
  readonly end: number;
}

// Where a read runs: the folder, and the env the read sets on top of the run's.
export interface ReadAt {
  readonly cwd: string;
  readonly overrides: Readonly<NodeJS.ProcessEnv>;
}

// How the object reads of one run reach git. No answer is kept: every call asks git, so a ref another process moved
// reads as moved.
export interface ObjectReads {
  readonly tip: (at: ReadAt, ref: string) => string | undefined;
  readonly ids: (at: ReadAt, names: readonly string[]) => readonly (string | undefined)[];
  readonly contents: <T>(
    at: ReadAt,
    items: readonly T[],
    nameOf: (item: T) => string,
  ) => readonly (readonly [T, ObjectContents])[];
  readonly tree: (at: ReadAt, commit: string) => readonly TreeEntry[];
  readonly close: (cwd?: string) => void;
}

export const readStrategies = ['spawn', 'reader'] as const;

export type ReadStrategy = (typeof readStrategies)[number];

export const readStrategyVariable = '_LZ_GARDENING_INTERNAL_GIT_READS';

export function readStrategyOf(env: Readonly<NodeJS.ProcessEnv>, platform: NodeJS.Platform): ReadStrategy {
  const named = env[readStrategyVariable];
  const chosen = readStrategies.find((strategy) => strategy === named);

  if (chosen !== undefined) {
    return chosen;
  }

  if (named !== undefined && named !== '') {
    throw new Error(`${readStrategyVariable} is ${JSON.stringify(named)}; it takes ${readStrategies.join(' or ')}`);
  }

  return platform === 'win32' ? 'reader' : 'spawn';
}

export function encodeRequests(verb: 'info' | 'contents', names: readonly string[]): string {
  const holdingNul = names.find((name) => name.includes('\0'));

  if (holdingNul !== undefined) {
    throw new Error(`git cannot read a name that holds NUL: ${JSON.stringify(holdingNul)}`);
  }

  return `${names.map((name) => `${verb} ${name}\0`).join('')}flush\0`;
}

// "<oid> <type> <size>" is an object; any other header, "<name> missing" for a name that may hold spaces, is missing.
function infoOf(header: string): ObjectInfo {
  const found = /^(\S+) (\S+) (\d+)$/.exec(header);

  if (found === null) {
    return { kind: 'missing' };
  }

  // Stryker disable next-line StringLiteral: the pattern's three groups match whenever it does, so no default applies
  const [, oid = '', type = '', size = ''] = found;

  return { kind: 'object', oid, type, size: Number(size) };
}

export function parseInfos<T>(output: Buffer, items: readonly T[]): Parse<T, ObjectInfo> {
  const answers: (readonly [T, ObjectInfo])[] = [];
  let at = 0;

  for (const item of items) {
    const headerEnd = output.indexOf('\0', at);

    if (headerEnd === -1) {
      return { done: false, answers, end: at };
    }

    answers.push([item, infoOf(output.subarray(at, headerEnd).toString())]);
    at = headerEnd + 1;
  }

  return { done: true, answers, end: at };
}

export function parseContents<T>(
  output: Buffer,
  items: readonly T[],
  terminator: '\0' | '\n' = '\0',
): Parse<T, ObjectContents> {
  const answers: (readonly [T, ObjectContents])[] = [];
  let at = 0;

  for (const item of items) {
    const headerEnd = output.indexOf(terminator, at);

    if (headerEnd === -1) {
      return { done: false, answers, end: at };
    }

    const info = infoOf(output.subarray(at, headerEnd).toString());
    const start = headerEnd + 1;

    if (info.kind === 'missing') {
      answers.push([item, info]);
      at = start;
    } else {
      const end = start + info.size;

      if (output.length <= end) {
        return { done: false, answers, end: at };
      }

      answers.push([item, { ...info, bytes: output.subarray(start, end) }]);
      at = end + 1;
    }
  }

  return { done: true, answers, end: at };
}

export interface StoredEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(bytes: Buffer, oidBytes: number): readonly StoredEntry[] {
  const entries: StoredEntry[] = [];
  let at = 0;

  while (at < bytes.length) {
    const space = bytes.indexOf(' ', at);
    const nul = space === -1 ? -1 : bytes.indexOf(0, space);

    if (nul === -1) {
      throw new Error(`a tree entry is malformed at byte ${String(at)}`);
    }

    const end = nul + 1 + oidBytes;
    entries.push({
      mode: bytes.subarray(at, space).toString(),
      name: bytes.subarray(space + 1, nul).toString(),
      oid: bytes.subarray(nul + 1, end).toString('hex'),
    });
    at = end;
  }

  return entries;
}

export interface TreeEntry {
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

const treeMode = '40000';

export function walkTree(
  contents: (names: readonly string[]) => readonly (readonly [string, ObjectContents])[],
  commit: string,
): readonly TreeEntry[] {
  const root = `${commit}^{tree}`;
  const listings = new Map<string, readonly StoredEntry[]>();
  let level: readonly string[] = [root];

  while (level.length > 0) {
    const next: string[] = [];

    for (const [tree, answer] of contents(level)) {
      if (answer.kind !== 'object' || answer.type !== 'tree') {
        throw new Error(`the tree walk read ${tree}, which is not a tree`);
      }

      const entries = parseTree(answer.bytes, answer.oid.length / 2);
      listings.set(tree, entries);
      next.push(...entries.filter(({ mode }) => mode === treeMode).map(({ oid }) => oid));
    }

    level = next;
  }

  const entriesUnder = (tree: string, folder: string): readonly TreeEntry[] =>
    (listings.get(tree) ?? []).flatMap(({ mode, name, oid }) =>
      mode === treeMode
        ? entriesUnder(oid, `${folder}${name}/`)
        : [{ type: mode === '160000' ? 'commit' : 'blob', oid, path: `${folder}${name}` }],
    );

  return entriesUnder(root, '');
}

export function outOfStep(
  answers: readonly (readonly [string, ObjectInfo])[],
  end: number,
  outputLength: number,
): string | undefined {
  if (end < outputLength) {
    return 'the output goes on past the last answer';
  }

  for (const [name, answer] of answers) {
    if (answer.kind === 'object' && objectIdPattern.test(name) && answer.oid !== name) {
      return `the answer to ${name} names ${answer.oid}`;
    }
  }

  return undefined;
}
