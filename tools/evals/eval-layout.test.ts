import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readIteration } from './eval-layout.ts';

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

test('readIteration refuses a file without configs, models or runs, or a configuration without a plugin', () => {
  const broken = [
    { configs: {}, models: ['sonnet'], runs: 1 },
    { configs: { new_skill: {} }, models: ['sonnet'], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, models: [], runs: 1 },
    { configs: { new_skill: { plugin: 'p' } }, models: ['sonnet'] },
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
