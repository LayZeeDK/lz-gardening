// Run: node --test census.test.ts
// Each test builds a throwaway git repository and counts weeds at one of its commits, or checks the pure functions
// that read and compare censuses.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diffCensus, diffDuplicates, mergePatternSets, parseGrep, parsePatternSet, takeCensus } from './census.ts';
import { parseCensus } from './store-census.ts';
import { gitEnv, inRun } from './store-git.ts';
import { censusOf, now, script, set, takeCensusInRun } from './test-census.ts';
import { commit, git, repo } from './test-repo.ts';

test('counts hits per pattern at a revision, honouring paths and excludes', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.ts': 'const a: any = 1; // eslint-disable-line\nconst b = a as any;\n',
    'src/b.js': 'const c: any = 1;\n',
    'README.md': 'eslint-disable is discussed here\n',
  });

  const census = await takeCensusInRun(dir, 'main', set, now);
  assert.equal(census.counts['eslint-disable'], 1);
  assert.equal(census.counts['any-type'], 2, 'the .js file is outside the pattern paths');
  assert.deepEqual(census.hits['any-type'], [
    'src/a.ts:1: const a: any = 1; // eslint-disable-line',
    'src/a.ts:2: const b = a as any;',
  ]);
});

test('a pattern with no paths counts hits in source files only, not in data files or prose', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/a.mjs': '// eslint-disable-next-line\n',
    'data/scraped.json': '{ "text": "eslint-disable" }\n',
    'notes.txt': 'eslint-disable is discussed here\n',
  });

  const census = await takeCensusInRun(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], ['src/a.mjs:1: // eslint-disable-next-line']);
});

test('the bundled structural-directive pattern counts templates and components, not other files', async (t) => {
  const dir = repo(t);
  commit(dir, {
    'src/list.html': '<li *ngFor="let item of items">{{ item }}</li>\n',
    'src/card.ts': '@Component({ template: \'<p *ngIf="shown">x</p>\' })\n',
    'eslint.config.mjs': '// Checks only *ngFor, which prefer-control-flow bans.\n',
    'docs/digest.json': '{ "text": "use *ngIf" }\n',
  });
  const bundled = parsePatternSet(JSON.parse(readFileSync(join(dirname(script), 'patterns.json'), 'utf8')), 'bundled');

  const census = await takeCensusInRun(dir, 'main', bundled, now);

  assert.deepEqual(census.hits['angular-structural-directive'], [
    'src/card.ts:1: @Component({ template: \'<p *ngIf="shown">x</p>\' })',
    'src/list.html:1: <li *ngFor="let item of items">{{ item }}</li>',
  ]);
});

test("a hit's stored text is cut to 200 characters, marked with an ellipsis", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable-next-line ${'x'.repeat(5000)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensusInRun(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line.slice(0, 200)}...`]);
});

test("a hit's text of exactly 200 characters is kept whole", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable ${'x'.repeat(182)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensusInRun(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line}`]);
});

test("a hit's text is cut by characters, not UTF-16 units: 118 characters in 218 units are kept whole", async (t) => {
  const dir = repo(t);
  const line = `// eslint-disable ${String.fromCodePoint(0x1f331).repeat(100)}`;
  commit(dir, { 'src/a.ts': `${line}\n` });

  const census = await takeCensusInRun(dir, 'main', set, now);

  assert.deepEqual(census.hits['eslint-disable'], [`src/a.ts:1: ${line}`]);
});

test('hits in a file with CRLF line ends are counted', async (t) => {
  const dir = repo(t);
  git(dir, ['config', 'core.autocrlf', 'false']);
  commit(dir, {
    'src/crlf.ts': '// eslint-disable one\r\n// eslint-disable two\r\n',
    'src/sep.ts': "const s = 'a b'; // eslint-disable\n",
  });
  const before = await takeCensusInRun(dir, 'HEAD', set, now);
  commit(dir, {
    'src/crlf.ts': '\r\n// eslint-disable one\r\n// eslint-disable two\r\n',
    'src/sep.ts': "\nconst s = 'a b'; // eslint-disable\n",
  });
  const after = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(
    [before.hits['eslint-disable'], diffCensus(before, after).find((item) => item.id === 'eslint-disable')?.added],
    [
      [
        'src/crlf.ts:1: // eslint-disable one',
        'src/crlf.ts:2: // eslint-disable two',
        "src/sep.ts:1: const s = 'a b'; // eslint-disable",
      ],
      [],
    ],
  );
});

