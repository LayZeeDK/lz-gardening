// Run: node --test census-cli.test.ts
// The census command line against a garden site: what it records, reads back and prints.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { censusRef, parseCensus, pendingCensusRef, writePendingCensus } from './store-census.ts';
import { census, censusCli, takeAndRecord, todoPatterns, writeSitePatterns } from './test-census.ts';
import { run } from './census.ts';
import { capturingIo, commit, git, repo, summaryOf } from './test-repo.ts';
import { censusText, planted, writeCensusText } from './test-site.ts';

test('the CLI writes its census to the pending ref of the commit the rev names, not of the rev', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);

  const result = await census(dir, ['--rev', 'main']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [
      git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']),
      parseCensus(JSON.parse(git(garden, ['show', `${pendingCensusRef(sha)}:census.json`])))?.sha,
    ],
    [pendingCensusRef(sha), sha],
  );
});

test('the CLI run with GIT_DIR naming another repository takes the census of the checkout it runs in', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const other = repo(t);

  const result = censusCli(dir, ['--rev', 'main'], { ...process.env, GIT_DIR: join(other, '.git') });

  assert.deepEqual(
    [result.status, git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending'])],
    [0, pendingCensusRef(sha)],
    result.stderr,
  );
});

test('a census in a garden that is not shared reads the census the last tick recorded as the previous one', async (t) => {
  const { dir } = planted(t);
  git(dir, ['config', 'lzGardening.share', 'false']);
  const first = summaryOf((await takeAndRecord(dir)).stdout).get('sha');
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(summaryOf(second.stdout).get('previousSha'), first);
});

test('--seed prints the seed list: files per pattern by hit count, and every duplicate name', async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n',
    'src/b.ts': '// eslint-disable-next-line\n// eslint-disable-next-line\nconst b = 1;\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const seedLines = result.stdout.split('\n').filter((line) => line.startsWith('= '));
  assert.deepEqual(seedLines, [
    '= [eslint-disable] src/b.ts 2',
    '= [eslint-disable] src/a.ts 1',
    '= duplicate toKey: src/x.ts, src/y.ts',
  ]);
});

test("--seed prints the seed report's census line: each pattern with hits and its count", async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\n// eslint-disable-next-line\nconst a = 1;\n',
    'src/t.ts': '// TODO one\n',
  });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('census: ')),
    ['census: eslint-disable 2, todo-marker 1'],
  );
});

test("--seed prints the census line as 'census: none' when no pattern has a hit", async (t) => {
  const { dir } = planted(t);

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('census: ')),
    ['census: none'],
  );
});

test('--seed adds exactly the seed list and the census line to the output', async (t) => {
  const { dir } = planted(t);
  commit(dir, {
    'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n',
    'src/x.ts': 'export const toKey = (x) => x;\n',
    'src/y.ts': 'export const toKey = (x) => x;\n',
  });

  const plain = await census(dir, ['--rev', 'HEAD']);
  const seeded = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(seeded.status, 0, seeded.stderr);
  const lines = seeded.stdout.split('\n');
  assert.ok(lines.some((line) => line.startsWith('= ')));
  assert.deepEqual(
    lines.filter((line) => !line.startsWith('= ') && !line.startsWith('census: ')),
    plain.stdout.split('\n'),
  );
});

test('a census with no --rev is a usage error that names the flags', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = await census(dir, ['--seed']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: census\.ts --rev <rev>/);
});

