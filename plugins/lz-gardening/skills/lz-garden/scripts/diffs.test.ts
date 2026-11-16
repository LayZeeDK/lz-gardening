// Run: node --test diffs.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pagesOf, planReading, run } from './diffs.ts';
import type { CommitDiff } from './diffs.ts';
import { capturingIo, commit, repo, summaryOf } from './test-repo.ts';

function diff(sha: string, size: number): CommitDiff {
  return { sha, subject: `subject of ${sha}`, text: 'x'.repeat(size) };
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

test('an argument that is not a range of two commit ids is refused with exit 2 and the usage', (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': 'export const a = 1;\n' });
  const { io, stdout, stderr } = capturingIo(dir, process.env);

  const status = run(['HEAD'], io);

  assert.deepEqual([status, stdout(), stderr()], [2, '', 'usage: diffs.ts <commit>..<commit> [--page <n>]\n']);
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

test('commits past the newest 30 are skipped, and the first page says how many', (t) => {
  const dir = repo(t);
  const from = commit(dir, { 'a.ts': 'export const a = 0;\n' });
  const shas = Array.from({ length: 32 }, (_, n) => commit(dir, { 'a.ts': `export const a = ${String(n + 1)};\n` }));
  const { io, stdout } = capturingIo(dir, process.env);

  const status = run([`${from}..${shas.at(-1) ?? ''}`], io);

  assert.equal(status, 0);
  assert.match(stdout(), /^skip 2 commits past the newest 30$/m);
  assert.deepEqual([summaryOf(stdout()).get('read'), summaryOf(stdout()).get('skipped')], [30, 2]);
});
