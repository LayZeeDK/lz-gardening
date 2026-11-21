import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gradedRuns, isAssertion, readIteration } from './eval-layout.ts';

function iterationWith(description: unknown): string {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-layout-'));
  writeFileSync(join(iteration, 'iteration.json'), JSON.stringify(description));

  return iteration;
}

test('readIteration gives the configurations in file order with absolute plugin paths, the models and the runs', () => {
  const iteration = iterationWith({
    configs: { new_skill: { plugin: 'plugins/new', commit: 'abc' }, old_skill: { plugin: 'D:/old' } },
    models: ['sonnet', 'opus'],
    runs: 2,
  });

  assert.deepEqual(readIteration(iteration), {
    configs: {
      new_skill: resolve('plugins/new').replaceAll('\\', '/'),
      old_skill: resolve('D:/old').replaceAll('\\', '/'),
    },
    models: ['sonnet', 'opus'],
    runs: 2,
  });
});

test('isAssertion takes a text with an optional script check name and nothing else', () => {
  const values = [{ text: 'a' }, { text: 'a', check: 'c' }, { text: 1 }, { text: 'a', check: 2 }, { check: 'c' }, 'a'];

  assert.deepEqual(
    values.map((value) => isAssertion(value)),
    [true, true, false, false, false, false],
  );
});

test('gradedRuns lists the graded run folders of every eval folder and configuration, with their run numbers', () => {
  const iteration = mkdtempSync(join(tmpdir(), 'eval-layout-'));
  const graded = ['eval-tend-opus/new_skill/run-2', 'eval-tend-opus/old_skill/run-1'];
  [...graded, 'eval-tend-opus/new_skill/run-3'].forEach((run) => {
    mkdirSync(join(iteration, run), { recursive: true });
  });
  graded.forEach((run) => {
    writeFileSync(join(iteration, run, 'grading.json'), '{}');
  });

  assert.deepEqual(gradedRuns(iteration), [
    { evalName: 'eval-tend-opus', config: 'new_skill', run: 2, runDir: join(iteration, graded[0] ?? '') },
    { evalName: 'eval-tend-opus', config: 'old_skill', run: 1, runDir: join(iteration, graded[1] ?? '') },
  ]);
});

test('readIteration refuses a file without configs, models or runs, or a configuration without a plugin', () => {
  const broken = [
    { configs: {}, models: ['sonnet'], runs: 1 },
    { configs: { new_skill: {} }, models: ['sonnet'], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, models: [], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, models: ['sonnet'] },
    { configs: { new_skill: { plugin: 'p' }, old_skill: {} }, models: ['sonnet'], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, models: ['sonnet', 4], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, runs: 1 },
  ];

  assert.deepEqual(
    broken.filter((description) => {
      try {
        readIteration(iterationWith(description));

        return true;
      } catch {
        return false;
      }
    }),
    [],
  );
});