test('reads the revision, not the working tree', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  writeFileSync(join(dir, 'src/a.ts'), '// eslint-disable\n');

  const census = await takeCensusInRun(dir, 'HEAD', set, now);
  assert.equal(census.counts['eslint-disable'], 0);
});

test('the delta ignores moved lines and reports only new hits', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1 as any;\n' });
  const before = await takeCensusInRun(dir, 'HEAD', set, now);
  commit(dir, { 'src/a.ts': '\n\nconst a = 1 as any;\nconst b = 2 as any;\n' });
  const after = await takeCensusInRun(dir, 'HEAD', set, now);

  const delta = diffCensus(before, after).find((item) => item.id === 'any-type');
  assert.deepEqual(delta, { id: 'any-type', before: 1, after: 2, added: ['src/a.ts:4: const b = 2 as any;'] });
});

test('a first census has no previous counts and reports no hits as new', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1 as any;\n' });
  const after = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(
    diffCensus(null, after).find((item) => item.id === 'any-type'),
    {
      id: 'any-type',
      before: null,
      after: 1,
      added: [],
    },
  );
});

test('an unknown revision is an error, not an empty census', async (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': '' });

  await assert.rejects(takeCensusInRun(dir, 'no-such-branch', set, now), /rev-parse/);
});

test('extra patterns override by id and add excludes', () => {
  const extra = parsePatternSet(
    { exclude: ['gen/**'], patterns: [{ id: 'any-type', regex: 'any', note: 'stricter' }] },
    'extra',
  );
  const merged = mergePatternSets(set, extra);

  assert.deepEqual(merged.exclude, ['**/*.md', 'gen/**']);
  assert.equal(merged.patterns.find((pattern) => pattern.id === 'any-type')?.regex, 'any');
  assert.equal(merged.patterns.length, 2);
});

test('a malformed pattern set fails loudly', () => {
  assert.throws(() => parsePatternSet({ patterns: [{ id: 'Bad Id', regex: 'x' }] }, 'p'), /kebab/);
  assert.throws(() => parsePatternSet({ patterns: [{ id: 'ok' }] }, 'p'), /regex/);
  assert.equal(parseCensus({ rev: 1 }), null);
});

function refusalOf(json: unknown): string {
  try {
    parsePatternSet(json, 'p');
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  return 'accepted';
}

test('each malformed part of a pattern set is refused, naming its source and the part', () => {
  const malformed: readonly unknown[] = [
    null,
    { patterns: 'x' },
    { patterns: ['x'] },
    { exclude: 'x' },
    { exclude: ['a', 1] },
    { patterns: [{ id: 'kebab-Case', regex: 'x' }] },
    { patterns: [{ id: 'ok', regex: '' }] },
    { patterns: [{ id: 'ok', regex: 'x', paths: ['src/**', 1] }] },
  ];

  assert.deepEqual(malformed.map(refusalOf), [
    'p: expected an object with "patterns"',
    'p: "patterns" must be an array',
    'p: patterns[0] must be an object',
    'p: "exclude" must be an array of strings',
    'p: "exclude" must be an array of strings',
    'p: patterns[0].id must be a kebab-case string',
    'p: pattern ok needs a non-empty "regex"',
    'p: pattern ok "paths" must be an array of strings',
  ]);
});

test('a pattern set may leave out patterns, excludes, paths and notes', () => {
  assert.deepEqual(
    [parsePatternSet({}, 'p'), parsePatternSet({ patterns: [{ id: 'todo', regex: 'TODO', paths: ['src/**'] }] }, 'p')],
    [
      { exclude: [], patterns: [] },
      { exclude: [], patterns: [{ id: 'todo', regex: 'TODO', paths: ['src/**'], note: '' }] },
    ],
  );
});

test('a pattern with more than 1000 hits counts them all and keeps the first 1000', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/many.ts': '// eslint-disable\n'.repeat(1001) });

  const census = await takeCensusInRun(dir, 'HEAD', set, now);

  assert.deepEqual(
    [census.counts['eslint-disable'], census.hits['eslint-disable']?.length, census.hits['eslint-disable']?.at(-1)],
    [1001, 1000, 'src/many.ts:1000: // eslint-disable'],
  );
});