test('the seed list keeps a colon inside a file path', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: '// eslint-disable-next-line\n',
    encoding: 'utf8',
  });
  git(dir, ['config', 'core.protectNTFS', 'false']);
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},src/a:b.ts`]);
  git(dir, ['commit', '-q', '-m', 'colon']);

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^= \[eslint-disable\] src\/a:b\.ts 1$/m);
});

test('the seed list names at most 20 files per pattern, keeping those with the most hits', async (t) => {
  const { dir } = planted(t);
  const files = Object.fromEntries(
    Array.from({ length: 21 }, (_, index) => [`src/f${String(index).padStart(2, '0')}.ts`, '// eslint-disable\n']),
  );
  commit(dir, { ...files, 'src/f20.ts': '// eslint-disable\n// eslint-disable\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const seedLines = result.stdout.split('\n').filter((line) => line.startsWith('= [eslint-disable]'));
  assert.equal(seedLines.length, 20);
  assert.equal(seedLines[0], '= [eslint-disable] src/f20.ts 2');
  assert.ok(!seedLines.includes('= [eslint-disable] src/f19.ts 1'));
});

test('a mistyped flag is a usage error, not ignored', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--ot', join(dir, '.garden', 'census.json')]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--ot/);
});

test('--out and --patterns are not options: the census goes to the garden, and its patterns come from there', async (t) => {
  const { dir, garden } = planted(t);
  const file = join(garden, '.garden', 'census.json');

  const results = [
    await census(dir, ['--rev', 'HEAD', '--out', file]),
    await census(dir, ['--rev', 'HEAD', '--patterns', file]),
  ];

  assert.deepEqual(
    results.map((result) => [result.status, /Unknown option '--(out|patterns)'/.test(result.stderr)]),
    [
      [2, true],
      [2, true],
    ],
  );
});

test("the census counts the extra patterns in the site's .garden/patterns.json", async (t) => {
  const { dir, garden } = planted(t);
  commit(dir, { 'src/t.ts': '// TODO: one\n' });
  writeSitePatterns(garden);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^todo +1 {2}new$/m);
});

test("a site's .garden/patterns.json that is not JSON is refused, naming the file", async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden, '{ "patterns": [\n');

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, /^census: .*[\\/]\.garden[\\/]patterns\.json: /.test(result.stderr)],
    [2, true],
    result.stderr,
  );
});

test("a census taken with the site's extra patterns carries them, so a clone without the file counts the same", async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  assert.equal(git(garden, ['show', `${pendingCensusRef(sha)}:patterns.json`]), todoPatterns.trim());
});

test('a site with no .garden/patterns.json counts with the extra patterns the previous census carried', async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden);
  await takeAndRecord(dir);
  rmSync(join(garden, '.garden', 'patterns.json'));
  commit(dir, { 'src/t.ts': '// TODO: one\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^todo +1 {2}\+1$/m);
});

test('a census that differs from the recorded one in nothing but the time taken leaves nothing pending', async (t) => {
  const { dir, garden } = planted(t);
  await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(garden, ['for-each-ref', 'refs/garden/pending']), '');
});

test('a first census is not behind the garden', async (t) => {
  const { dir } = planted(t);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('behind'), false);
});

test('a census of a commit the recorded census descends from is behind the garden', async (t) => {
  const { dir } = planted(t);
  const older = git(dir, ['rev-parse', 'HEAD']);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  await takeAndRecord(dir);

  const result = await census(dir, ['--rev', older]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('behind'), true);
});

test('a previous census of a commit this checkout lacks reports no previous sha, so the tick reads no range', async (t) => {
  const { dir, garden } = planted(t);
  const unknown = 'f'.repeat(40);
  writeCensusText(garden, censusText(unknown));

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('previousSha'), null);
});

test('malformed patterns carried by the recorded census are refused, naming the census and the way out', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha), '{"patterns": "x"}\n');
  git(garden, ['update-ref', censusRef, pendingCensusRef(sha)]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, result.stderr],
    [
      2,
      'census: refs/garden/census:patterns.json (a .garden/patterns.json written in the site is read instead):' +
        ' "patterns" must be an array\n',
    ],
  );
});

test('a pattern carried by the recorded census that git grep refuses is named with the census and the way out', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const patterns = '{"patterns": [{"id": "bad", "regex": "a{2,1}"}]}\n';
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha), patterns);
  git(garden, ['update-ref', censusRef, pendingCensusRef(sha)]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, result.stderr.split(': fatal: ')[0]],
    [
      2,
      'census: git grep for bad from refs/garden/census:patterns.json' +
        ' (a .garden/patterns.json written in the site is read instead)',
    ],
    result.stderr,
  );
});

test("a bundled pattern whose git grep fails is named by its id alone, beside the site's own patterns", async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(garden);
  const blob = git(dir, ['rev-parse', 'HEAD:src/a.ts']);
  rmSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual([result.status, result.stderr.split(': error: ')[0]], [2, 'census: git grep for eslint-disable']);
});

test('a census in a repository with no garden site is refused, saying to open the site first', (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });

  const result = censusCli(dir, ['--rev', 'HEAD']);

  assert.deepEqual([result.status, /no garden site at .*; run site\.ts open first/.test(result.stderr)], [2, true]);
});

test('a recorded census that is not a census is refused by name and left as it was', async (t) => {
  const { dir, garden } = planted(t);
  writeCensusText(garden, '{"rev": 1}\n');
  const recorded = git(garden, ['rev-parse', censusRef]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, /refs\/garden\/census in .* is not a census; delete it/.test(result.stderr)],
    [2, true],
  );
  assert.equal(git(garden, ['rev-parse', censusRef]), recorded);
});

test('a census of origin/main records the base as main, for each clone to resolve on its own', async (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', sha]);

  const result = await census(dir, ['--rev', 'origin/main']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCensus(JSON.parse(git(garden, ['show', `${pendingCensusRef(sha)}:census.json`])))?.rev, 'main');
});

test('the seed list names at most 30 duplicate names, the most widely defined first, and counts the rest', async (t) => {
  const { dir } = planted(t);
  const files = Object.fromEntries(
    Array.from({ length: 31 }, (_, index) => index).flatMap((index) => [
      [`src/a${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
      [`src/b${String(index)}.ts`, `function helper${String(index)}() {}\n`] as const,
    ]),
  );
  commit(dir, { ...files, 'src/c.ts': 'function helper30() {}\n' });

  const result = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split('\n').filter((line) => line.startsWith('= duplicate '));
  assert.equal(listed.length, 30);
  assert.equal(listed[0], '= duplicate helper30: src/a30.ts, src/b30.ts, src/c.ts');
  assert.match(result.stdout, /^1 more duplicate names not listed$/m);
});

