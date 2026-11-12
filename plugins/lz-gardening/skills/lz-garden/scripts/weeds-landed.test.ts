// Run: node --test weeds-landed.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commit } from './test-repo.ts';
import { site, writeCensus } from './test-site.ts';
import { cli, eslintConfig, tendedBed } from './test-weeds.ts';
import { weedId } from './log.ts';

test('a weed that comes back before its bed lands names the check as not on the base', (t) => {
  const { dir, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs not on the base)\n`,
  );
});

test('a check added to a file the base already has is not on the base until the bed lands', (t) => {
  const { dir, tip } = tendedBed(t, {
    'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n",
  });

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('a new check file on the base is on the base, though its bed landed by squash and is no ancestor', (t) => {
  const check = { 'checks/any-type.test.mjs': 'export {};\n' };
  const { dir, garden, tip } = tendedBed(t, check);
  const landed = commit(dir, check);
  writeCensus(garden, landed);

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});

test('a check added to a file the base already has is on the base once its bed lands by squash', (t) => {
  const check = { 'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n" };
  const { dir, garden, tip } = tendedBed(t, check);
  const landed = commit(dir, check);
  writeCensus(garden, landed);

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a check the base already held when the bed was made is on the base, whatever the bed changed', (t) => {
  const { dir, tip } = tendedBed(t, { 'src/a.ts': 'export const a: number = 1;\n' }, 'eslint.config.mjs');

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a bed tended a second time, with the base merged in, is on the base once it lands by squash', (t) => {
  const check = { 'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n" };
  const { dir, garden, bed } = tendedBed(t, check);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);
  site(dir, ['bed', '--class', 'any-type', '--base', 'main']);
  const fix = { 'src/b.ts': 'export const b: number = 1;\n' };
  const tip = commit(bed, fix);
  cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs']);
  const landed = commit(dir, { ...check, ...fix });
  writeCensus(garden, landed);

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('list names the check of a regrown weed as not on the base while its bed has not landed', (t) => {
  const { dir, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333', '--note', 'cast']);

  assert.equal(
    cli(dir, ['list', '--class', 'any-type']).stdout,
    `${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} any-type src/b.ts:1 [commit:ccc3333] [regrown after bed/any-type@${tip} (check: checks/any-type.test.mjs not on the base)] cast\n`,
  );
});

test('a bed that lands by squash after the base edited a line beside its check is on the base', (t) => {
  const rule = "{ 'no-explicit-any': 'error' }";
  const { dir, garden, tip } = tendedBed(t, { 'eslint.config.mjs': eslintConfig("['src/**']", rule) });
  commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**/*.ts']", '{}') });
  writeCensus(garden, commit(dir, { 'eslint.config.mjs': eslintConfig("['src/**/*.ts']", rule) }));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a bed that changed its check in two commits is on the base once both land by rebase', (t) => {
  const first = { 'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }") };
  const second = {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error', 'no-unsafe-cast': 'error' }"),
  };
  const { dir, garden, bed } = tendedBed(t, first);
  const tip = commit(bed, second);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);
  cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs']);
  commit(dir, first);
  writeCensus(garden, commit(dir, second));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs)\n`,
  );
});

test('a bed that changed its check in two commits is not on the base while only the first has landed', (t) => {
  const first = { 'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error' }") };
  const second = {
    'eslint.config.mjs': eslintConfig("['src/**']", "{ 'no-explicit-any': 'error', 'no-unsafe-cast': 'error' }"),
  };
  const { dir, garden, bed } = tendedBed(t, first);
  const tip = commit(bed, second);
  cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);
  cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs']);
  writeCensus(garden, commit(dir, first));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});
