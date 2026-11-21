import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
  writeFileSync(`${evalFolder}/eval_metadata.json`, '{"eval_id":0,"assertions":[]}');

  for (const [config, plugin] of Object.entries(plugins)) {
    const outputs = `${evalFolder}/${config}/run-1/outputs`;
    mkdirSync(outputs, { recursive: true });
    writeFileSync(`${outputs}/result.json`, JSON.stringify({ cwd: `S:/samples/it-${String(config.length)}`, ms: 1 }));
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

  assert.deepEqual(
    [
      letters,
      texts.filter((text) => /new_skill|old_skill|wt-1|wt-2/.test(text)),
      texts.filter((text) => text.includes('"site"')).length,
      existsSync(`${iteration}/judge-garden-seed-1.key.json`),
    ],
    [['a', 'b'], [], 2, true],
  );
});

test('unblind copies each letter verdicts back to its run as that judge verdict file, and refuses a missing one', () => {
  const iteration = gradedIteration();
  blind(iteration, 'garden-seed', 2, [`${iteration}/eval-garden-seed-sonnet/old_skill/run-1`]);
  const judgeFolder = `${iteration}/judge-garden-seed-2`;

  assert.throws(() => {
    unblind(iteration, 'garden-seed', 2);
  }, /no llm-grades.json/);

  writeFileSync(`${judgeFolder}/a/llm-grades.json`, '[]');
  unblind(iteration, 'garden-seed', 2);

  assert.deepEqual(
    [
      readFileSync(`${iteration}/eval-garden-seed-sonnet/old_skill/run-1/llm-grades-2.json`, 'utf8'),
      existsSync(`${iteration}/eval-garden-seed-sonnet/new_skill/run-1/llm-grades-2.json`),
    ],
    ['[]', false],
  );
});
