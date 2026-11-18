// The diffs a tick reads, a page at a time:
//   node diffs.ts <commit>..<commit> | <commit> [--page <n>] [--chars <n>]
// One commit id alone reads that commit's own diff, from its parent; a commit with no parent is refused.
// Takes the newest 30 commits of the range, merges left out, and reads their diffs smallest first up to 400,000
// characters in all, or the `--chars` given; the rest are skipped. Page 1 opens with one line per commit, `read` or `skip`, its short id, its
// diff's length in characters and its subject, then `skip <n> commits past the newest 30` when there are more. The
// diffs of the read commits follow, newest first, cut into pages of at most 24,000 characters, so a page comes back
// whole in a tool result. Each page starts `diffs <range>: page <n> of <pages>` and ends with a JSON line: `page`,
// `pages`, `commits` (all of the range), `read` and `skipped`. Exit 2 with the usage, `no page <n>` or the refused `--chars` on bad input.
import { parseArgs } from 'node:util';
import { isMainModule, processIo, runCommand } from './cli.ts';
import type { Io } from './cli.ts';
import { git, gitSucceeds } from './store-git.ts';

export interface CommitDiff {
  readonly sha: string;
  readonly subject: string;
  readonly text: string;
}

export interface ReadingPlan {
  readonly read: readonly CommitDiff[];
  readonly skipped: readonly CommitDiff[];
}

export function pagesOf(text: string, size: number): readonly string[] {
  const pages: string[] = [];
  let page = '';

  const lines = text.split(/(?<=\n)/);
  const pieces = lines.flatMap((line) => line.match(new RegExp(`[^]{1,${String(size)}}`, 'g')) ?? []);

  for (const piece of pieces) {
    if (page.length + piece.length > size) {
      pages.push(page);
      page = '';
    }

    page += piece;
  }

  return [...pages, page];
}

export function planReading(commits: readonly CommitDiff[], budget: number): ReadingPlan {
  const fits = new Set<CommitDiff>();
  let spent = 0;

  for (const commit of [...commits].sort((x, y) => x.text.length - y.text.length)) {
    spent += commit.text.length;

    if (spent > budget) {
      break;
    }

    fits.add(commit);
  }

  return { read: commits.filter((commit) => fits.has(commit)), skipped: commits.filter((commit) => !fits.has(commit)) };
}

const newestCommits = 30;
const budget = 400_000;
const pageSize = 24_000;

function commitDiffs(cwd: string, range: string): readonly CommitDiff[] {
  const log = git(
    cwd,
    [
      'log',
      '--no-merges',
      `-n${String(newestCommits)}`,
      '-p',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-show-signature',
      '--format=%x1e%h%x00%s%x00%B%x00',
      range,
    ],
    { readsOnly: true },
  );

  // A patch may hold the separator byte itself; a record starts only where a commit id and a NUL follow it.
  return log
    .split(/\x1e(?=[0-9a-f]+\0)/)
    .slice(1)
    .map((record) => {
      // Stryker disable next-line StringLiteral: every record holds the three NULs its format writes, so no default applies
      const [sha = '', subject = '', body = '', patch = ''] = record.split('\0');

      return { sha, subject, text: `commit ${sha}\n${body.trim()}\n\n${patch.trim()}\n` };
    });
}

function main(argv: readonly string[], io: Io): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: { page: { type: 'string', default: '1' }, chars: { type: 'string', default: String(budget) } },
  });
  // Stryker disable next-line StringLiteral: with no range given, the default and the mutant's text both fail the check below
  const [given = ''] = positionals;
  const alone = /^[0-9a-f]{4,64}$/.test(given);
  const range = alone ? `${given}^..${given}` : given;

  if (!alone && !/^[0-9a-f]{4,64}\.\.[0-9a-f]{4,64}$/.test(range)) {
    io.err('usage: diffs.ts <commit>..<commit> | <commit> [--page <n>] [--chars <n>]\n');

    return 2;
  }

  if (alone && !gitSucceeds(io.cwd, ['rev-parse', '--verify', '--quiet', `${given}^`], { readsOnly: true })) {
    io.err(`diffs: ${given} has no parent, so it cannot be read alone\n`);

    return 2;
  }

  if (!/^[1-9]\d*$/.test(values.chars)) {
    io.err(`diffs: --chars takes a whole number of characters above 0, not '${values.chars}'\n`);

    return 2;
  }

  const commits = commitDiffs(io.cwd, range);
  const total = Number(git(io.cwd, ['rev-list', '--no-merges', '--count', range], { readsOnly: true }));
  const plan = planReading(commits, Number(values.chars));
  const planLines = commits.map(
    (commit) =>
      `${plan.read.includes(commit) ? 'read' : 'skip'} ${commit.sha} ${String(commit.text.length)} ${commit.subject}`,
  );
  const older = total - commits.length;
  const olderLines = older > 0 ? [`skip ${String(older)} commits past the newest ${String(newestCommits)}`] : [];
  const pages = pagesOf(
    [...planLines, ...olderLines, '', ...plan.read.map((commit) => commit.text)].join('\n'),
    pageSize,
  );
  const page = Number(values.page);
  const text = pages[page - 1];

  if (text === undefined) {
    io.err(
      `diffs: no page ${values.page}; the range has ${String(pages.length)} page${pages.length === 1 ? '' : 's'}\n`,
    );

    return 2;
  }

  const summary = {
    page,
    pages: pages.length,
    commits: total,
    read: plan.read.length,
    skipped: total - plan.read.length,
  };
  io.out(`diffs ${range}: page ${String(page)} of ${String(pages.length)}\n${text}\n${JSON.stringify(summary)}\n`);

  return 0;
}

export function run(argv: readonly string[], io: Io): number {
  return runCommand('diffs', io, () => main(argv, io));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), processIo());
}
