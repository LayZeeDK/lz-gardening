// Run: node --test weeds-no-label.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commit, git } from './test-repo.ts';
import { writeCensus, writeCensusText } from './test-site.ts';
import { cli, editCheckByHand, tendedBed } from './test-weeds.ts';
import { weedId } from './log.ts';

test('a census the label cannot read leaves a regrown weed queued and listed, without the label', (t) => {
  const { dir, garden, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  writeCensusText(garden, '{ not json');

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);
  const listed = cli(dir, ['list', '--class', 'any-type']);

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

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: )\n`,
  );
});

test('a tend close whose check was given a control character by hand is skipped and named, so the weed comes back added', (t) => {
  const { dir, garden } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  editCheckByHand(garden, 'checks/any\u0000type.test.mjs');

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.match(back.stderr, /^weeds: skipped events\/.+\.json: check holds a line break or control character\n$/);
  assert.deepEqual([back.code, back.stdout], [0, `added ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')}\n`]);
});

test('a check that names no file at the bed commit gets no label, since nothing says where it lives', (t) => {
  const { dir, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' }, 'checks/any-type.test.mjs:1');

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs:1)\n`,
  );
});

test('a census whose commit is not a commit id gets no label, rather than reaching git as an option', (t) => {
  const check = { 'checks/any-type.test.mjs': 'export {};\n' };
  const { dir, garden, tip } = tendedBed(t, check);
  commit(dir, check);
  writeCensus(garden, '--octopus');

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

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
    writeCensus(garden, branch);
    const where = `src/b.ts:${String(line + 1)}`;

    return cli(dir, ['add', '--class', 'any-type', '--where', where, '--source', 'commit:ccc3333']).stdout;
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
  writeCensus(garden, 'f'.repeat(40));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});