test('--seed prints the seed list even when a census was recorded before, and only then', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n' });
  const first = await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD', '--seed']);

  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(first.stdout, /^= /m);
  assert.match(again.stdout, /^= \[eslint-disable\] src\/a\.ts 1$/m);
});

test('a long hit the last census recorded, cut, is not new in the next census', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': `// eslint-disable ${'x'.repeat(5000)}\n` });
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(summaryOf(second.stdout).get('newHits'), 0);
});

test('the CLI writes the census, and a second run reports what grew', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  await takeAndRecord(dir);

  commit(dir, { 'src/a.ts': '// eslint-disable-next-line\nconst a = 1;\n' });
  const second = await census(dir, ['--rev', 'HEAD']);
  assert.equal(second.status, 0, second.stderr);

  assert.deepEqual(summaryOf(second.stdout).get('grew'), ['eslint-disable']);
  assert.match(second.stdout, /\+ \[eslint-disable\] src\/a\.ts:1:/);
});

test('a new hit holding a terminal control character prints it escaped', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/t.ts': 'const t = 1;\n' });
  await takeAndRecord(dir);
  commit(dir, { 'src/t.ts': '// TODO \u001b[31mred\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.split('\n').includes('+ [todo-marker] src/t.ts:1: // TODO \\u{1b}[31mred'), second.stdout);
});

test('a function named after a method every object has prints as a new duplicate', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  await takeAndRecord(dir);
  const body = 'export function toString() {\n  return "";\n}\n';
  commit(dir, { 'src/a.ts': body, 'src/b.ts': body });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.split('\n').includes('+ duplicate toString: new src/a.ts, src/b.ts'), second.stdout);
});

test('a pattern with more hits than the census keeps is named, as its new hits may go unlisted', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/t.ts': '// TODO x\n'.repeat(1001) });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes('hits capped at 1000: todo-marker'), result.stdout);
});

test('two patterns with more hits than the census keeps are named on one line', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/t.ts': '// TODO eslint-disable-next-line\n'.repeat(1001) });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('hits capped')),
    ['hits capped at 1000: eslint-disable, todo-marker'],
  );
});

test('a pattern with exactly as many hits as the census keeps is not named as capped', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/t.ts': '// TODO x\n'.repeat(1000) });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').slice(0, -2);
  assert.deepEqual(
    lines.filter((line) => line !== '' && !/^\S+ +(?:count|\d+) {2}/.test(line)),
    [],
  );
});

test('a census with git tracing on counts as usual, though the trace quotes a pattern that holds "error: "', async (t) => {
  const { dir, garden } = planted(t);
  writeSitePatterns(
    garden,
    `${JSON.stringify({ patterns: [{ id: 'typed-catch', regex: 'catch \\(error: unknown\\)' }] })}\n`,
  );
  commit(dir, { 'src/a.ts': 'try {\n} catch (error: unknown) {\n}\n' });
  const captured = capturingIo(dir, { ...process.env, GIT_TRACE: '1' });

  const status = await run(['--rev', 'HEAD'], captured.io);

  assert.equal(status, 0, captured.stderr());
  const sha = String(summaryOf(captured.stdout()).get('sha'));
  const recorded = parseCensus(JSON.parse(git(garden, ['show', `${pendingCensusRef(sha)}:census.json`])));
  assert.equal(recorded?.counts['typed-catch'], 1);
});

