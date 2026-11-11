// Run: node --test weeds-no-label.test.ts
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commit, git } from './test-repo.ts';
import { cli, editCheckByHand, recordCensus, tendedBed } from './test-weeds.ts';
import { weedId } from './weeds.ts';

test('a census the label cannot read leaves a regrown weed queued and listed, without the label', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  writeFileSync(join(garden, '.garden', 'census.json'), '{ not json');

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);
  const listed = cli(garden, ['list', '--class', 'any-type'], dir);

  const id = weedId('any-type', 'src/b.ts:1', 'commit:ccc3333');
  assert.deepEqual(
    [back.code, back.stdout, listed.code, listed.stdout],
    [
      0,
      `regrown ${id} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
      0,
      `${id} any-type src/b.ts:1 [commit:ccc3333] [regrown after bed/any-type@${tip} (check: checks/any-type.test.mjs)] \n`,
    ],
  );
});

test('a check emptied by hand in the queue gets no label, since it names no file', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  editCheckByHand(garden, '');

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: )\n`,
  );
});

test('a check given a control character by hand in the queue gets no label, rather than failing the add', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  editCheckByHand(garden, 'checks/any\u0000type.test.mjs');

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.deepEqual(
    [back.code, back.stdout],
    [
      0,
      `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any\u0000type.test.mjs)\n`,
    ],
  );
});

test('a check that names no file at the bed commit gets no label, since nothing says where it lives', (t) => {
  const { dir, garden, tip } = tendedBed(
    t,
    { 'checks/any-type.test.mjs': 'export {};\n' },
    'checks/any-type.test.mjs:1',
  );

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs:1)\n`,
  );
});

test('a census whose commit is not a commit id gets no label, rather than reaching git as an option', (t) => {
  const check = { 'checks/any-type.test.mjs': 'export {};\n' };
  const { dir, garden, tip } = tendedBed(t, check);
  commit(dir, check);
  recordCensus(garden, '--octopus');

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});

test('a census commit that is a branch name, even one shaped like a commit id, gets no label', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  const branches = [`${'a'.repeat(40)}x`, `x${'a'.repeat(40)}`, 'a', 'z'.repeat(64)];

  const labels = branches.map((branch, line) => {
    git(dir, ['branch', branch]);
    recordCensus(garden, branch);
    const where = `src/b.ts:${String(line + 1)}`;

    return cli(garden, ['add', '--class', 'any-type', '--where', where, '--source', 'commit:ccc3333'], dir).stdout;
  });

  assert.deepEqual(
    labels,
    branches.map(
      (_, line) =>
        `regrown ${weedId('any-type', `src/b.ts:${String(line + 1)}`, 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
    ),
  );
});

test('a census commit the checkout does not hold gets no label, since nothing shows the check missing from it', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  recordCensus(garden, 'f'.repeat(40));

  const back = cli(garden, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], dir);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});
