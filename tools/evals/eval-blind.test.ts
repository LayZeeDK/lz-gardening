import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { blind, blindText, unblind } from './eval-blind.ts';

test('blindText replaces each plugin path, however a call spelled it, and the configuration names', () => {
  const text = [
    'node "D:/wt-x/plugins/lz-gardening/skills/lz-garden/scripts/census.ts"',
    '{"command":"node D:\\\\wt-x\\\\plugins\\\\lz-gardening\\\\x.ts"}',
    'node d:\\wt-x\\plugins\\lz-gardening\\y.ts',
    'cd /d/wt-x/plugins/lz-gardening',
    'the old_skill and new_skill text',
  ].join('\n');

  assert.equal(
    blindText(text, ['D:/wt-x/plugins/lz-gardening'], ['new_skill', 'old_skill']),
    [
      'node "<plugin>/skills/lz-garden/scripts/census.ts"',
      '{"command":"node <plugin>\\\\x.ts"}',
      'node <plugin>\\y.ts',
      'cd <plugin>',
      'the <config> and <config> text',
    ].join('\n'),
  );
});

// An iteration with one graded garden-seed run per configuration on Sonnet.
function gradedIteration(): string {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-blind-')).replaceAll('\\', '/');
  const plugins = { new_skill: 'D:/wt-1/plugins/lz-gardening', old_skill: 'D:/wt-2/plugins/lz-gardening' };
  writeFileSync(
    `${iteration}/iteration.json`,
    JSON.stringify({
      configs: { new_skill: { plugin: plugins.new_skill }, old_skill: { plugin: plugins.old_skill } },
      models: ['sonnet'],
      runs: 1,
    }),
  );
  const evalFolder = `${iteration}/eval-garden-seed-sonnet`;
  mkdirSync(evalFolder, { recursive: true });
  writeFileSync(
    `${evalFolder}/eval_metadata.json`,
    JSON.stringify({ eval_id: 0, assertions: [{ text: 'A census ran.', check: 'census-taken' }, { text: 'Judged.' }] }),
  );

  for (const [index, [config, plugin]] of Object.entries(plugins).entries()) {
    const outputs = `${evalFolder}/${config}/run-1/outputs`;
    mkdirSync(outputs, { recursive: true });
    writeFileSync(`${outputs}/result.json`, JSON.stringify({ cwd: `S:/samples/it-${String(index)}`, ms: 1 }));
    writeFileSync(`${outputs}/calls.jsonl`, `{"input":"${plugin}/x.ts"}\n`);
    writeFileSync(`${outputs}/final.md`, `## result.json\n\nDone by ${config}.\n`);
  }

  return iteration;
}

test('blind gives the judge each run under a letter with its calls, report, metadata and checkout, and no configuration', () => {
  const iteration = gradedIteration();

  blind(iteration, 'garden-seed', 1, []);

  const judgeFolder = `${iteration}/judge-garden-seed-1`;
  const letters = readdirSync(judgeFolder).sort();
  const texts = letters.flatMap((letter) =>
    ['calls.jsonl', 'final.md', 'run.json', 'eval_metadata.json'].map((file) =>
      readFileSync(`${judgeFolder}/${letter}/${file}`, 'utf8'),
    ),
  );

  const key: unknown = JSON.parse(readFileSync(`${iteration}/judge-garden-seed-1.key.json`, 'utf8'));
  const keyed = isRecord(key) ? Object.entries(key) : [];
  const runJson = (letter: string): unknown => JSON.parse(readFileSync(`${judgeFolder}/${letter}/run.json`, 'utf8'));
  const checkout = (runDir: unknown): string => `S:/samples/it-${String(runDir).includes('new_skill') ? '0' : '1'}`;

  assert.deepEqual(
    [
      letters,
      texts.filter((text) => /new_skill|old_skill|wt-1|wt-2/.test(text)),
      texts.filter((text) => text.includes('<plugin>/x.ts')).length,
      keyed.map(([letter]) => runJson(letter)),
    ],
    [
      ['a', 'b'],
      [],
      2,
      keyed.map(([, runDir]) => ({
        model: 'sonnet',
        checkout: checkout(runDir),
        site: `${checkout(runDir)}.garden`,
      })),
    ],
  );
  assert.deepEqual(
    isRecord(key) ? Object.values(key).sort() : [],
    ['new_skill', 'old_skill'].map((config) => `${iteration}/eval-garden-seed-sonnet/${config}/run-1`),
  );
});

test('blind refuses a judge other than 1, 2 or 3, an ungraded run, and a judge folder made before', () => {
  const iteration = gradedIteration();
  const ungraded = `${iteration}/eval-garden-seed-sonnet/new_skill/run-2`;
  mkdirSync(`${ungraded}/outputs`, { recursive: true });
  blind(iteration, 'garden-seed', 1, [`${iteration}/eval-garden-seed-sonnet/old_skill/run-1`]);

  assert.throws(() => {
    blind(iteration, 'garden-seed', 4, []);
  }, /the judge is 1, 2 or 3, not 4/);
  assert.throws(() => {
    blind(iteration, 'garden-seed', 2, [ungraded]);
  }, /grade these runs with eval-grade.ts first: .*run-2/);
  assert.throws(() => {
    blind(iteration, 'garden-seed', 1, []);
  }, /judge-garden-seed-1 exists/);
});

test('unblind copies each letter verdicts back to its run as that judge verdict file, and refuses a missing one', () => {
  const iteration = gradedIteration();
  blind(iteration, 'garden-seed', 2, [`${iteration}/eval-garden-seed-sonnet/old_skill/run-1`]);
  const judgeFolder = `${iteration}/judge-garden-seed-2`;

  assert.throws(() => {
    unblind(iteration, 'garden-seed', 2);
  }, /no llm-grades.json/);

  writeFileSync(`${judgeFolder}/a/llm-grades.json`, verdicts);
  unblind(iteration, 'garden-seed', 2);

  assert.deepEqual(
    [
      readFileSync(`${iteration}/eval-garden-seed-sonnet/old_skill/run-1/llm-grades-2.json`, 'utf8'),
      existsSync(`${iteration}/eval-garden-seed-sonnet/new_skill/run-1/llm-grades-2.json`),
    ],
    [verdicts, false],
  );
});

const verdicts = JSON.stringify([{ text: 'Judged.', passed: true, evidence: 'call 1' }]);

test('unblind refuses verdicts whose texts are not exactly the judged assertions, so none goes unjudged', () => {
  const iteration = gradedIteration();
  blind(iteration, 'garden-seed', 1, [`${iteration}/eval-garden-seed-sonnet/new_skill/run-1`]);
  writeFileSync(
    `${iteration}/judge-garden-seed-1/a/llm-grades.json`,
    JSON.stringify([{ text: 'Judged', passed: true, evidence: 'call 1' }]),
  );

  assert.throws(() => {
    unblind(iteration, 'garden-seed', 1);
  }, /a: the verdicts are not the judged assertions/);
});
