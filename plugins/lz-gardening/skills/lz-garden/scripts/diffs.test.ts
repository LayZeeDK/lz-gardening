// Run: node --test diffs.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pagesOf, planReading, run } from './diffs.ts';
import type { CommitDiff } from './diffs.ts';
import { capturingIo, commit, git, repo, scriptProcess, startedGits, summaryOf } from './test-repo.ts';

function diff(sha: string, size: number): CommitDiff {
  return { sha, subject: `subject of ${sha}`, text: 'x'.repeat(size) };
}

function printed(dir: string, args: readonly string[]): string {
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  assert.equal(run(args, io), 0, stderr());

  return stdout();
}

// The text of a printed page: what follows its first line and comes before its JSON line.
function pageText(stdout: string): string {
  return stdout.slice(stdout.indexOf('\n') + 1, stdout.lastIndexOf('\n', stdout.length - 2));
}

// The length a page's read or skip line gives the diff of a range's one commit.
function diffLength(stdout: string): number {
  return Number(/^(?:read|skip) [0-9a-f]+ (\d+) /m.exec(stdout)?.[1]);
}

// A commit on base that adds a file of one line of `size` characters, and the range that holds only it. Files of the
// same name length give diffs whose length differs by their sizes alone.
function oneLineCommit(dir: string, base: string, name: string, size: number): string {
  git(dir, ['checkout', '-q', '--detach', base]);

  return `${base}..${commit(dir, { [name]: `${'y'.repeat(size)}\n` })}`;
}

// `count` commits onto `from` on main, each setting a.ts to a new line, written by one git fast-import: one commit at a
// time, 201 of them take 24 s on Windows. Returns the last.
function commitsOnto(dir: string, from: string, count: number): string {
  const stream = Array.from({ length: count }, (_, n) => {
    const content = `export const a = ${String(n + 1)};\n`;

    return [
      'commit refs/heads/main',
      `committer test <test@example.com> ${String(1_700_000_000 + n)} +0000`,
      'data 1',
      'x',
      ...(n === 0 ? [`from ${from}`] : []),
      'M 100644 inline a.ts',
      `data ${String(content.length)}`,
      content,
    ].join('\n');
  });
  const result = spawnSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream.join(''), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  return git(dir, ['rev-parse', 'main']);
}

test('a reading plan reads every commit when their diffs fit the budget together', () => {
  const commits = [diff('b', 30), diff('a', 70)];

  const plan = planReading(commits, 100);

  assert.deepEqual(plan, { read: commits, skipped: [] });
});

test('a reading plan reads the smallest diffs first and skips those past the budget, keeping the log order', () => {
  const [c, b, a] = [diff('c', 60), diff('b', 50), diff('a', 30)];

  const plan = planReading([c, b, a], 85);

  assert.deepEqual(plan, { read: [b, a], skipped: [c] });
});

test('a reading plan skips a diff that passes the budget by one character', () => {
  const [b, a] = [diff('b', 71), diff('a', 30)];

  const plan = planReading([b, a], 100);

  assert.deepEqual(plan, { read: [a], skipped: [b] });
});

test('text whose last line has no line end keeps that line whole', () => {
  const pages = pagesOf('one\ntwo', 100);

  assert.deepEqual(pages, ['one\ntwo']);
});

test('empty text is one empty page', () => {
  const pages = pagesOf('', 10);

  assert.deepEqual(pages, ['']);
});

test('text that fits one page is one page', () => {
  const pages = pagesOf('one\ntwo\n', 100);

  assert.deepEqual(pages, ['one\ntwo\n']);
});

test('longer text breaks into pages at line ends, each page as full as the size allows', () => {
  const pages = pagesOf('aaa\nbbb\nccc\n', 8);

  assert.deepEqual(pages, ['aaa\nbbb\n', 'ccc\n']);
});

test('a line longer than a page is cut, so no page is longer than the size', () => {
  const pages = pagesOf('ab\ncdefghij\n', 4);

  assert.deepEqual(pages, ['ab\n', 'cdef', 'ghij', '\n']);
});

