import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseNames, skillParts, splitEvalSet, withDescription, writeCases } from './trigger-cases.ts';

test('withDescription replaces the frontmatter description with a quoted one and skillParts reads it back', () => {
  const skill = ['---', 'name: lz-tend', 'description: Tend one class.', '---', '', '# Body', ''].join('\n');
  const changed = withDescription(skill, 'Use for "tend <class>": weeds.');

  assert.deepEqual(
    [changed.split('\n')[2], skillParts(changed), skillParts(skill).description],
    [
      'description: "Use for \\"tend <class>\\": weeds."',
      { name: 'lz-tend', description: 'Use for "tend <class>": weeds.', body: '# Body\n' },
      'Tend one class.',
    ],
  );
});

test('withDescription writes a description holding replacement patterns such as $& as it is', () => {
  const skill = ['---', 'name: lz-tend', 'description: Old.', '---', ''].join('\n');

  assert.equal(skillParts(withDescription(skill, "Costs $& or $$ or $'.")).description, "Costs $& or $$ or $'.");
});

test('splitEvalSet keeps every query for training when the holdout is 0', () => {
  const set = [
    { query: 'tend it', should_trigger: true },
    { query: 'explain it', should_trigger: false },
  ];

  assert.deepEqual(splitEvalSet(set, 0, 42), { train: set, test: [] });
});

test('writeCases writes one case per query, tagged with its split, whose grader counts the skill being invoked', () => {
  const evals = join(mkdtempSync(join(tmpdir(), 'trigger-cases-')), 'evals');

  const names = writeCases(evals, 'lz-tend', {
    train: [{ query: 'pull these "weeds"', should_trigger: true }],
    test: [{ query: 'what is a worktree?', should_trigger: false }],
  });

  assert.deepEqual(
    [
      names,
      readdirSync(evals).sort(),
      readFileSync(join(evals, 'q01', 'prompt.md'), 'utf8'),
      readFileSync(join(evals, 'q02', 'prompt.md'), 'utf8').split('\n')[2],
      readFileSync(join(evals, 'q01', 'graders', 'invoked.md'), 'utf8'),
    ],
    [
      { q01: 'pull these "weeds"', q02: 'what is a worktree?' },
      ['q01', 'q02'],
      [
        '---',
        'name: q01',
        'tags: [train]',
        'max_turns: 3',
        'allowed_tools: [Read, Glob, Grep, Skill]',
        '---',
        '',
        'pull these "weeds"',
        '',
      ].join('\n'),
      'tags: [test]',
      [
        '---',
        'type: tool_used',
        'tool: Skill',
        `input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?lz-tend"'`,
        'arm: both',
        '---',
        '',
      ].join('\n'),
    ],
  );
});

function querySet(should: number, shouldNot: number) {
  return [
    ...Array.from({ length: should }, (_, index) => ({ query: `yes ${String(index)}`, should_trigger: true })),
    ...Array.from({ length: shouldNot }, (_, index) => ({ query: `no ${String(index)}`, should_trigger: false })),
  ];
}

test('caseNames gives the case names writeCases writes, train queries first, without writing a file', () => {
  const split = {
    train: [{ query: 'pull these weeds', should_trigger: true }],
    test: [
      { query: 'what is a worktree?', should_trigger: false },
      { query: 'tend the any-type bed', should_trigger: true },
    ],
  };

  assert.deepEqual(caseNames(split), {
    q01: 'pull these weeds',
    q02: 'what is a worktree?',
    q03: 'tend the any-type bed',
  });
});

test('splitEvalSet holds out a share of each kind, at least one of each, the same way for the same seed', () => {
  const set = querySet(10, 5);
  const first = splitEvalSet(set, 0.4, 42);
  const count = (queries: readonly { should_trigger: boolean }[], kind: boolean) =>
    queries.filter((query) => query.should_trigger === kind).length;

  assert.deepEqual(
    [
      [count(first.test, true), count(first.test, false), count(first.train, true), count(first.train, false)],
      splitEvalSet(set, 0.4, 42),
      splitEvalSet(querySet(2, 1), 0.1, 7).test.length,
      new Set([...first.train, ...first.test].map(({ query }) => query)).size,
    ],
    [[4, 2, 6, 3], first, 2, 15],
  );
});
