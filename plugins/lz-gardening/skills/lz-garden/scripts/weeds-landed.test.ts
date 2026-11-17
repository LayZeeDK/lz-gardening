// Run: node --test weeds-landed.test.ts
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { commit, repo } from './test-repo.ts';
import { site, writeCensus } from './test-site.ts';
import { cli, eslintConfig, tendedBed } from './test-weeds.ts';
import { parseEvent, weedId } from './log.ts';
import type { TendedClose } from './log.ts';
import { logFiles } from './test-log.ts';
import { offBaseIn } from './weeds-landed.ts';

test('a weed that comes back before its bed lands names the check as not on the base', (t) => {
  const { dir, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs not on the base)\n`,
  );
});

test('a weed that comes back in a run with GIT_DIR naming another repository still names the check as not on the base', (t) => {
  const { dir, tip } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  const other = repo(t);

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333'], {
    ...process.env,
    GIT_DIR: join(other, '.git'),
  });

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

test('a close with two checks is not on the base while one of its check files has not landed', (t) => {
  const landedCheck = { 'checks/a.test.mjs': 'export {};\n' };
  const { dir, garden, tip } = tendedBed(t, { ...landedCheck, 'checks/b.test.mjs': 'export const b = 1;\n' }, [
    'checks/a.test.mjs',
    'checks/b.test.mjs',
  ]);
  writeCensus(garden, commit(dir, landedCheck));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/a.test.mjs, checks/b.test.mjs not on the base)\n`,
  );
});

test("add --census judges the check at this tick's census, so a bed that landed since the garden's census is on the base", (t) => {
  const check = { 'checks/any-type.test.mjs': 'export {};\n' };
  const { dir, tip } = tendedBed(t, check);
  const landed = commit(dir, check);

  const back = cli(dir, [
    'add',
    '--class',
    'any-type',
    '--where',
    'src/b.ts:1',
    '--source',
    'commit:ccc3333',
    '--census',
    landed,
  ]);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/b.ts:1', 'commit:ccc3333')} after bed/any-type@${tip} (check: checks/any-type.test.mjs)\n`,
  );
});

test('a regrown weed whose check git cannot judge exits 2 and is not added', (t) => {
  const { dir } = tendedBed(t, {
    'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n",
  });
  const realSpawnSync = childProcess.spawnSync;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs, options] = args;

    return Array.isArray(gitArgs) && gitArgs.includes('patch-id')
      ? Reflect.apply(realSpawnSync, childProcess, ['git', ['patch-id', '--no-such-option'], options])
      : Reflect.apply(realSpawnSync, childProcess, args);
  });
  syncBuiltinESMExports();

  const failed = cli(dir, ['add', '--class', 'any-type', '--where', 'src/b.ts:1', '--source', 'commit:ccc3333']);
  spawned.mock.restore();
  syncBuiltinESMExports();

  assert.deepEqual([failed.status, failed.stdout, cli(dir, ['list', '--class', 'any-type']).stdout], [2, '', '']);
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
  cli(dir, ['claim', '--class', 'any-type']);
  assert.equal(site(dir, ['bed', '--class', 'any-type', '--base', 'main']).status, 0);
  const fix = { 'src/b.ts': 'export const b: number = 1;\n' };
  const tip = commit(bed, fix);
  cli(dir, ['claim', '--class', 'any-type']);
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
  cli(dir, ['claim', '--class', 'any-type']);
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
  cli(dir, ['claim', '--class', 'any-type']);
  cli(dir, ['close-class', '--class', 'any-type', '--tended', `bed/any-type@${tip}`, '--check', 'eslint.config.mjs']);
  writeCensus(garden, commit(dir, first));

  const back = cli(dir, ['add', '--class', 'any-type', '--where', 'src/c.ts:1', '--source', 'commit:ddd4444']);

  assert.equal(
    back.stdout,
    `regrown ${weedId('any-type', 'src/c.ts:1', 'commit:ddd4444')} after bed/any-type@${tip} (check: eslint.config.mjs not on the base)\n`,
  );
});

test('the same tended close read again, as a retried append reads it, is judged once', (t) => {
  const { dir, garden } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  const [path = '', event] = [...logFiles(garden)].find(([, file]) => file['kind'] === 'tended') ?? [];
  const readAgain = (): TendedClose => {
    const read = parseEvent(path, JSON.stringify(event));
    assert.ok(typeof read !== 'string' && read.op === 'close' && read.kind === 'tended');

    return read;
  };
  const offBase = offBaseIn(dir, garden, undefined);
  const first = offBase(readAgain());
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  const again = offBase(readAgain());

  assert.deepEqual([first, again, spawned.mock.callCount()], ['not on the base', 'not on the base', 0]);
});

test('judging a check starts every git as a read, with none of the settings a write takes', (t) => {
  const { dir, garden } = tendedBed(t, {
    'eslint.config.mjs': "export default [{ rules: { 'no-explicit-any': 'error' } }];\n",
  });
  const [path = '', event] = [...logFiles(garden)].find(([, file]) => file['kind'] === 'tended') ?? [];
  const tended = parseEvent(path, JSON.stringify(event));
  assert.ok(typeof tended !== 'string' && tended.op === 'close' && tended.kind === 'tended');
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  const label = offBaseIn(dir, garden, undefined)(tended);

  const started = spawned.mock.calls.map(({ arguments: [, args] }) =>
    Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [],
  );
  assert.deepEqual(
    [label, started.length > 0, started.filter((args) => args.includes('-c'))],
    ['not on the base', true, []],
  );
});

test('two tended closes of one bed with different checks are judged each by its own check', (t) => {
  const { dir, garden } = tendedBed(t, { 'checks/any-type.test.mjs': 'export {};\n' });
  const [path = '', event] = [...logFiles(garden)].find(([, file]) => file['kind'] === 'tended') ?? [];
  const closeWith = (check: string): TendedClose => {
    const read = parseEvent(path, JSON.stringify({ ...event, check }));
    assert.ok(typeof read !== 'string' && read.op === 'close' && read.kind === 'tended');

    return read;
  };
  const offBase = offBaseIn(dir, garden, undefined);

  assert.deepEqual(
    [offBase(closeWith('checks/any-type.test.mjs')), offBase(closeWith('checks/not-in-the-bed.test.mjs'))],
    ['not on the base', 'no label'],
  );
});