test("the CLI prints a range's first page: a read line per commit, its diff, and the page's JSON summary", (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`], io);

  assert.equal(status, 0);
  assert.match(stdout(), new RegExp(`^read ${to.slice(0, 7)}[0-9a-f]* \\d+ x$`, 'm'));
  assert.match(stdout(), /^\+export const b = 2;$/m);
  assert.deepEqual(Object.fromEntries(summaryOf(stdout())), { page: 1, pages: 1, commits: 1, read: 1, skipped: 0 });
});

test("one commit id alone reads that commit's own diff, from its parent", (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const pointed = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  commit(dir, { 'c.ts': 'export const c = 3;\n' });

  const stdout = printed(dir, [pointed]);

  const readIds = [...stdout.matchAll(/^read ([0-9a-f]+)/gm)].map((match) => match[1] ?? '');

  assert.deepEqual(
    [readIds.length, pointed.startsWith(readIds[0] ?? '-'), /^\+export const b = 2;$/m.test(stdout)],
    [1, true, true],
  );
  assert.equal(summaryOf(stdout).get('commits'), 1);
});

test('a first commit given alone is refused with exit 2, as it has no parent to read from', (t) => {
  const dir = repo(t);
  const first = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run([first], io);

  assert.deepEqual(
    [status, stdout(), stderr()],
    [2, '', `diffs: ${first} has no parent, so it cannot be read alone\n`],
  );
});

test('planted prints the --source of the commit that added the line, ready for weeds.ts add', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const planter = commit(dir, { 'a.ts': 'export const a = 1;\nexport const b = `${a}`;\n' });
  const tip = commit(dir, { 'c.ts': 'export const c = 3;\n' });

  const stdout = printed(dir, ['planted', tip, 'a.ts:2']);

  assert.equal(stdout, `commit:${git(dir, ['rev-parse', '--short', planter])}\n`);
});

test('planted names the commit that added the line, not a later one that only changed its whitespace', (t) => {
  const dir = repo(t);
  const planter = commit(dir, { 'a.ts': 'if (a) {\nreturn `${a}`;\n}\n' });
  const tip = commit(dir, { 'a.ts': 'if (a) {\n  return `${a}`;\n}\n' });

  const stdout = printed(dir, ['planted', tip, 'a.ts:2']);

  assert.equal(stdout, `commit:${git(dir, ['rev-parse', '--short', planter])}\n`);
});

test('planted names the commit that added the line, not a later one that only moved it within its file', (t) => {
  const dir = repo(t);
  const lines = Array.from({ length: 30 }, (_, n) => `export const v${String(n)} = ${String(n)};\n`);
  // git follows a moved line of 20 letters or digits or more, as a census hit's line is.
  const hit = '// eslint-disable-next-line no-console -- prints `${v1}` for the planted check\n';
  const planter = commit(dir, { 'a.ts': [...lines, hit].join('') });
  const tip = commit(dir, { 'a.ts': [hit, ...lines].join('') });

  const stdout = printed(dir, ['planted', tip, 'a.ts:1']);

  assert.equal(stdout, `commit:${git(dir, ['rev-parse', '--short', planter])}\n`);
});

test('planted takes a branch name for the commit, as a tend pass names its base', (t) => {
  const dir = repo(t);
  const planter = commit(dir, { 'a.ts': 'export const b = `${a}`;\n' });
  git(dir, ['branch', '-f', 'base']);

  const stdout = printed(dir, ['planted', 'base', 'a.ts:1']);

  assert.equal(stdout, `commit:${git(dir, ['rev-parse', '--short', planter])}\n`);
});

test('planted refuses anything but a commit and a <path>:<line> with exit 2 and its usage', (t) => {
  const dir = repo(t);
  const tip = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const usage = 'usage: diffs.ts planted <commit> <path>:<line>\n';
  const refused = [
    ['planted'],
    ['planted', tip],
    ['planted', '--', '--output=x', 'a.ts:1'],
    ['planted', tip, 'a.ts'],
    ['planted', tip, 'a.ts:0'],
    ['planted', tip, 'a.ts:1', 'b.ts:1'],
    ['planted', tip, 'a.ts:1', '--page', '3'],
    ['planted', '', 'a.ts:1'],
    ['planted', '--contents=x', 'a.ts:1'],
    ['planted', tip, 'a.ts:1x'],
    ['planted', tip, 'x\na.ts:1'],
  ].map((args) => {
    const { io, stdout, stderr } = capturingIo(dir, process.env);

    return [run(args, io), stdout(), stderr()];
  });

  assert.deepEqual(
    refused,
    Array.from({ length: 11 }, () => [2, '', usage]),
  );
});

test('planted reads a line of two or more digits', (t) => {
  const dir = repo(t);
  const lines = Array.from({ length: 12 }, (_, n) => `export const v${String(n)} = ${String(n)};\n`);
  const planter = commit(dir, { 'a.ts': lines.join('') });

  const stdout = printed(dir, ['planted', planter, 'a.ts:12']);

  assert.equal(stdout, `commit:${git(dir, ['rev-parse', '--short', planter])}\n`);
});

test('planted finds the commit with plain git reads, none of the settings or config reads a write takes', (t) => {
  const dir = repo(t);
  const tip = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const started = startedGits(t);

  printed(dir, ['planted', tip, 'a.ts:1']);

  assert.deepEqual(
    started().map(({ args }) => args[0]),
    ['blame', 'rev-parse'],
  );
});

test('planted refuses a line or a file the commit does not hold with exit 2, naming it and git reason', (t) => {
  const dir = repo(t);
  const tip = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const refused = ['a.ts:2', 'b.ts:1'].map((where) => {
    const { io, stdout, stderr } = capturingIo(dir, process.env);

    return [run(['planted', tip, where], io), stdout(), stderr()];
  });

  assert.deepEqual(refused, [
    [2, '', `diffs: ${tip} holds no a.ts:2: file a.ts has only 1 line\n`],
    [2, '', `diffs: ${tip} holds no b.ts:1: no such path b.ts in ${tip}\n`],
  ]);
});

test('planted refuses a path it cannot find with its control bytes escaped, as the other scripts print them', (t) => {
  const dir = repo(t);
  const tip = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run(['planted', tip, 'b\u001b[31m.ts:1'], io);

  assert.deepEqual(
    [status, stdout(), stderr().includes('\u001b'), stderr().startsWith(`diffs: ${tip} holds no b\\u{1b}[31m.ts:1: `)],
    [2, '', false, true],
  );
});

test("a page lists the range's commits, then a blank line, then each diff under its id and message, trimmed", (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });

  const stdout = printed(dir, [`${from}..${to}`]);

  assert.match(
    stdout,
    /^diffs \S+: page 1 of 1\nread [0-9a-f]+ \d+ x\n\ncommit [0-9a-f]+\nx\n\ndiff --git a\/b\.ts b\/b\.ts\n/,
  );
  assert.match(stdout, /\n\+export const b = 2;\n\n\{"page":1,/);
});

test('a range reads its diffs with plain git reads, none of the settings or config reads a write takes', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const started = startedGits(t);

  printed(dir, [`${from}..${to}`]);

  assert.deepEqual(
    started().map(({ args }) => args[0]),
    ['log', 'rev-list'],
  );
});

test('one commit id alone is read with plain git reads too, its parent looked up first', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const pointed = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const started = startedGits(t);

  printed(dir, [pointed]);

  assert.deepEqual(
    started().map(({ args }) => args[0]),
    ['rev-parse', 'log', 'rev-list'],
  );
});

test('a diff of exactly 400,000 characters is read, and one a character longer is skipped', (t) => {
  const dir = repo(t);
  const base = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const probeSize = 100_000;
  const overhead = diffLength(printed(dir, [oneLineCommit(dir, base, 'p.txt', probeSize)])) - probeSize;

  const fits = printed(dir, [oneLineCommit(dir, base, 'q.txt', 400_000 - overhead)]);
  const over = printed(dir, [oneLineCommit(dir, base, 'r.txt', 400_001 - overhead)]);

  assert.deepEqual(
    [diffLength(fits), summaryOf(fits).get('read'), diffLength(over), summaryOf(over).get('read')],
    [400_000, 1, 400_001, 0],
  );
});

test('--chars sets the budget: a diff of exactly that length is read, and one a character longer is skipped', (t) => {
  const dir = repo(t);
  const base = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const probeSize = 10_000;
  const overhead = diffLength(printed(dir, [oneLineCommit(dir, base, 'p.txt', probeSize)])) - probeSize;

  const fits = printed(dir, [oneLineCommit(dir, base, 'q.txt', 20_000 - overhead), '--chars', '20000']);
  const over = printed(dir, [oneLineCommit(dir, base, 'r.txt', 20_001 - overhead), '--chars', '20000']);

  assert.deepEqual(
    [diffLength(fits), summaryOf(fits).get('read'), diffLength(over), summaryOf(over).get('read')],
    [20_000, 1, 20_001, 0],
  );
});

test('a page holds exactly 24,000 characters, and one character more starts a second page', (t) => {
  const dir = repo(t);
  const base = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const probeSize = 20_000;
  const overhead = pageText(printed(dir, [oneLineCommit(dir, base, 'p.txt', probeSize)])).length - probeSize;

  const full = printed(dir, [oneLineCommit(dir, base, 'q.txt', 24_000 - overhead)]);
  const over = printed(dir, [oneLineCommit(dir, base, 'r.txt', 24_001 - overhead)]);

  assert.deepEqual([pageText(full).length, summaryOf(full).get('pages'), summaryOf(over).get('pages')], [24_000, 1, 2]);
});

test('an option diffs.ts does not take is refused with exit 2, naming the script and the option', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`, '--pages', '2'], io);

  assert.deepEqual([status, stdout()], [2, '']);
  assert.match(stderr(), /^diffs: .*'--pages'/);
});