test('the table shows each count and its change in fixed columns, then the new hits, and the summary counts them', async (t) => {
  const { dir } = planted(t);
  commit(dir, { 'src/a.ts': '// eslint-disable\n// eslint-disable\n', 'src/t.ts': '// TODO one\n' });
  await takeAndRecord(dir);
  commit(dir, { 'src/a.ts': '// eslint-disable\n', 'src/t.ts': '// TODO one\n// TODO two\n' });

  const second = await census(dir, ['--rev', 'HEAD']);

  assert.equal(second.status, 0, second.stderr);
  const lines = second.stdout.split('\n');
  const summary = summaryOf(second.stdout);
  assert.deepEqual(
    [
      lines[0],
      lines.find((line) => line.startsWith('eslint-disable ')),
      lines.find((line) => line.startsWith('todo-marker ')),
      lines[lines.indexOf('+ [todo-marker] src/t.ts:2: // TODO two') - 1],
      summary.get('grew'),
      summary.get('newHits'),
    ],
    [
      `pattern${' '.repeat(25)}count  change`,
      `eslint-disable${' '.repeat(22)}1  -1`,
      `todo-marker${' '.repeat(25)}2  +1`,
      '',
      ['todo-marker'],
      1,
    ],
  );
});

test('a first census is written, with nothing grown, no new duplicate and no previous commit to be behind', async (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', censusRef]);
  const older = commit(dir, {
    'src/a.ts': '// eslint-disable\n',
    'src/x.ts': 'function f() {}\n',
    'src/y.ts': 'function f() {}\n',
  });
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['branch', 'null']);

  const result = await census(dir, ['--rev', older]);

  assert.equal(result.status, 0, result.stderr);
  const summary = summaryOf(result.stdout);
  assert.deepEqual(
    [
      git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']),
      summary.get('grew'),
      summary.get('newDuplicates'),
      summary.get('previousSha'),
      summary.get('behind'),
    ],
    [pendingCensusRef(older), [], [], null, false],
  );
});

test('a census of the commit the garden recorded is not behind it', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);

  const again = await census(dir, ['--rev', 'HEAD']);

  assert.equal(again.status, 0, again.stderr);
  assert.equal(summaryOf(again.stdout).get('behind'), false);
});

test('a census that differs from the recorded one is left pending for its commit', async (t) => {
  const { dir, garden } = planted(t);
  await takeAndRecord(dir);
  const later = commit(dir, { 'src/t.ts': '// TODO: one\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending']), pendingCensusRef(later));
});

test('a census whose summary git cannot work out exits 2 and leaves nothing pending', async (t) => {
  const { dir, garden } = planted(t);
  await takeAndRecord(dir);
  const between = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  commit(dir, { 'src/t.ts': '// TODO: one\n' });
  rmSync(join(dir, '.git', 'objects', between.slice(0, 2), between.slice(2)));

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.deepEqual(
    [result.status, git(garden, ['for-each-ref', '--format=%(refname)', 'refs/garden/pending'])],
    [2, ''],
    result.stderr,
  );
});

test('the summary counts the commits in the range from the previous census to this one', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  commit(dir, { 'src/c.ts': 'export const c = 3;\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), 2);
});

test('the commits in the range leave out merge commits, as the tick reads them', async (t) => {
  const { dir } = planted(t);
  await takeAndRecord(dir);
  git(dir, ['switch', '-q', '-c', 'side']);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  git(dir, ['switch', '-q', 'main']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), 1);
});

test('a census with no previous census to compare with counts no commits', async (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', censusRef]);

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryOf(result.stdout).get('commits'), null);
});

test('a census of a commit that descends from the recorded one is not behind the garden', async (t) => {
  const { dir } = planted(t);
  const recorded = git(dir, ['rev-parse', 'HEAD']);
  await takeAndRecord(dir);
  commit(dir, { 'src/b.ts': 'export const b = 2;\n' });

  const result = await census(dir, ['--rev', 'HEAD']);

  assert.equal(result.status, 0, result.stderr);
  const summary = summaryOf(result.stdout);
  assert.deepEqual([summary.get('previousSha'), summary.get('behind')], [recorded, false]);
});
