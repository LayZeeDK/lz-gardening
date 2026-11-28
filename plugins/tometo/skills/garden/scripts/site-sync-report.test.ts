import assert from 'node:assert/strict';
import { test } from 'node:test';
import { censusRef, pendingCensusRef, writePendingCensus } from './store-census.ts';
import { commit, git } from './test-repo.ts';
import {
  anotherSyncMovesTheCensusFirst,
  bareRemote,
  censusText,
  planted,
  sharedPair,
  site,
  writeCensusText,
} from './test-site.ts';
import { addWeed, cli, tendedBed } from './test-weeds.ts';

test('sync --census says the census stays local when no branch fetched from origin holds its commit', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  const sha = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));

  const synced = site(dir, ['sync', '--census', sha]);

  assert.deepEqual(
    [synced.status, synced.stderr],
    [0, `site: the census of ${sha} stays local: no branch fetched from origin holds that commit\n`],
  );
});

test('sync says a site census that is not a census stays local, and how to replace it', (t) => {
  const { dir, garden } = planted(t);
  bareRemote(dir);
  writeCensusText(garden, '{"rev":"main"}\n');

  const synced = site(dir, ['sync']);

  assert.deepEqual(
    [synced.status, synced.stderr],
    [
      0,
      `site: the site's ${censusRef} is not a census, so it stays local; delete it in the site (git update-ref -d ${censusRef}), and the next tick records a new one\n`,
    ],
  );
});

test('sync --census says the census stays pending when another sync of the site moved the census first', (t) => {
  const { dir, garden } = planted(t);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  writePendingCensus({ path: garden, checkout: dir }, sha, censusText(sha));
  const other = commit(dir, { 'src/b.ts': 'export const b = 2;\n' });
  writePendingCensus({ path: garden, checkout: dir }, other, censusText(other));
  anotherSyncMovesTheCensusFirst(t, garden, git(garden, ['rev-parse', pendingCensusRef(other)]));

  const synced = site(dir, ['sync', '--census', sha]);

  assert.deepEqual(
    [synced.status, synced.stderr],
    [0, `site: another sync moved the census first; the census of ${sha} stays pending for the next sync\n`],
  );
});

function claimAnyType(dir: string): void {
  addWeed(dir, 'src/a.ts:1');
  const claimed = cli(dir, ['claim', '--class', 'any-type']);
  assert.equal(claimed.status, 0, claimed.stderr);
}

test('open says which claim its sync gave back, and who holds the class', (t) => {
  const { first, second } = sharedPair(t);
  git(second.dir, ['config', 'tometo.share', 'false']);
  claimAnyType(second.dir);
  git(second.dir, ['config', 'tometo.share', 'true']);
  claimAnyType(first.dir);
  const holder = `writer ${git(first.garden, ['config', 'tometo.writer']).slice(0, 8)}`;

  const opened = site(second.dir, ['open', '--base', 'main']);

  assert.deepEqual([opened.status, opened.stderr], [0, `site: gave back the claim of any-type; ${holder} holds it\n`]);
});

test("sync names a bed it left out because the bed does not descend from origin's bed", (t) => {
  const { dir } = tendedBed(t, { 'checks/any-type.mjs': 'export {};\n' });
  const remote = bareRemote(dir);
  // The base moved on after the bed was made, so the bed does not descend from it.
  git(dir, ['push', '-q', remote, 'main:refs/garden/beds/any-type']);

  const synced = site(dir, ['sync']);

  assert.deepEqual(
    [synced.status, synced.stderr],
    [0, "site: any-type: bed/any-type does not descend from origin's bed\n"],
  );
});