test('a range with anything before or after its two commit ids is refused with the usage', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const statuses = [`^${from}..${to}`, `${from}..${to}~`].map((range) => {
    const { io, stderr } = capturingIo(dir, process.env);

    return [run([range], io), stderr()];
  });

  assert.deepEqual(statuses, [
    [2, 'usage: diffs.ts <commit>..<commit> | <commit> [--page <n>] [--chars <n>]\n'],
    [2, 'usage: diffs.ts <commit>..<commit> | <commit> [--page <n>] [--chars <n>]\n'],
  ]);
});

test('diffs.ts run as a script prints the first page of the range it is given', async (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });

  const result = await scriptProcess(join(import.meta.dirname, 'diffs.ts'), dir, [`${from}..${to}`]);

  assert.deepEqual([result.status, summaryOf(result.stdout).get('read')], [0, 1]);
});

test('a diff that holds the byte that separates commits in the log stays one commit, whole', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.txt': 'a\n' });
  const to = commit(dir, { 'b.txt': 'field\x1eseparated\n' });
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`], io);

  assert.equal(status, 0);
  assert.match(stdout(), /^\+field\x1eseparated$/m);
  assert.deepEqual(Object.fromEntries(summaryOf(stdout())), { page: 1, pages: 1, commits: 1, read: 1, skipped: 0 });
});

test('--page <n> prints the nth page, each page short enough to come back inline', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': `${'// filler line\n'.repeat(2000)}export const last = 2;\n` });
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`, '--page', '2'], io);

  assert.equal(status, 0);
  assert.match(stdout(), /^diffs .*: page 2 of 2$/m);
  assert.match(stdout(), /^\+export const last = 2;$/m);
  assert.ok(stdout().length < 25_000, `page of ${String(stdout().length)} characters`);
  assert.equal(summaryOf(stdout()).get('page'), 2);
});