test('only a leading origin/ is dropped from the recorded rev', async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'const a = 1;\n' });
  git(dir, ['branch', 'team/origin/main']);

  const census = await takeCensusInRun(dir, 'team/origin/main', set, now);

  assert.equal(census.rev, 'team/origin/main');
});

test("an unknown revision's error carries git's own reason", async (t) => {
  const dir = repo(t);
  commit(dir, { 'a.ts': '' });

  await assert.rejects(takeCensusInRun(dir, 'no-such-branch', set, now), {
    message: /^git rev-parse --verify no-such-branch\^\{commit\}: \S[^\n]*$/,
  });
});

test("a git grep that fails is an error that names the search and carries git's reason", async (t) => {
  const dir = repo(t);
  commit(dir, { 'src/a.ts': 'function f() {}\n' });

  await assert.rejects(takeCensusInRun(dir, 'HEAD', { exclude: ['../outside'], patterns: [] }, now), {
    message: /^git grep for definitions: \S[^\n]*$/,
  });
});

test('git grep output counts only lines of the revision asked for that carry a line number', () => {
  assert.deepEqual(parseGrep('abc:a.ts:1:x\nxyz:b.ts:2:y\nabc:no line number\n', 'abc'), ['a.ts:1: x']);
});

test('the delta matches hits by path and text, wherever the line moved', () => {
  const delta = diffCensus(censusOf({ p: ['a.ts:3: old'] }), censusOf({ p: ['a.ts:1: new', 'a.ts:12: old'] }));

  assert.deepEqual(delta, [{ id: 'p', before: 1, after: 2, added: ['a.ts:1: new'] }]);
});

test('a hit that appears once more often than before is new once', () => {
  const delta = diffCensus(
    censusOf({ p: ['a.ts:1: x', 'a.ts:2: x'] }),
    censusOf({ p: ['a.ts:1: x', 'a.ts:2: x', 'a.ts:3: x'] }),
  );

  assert.deepEqual(delta, [{ id: 'p', before: 2, after: 3, added: ['a.ts:3: x'] }]);
});

test('a function named after a method every object has is a new duplicate like any other', () => {
  const after = censusOf({}, { toString: ['a.ts', 'b.ts'] });

  assert.deepEqual(diffDuplicates(censusOf({}), after), ['toString']);
});

test('a pattern whose id names a method every object has is new when the previous census lacks it', () => {
  const delta = diffCensus(censusOf({}), censusOf({ constructor: ['a.ts:1: x'] }));

  assert.deepEqual(delta, [{ id: 'constructor', before: null, after: 1, added: [] }]);
});

test('a pattern counted without a hit list has no new hits', () => {
  const delta = diffCensus(censusOf({ p: [] }), { ...censusOf({}), counts: { p: 1 } });

  assert.deepEqual(delta, [{ id: 'p', before: 0, after: 1, added: [] }]);
});

test('a census in a folder that does not exist fails with the reason git could not start', async (t) => {
  const dir = repo(t);

  const env = inRun(process.env, () => gitEnv(dir));

  await assert.rejects(takeCensus(join(dir, 'missing'), 'HEAD', set, now, env), { code: 'ENOENT' });
});

test('git grep output keeps colons inside the matched text', () => {
  assert.deepEqual(parseGrep('abc:src/a.ts:3:  const x = { a: 1 } as any;\nother line\n', 'abc'), [
    'src/a.ts:3: const x = { a: 1 } as any;',
  ]);
});