test('a page past the last one is refused with exit 2, naming how many pages there are', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`, '--page', '2'], io);

  assert.deepEqual([status, stdout(), stderr()], [2, '', 'diffs: no page 2; the range has 1 page\n']);
});

test('a page past the last of several is refused, naming the pages in the plural', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': `${'// filler line\n'.repeat(2000)}export const last = 2;\n` });
  const { io, stderr } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`, '--page', '3'], io);

  assert.deepEqual([status, stderr()], [2, 'diffs: no page 3; the range has 2 pages\n']);
});

test('--chars that is not a whole number above 0 is refused with exit 2, naming the value', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const to = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const refusals = ['20k', '0', '1.5', ''].map((chars) => {
    const { io, stdout, stderr } = capturingIo(dir, process.env);

    return [run([`${from}..${to}`, `--chars=${chars}`], io), stdout(), stderr()];
  });

  assert.deepEqual(
    refusals,
    ['20k', '0', '1.5', ''].map((chars) => [
      2,
      '',
      `diffs: --chars takes a whole number of characters above 0, not '${chars}'\n`,
    ]),
  );
});

test('an argument that is not a range of two commit ids is refused with exit 2 and the usage', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run(['HEAD'], io);

  assert.deepEqual(
    [status, stdout(), stderr()],
    [2, '', 'usage: diffs.ts <commit>..<commit> | <commit> [--page <n>] [--chars <n>]\n'],
  );
});

test('a commit whose diff alone passes 400,000 characters is skipped, and a smaller one is read', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const big = commit(dir, { 'big.txt': `${'y'.repeat(99)}\n`.repeat(4000) });
  const small = commit(dir, { 'b.ts': 'export const b = 2;\n' });
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${small}`], io);

  assert.equal(status, 0);
  assert.match(stdout(), new RegExp(`^skip ${big.slice(0, 7)}[0-9a-f]* \\d+ x$`, 'm'));
  assert.match(stdout(), new RegExp(`^read ${small.slice(0, 7)}[0-9a-f]* \\d+ x$`, 'm'));
  assert.deepEqual([summaryOf(stdout()).get('read'), summaryOf(stdout()).get('skipped')], [1, 1]);
});

test('a commit past the newest 200 is skipped, and the first page says so', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 0;\n' });
  const to = commitsOnto(dir, from, 201);
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${to}`], io);

  assert.equal(status, 0);
  assert.match(stdout(), /^skip 1 commits past the newest 200$/m);
  assert.deepEqual([summaryOf(stdout()).get('read'), summaryOf(stdout()).get('skipped')], [200, 1]);
});
