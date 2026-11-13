// Run: node --test store-claims.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claimLifetimeMs } from './log.ts';
import { append, openSite, sync } from './store.ts';
import { logFiles } from './test-log.ts';
import { git } from './test-repo.ts';
import { planted, sharedPair, site } from './test-site.ts';
import { cli, cliWith as claimWith, now, script } from './test-weeds.ts';

function addWeed(dir: string, where: string, weedClass = 'any-type'): void {
  const added = cli(dir, ['add', '--class', weedClass, '--where', where, '--source', 'census:x']);
  assert.equal(added.code, 0, added.stderr);
}

function liveClaimWriters(gitDir: string, reader = now): readonly unknown[] {
  const events = [...logFiles(gitDir).values()];
  const released = new Set(events.filter((event) => event['op'] === 'release').map((event) => event['claim']));

  return events
    .filter((event) => event['op'] === 'claim' && !released.has(event['uuid']))
    .filter((event) => typeof event['until'] === 'string' && Date.parse(event['until']) > reader.getTime())
    .map((event) => event['writer']);
}

function writerOf(dir: string): string {
  return openSite(dir).writer;
}

function racedPair(t: Parameters<typeof sharedPair>[0]) {
  const pair = sharedPair(t);
  const { first, second, remote } = pair;
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  sync(openSite(second.dir), { attempts: 1 });
  const staleMirror = join(dirname(second.dir), 'mirror.git');
  git(dirname(second.dir), ['init', '-q', '--bare', staleMirror]);
  git(remote, ['push', '-q', staleMirror, 'refs/garden/*:refs/garden/*']);
  git(second.dir, ['remote', 'set-url', 'origin', staleMirror]);
  git(second.dir, ['remote', 'set-url', '--push', 'origin', remote]);
  const catchUp = (): void => {
    git(remote, ['push', '-q', '--force', staleMirror, 'refs/garden/*:refs/garden/*']);
  };

  return { ...pair, catchUp };
}

function racedTrio(t: Parameters<typeof sharedPair>[0]) {
  const raced = racedPair(t);
  const third = planted(t);
  git(third.dir, ['remote', 'add', 'origin', raced.remote]);

  return { ...raced, third };
}

function claimProcess(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'claim', '--class', 'any-type'], { cwd });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(stdout);
    });
  });
}

test('two claim processes started together against one origin: one prints claimed, the other taken, in each of 5 rounds', async (t) => {
  const rounds: (readonly unknown[])[] = [];

  for (let round = 0; round < 5; round += 1) {
    const { first, second, remote } = sharedPair(t);
    addWeed(first.dir, 'src/a.ts:1');
    sync(openSite(first.dir), { attempts: 1 });

    const said = await Promise.all([claimProcess(first.dir), claimProcess(second.dir)]);

    rounds.push([said.map((line) => line.split(' ')[0]).sort(), liveClaimWriters(remote, new Date()).length]);
  }

  assert.deepEqual(
    rounds,
    Array.from({ length: 5 }, () => [['claimed', 'taken'], 1]),
  );
});

test('a claim whose push loses to another writer that claimed first, on the merge path, yields and prints taken', (t) => {
  const { first, second, remote, catchUp } = racedPair(t);
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  addWeed(second.dir, 'src/b.ts:1');

  const claimed = claimWith(second.dir, ['claim', '--class', 'any-type'], { wait: catchUp });

  assert.deepEqual(
    [claimed.code, claimed.stdout, liveClaimWriters(remote)],
    [1, 'taken any-type by test until 2026-11-07T18:00:00.000Z\n', [writerOf(first.dir)]],
  );
});

test('a claim that yields on its first attempt and lands on a later one prints taken, from the replay', (t) => {
  const { first, second, third, remote, catchUp } = racedTrio(t);
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const waits: number[] = [];

  const claimed = claimWith(second.dir, ['claim', '--class', 'any-type'], {
    wait: (ms) => {
      waits.push(ms);
      catchUp();

      if (waits.length === 1) {
        addWeed(third.dir, 'src/third.ts:1');
        sync(openSite(third.dir), { attempts: 1 });
      }
    },
  });

  assert.deepEqual(
    [claimed.code, claimed.stdout, waits.length, liveClaimWriters(remote)],
    [1, 'taken any-type by test until 2026-11-07T18:00:00.000Z\n', 2, [writerOf(first.dir)]],
  );
});

function crashedClaim(dir: string, at: Date): void {
  const crashed = openSite(dir);
  const until = new Date(at.getTime() + claimLifetimeMs).toISOString();
  append(
    crashed,
    () => ({
      drafts: [{ op: 'claim', class: 'any-type', writer: crashed.writer, holder: 'crashed', until }],
      result: undefined,
    }),
    at,
  );
}

test('a claim appended and never pushed is given back by the next open once another writer claimed the class', (t) => {
  const { first, second, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  sync(openSite(second.dir), { attempts: 1 });
  crashedClaim(second.dir, new Date());
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type']).code, 0);

  const opened = site(second.dir, ['open', '--base', 'main']);

  assert.deepEqual(
    [opened.status, opened.stderr, liveClaimWriters(remote, new Date())],
    [0, 'site: gave back the claim of any-type; test holds it\n', [writerOf(first.dir)]],
  );
});

test('a claim appended and never pushed of a class nobody else claimed is pushed by the next open', (t) => {
  const { first, remote } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  crashedClaim(first.dir, new Date());

  const opened = site(first.dir, ['open', '--base', 'main']);

  assert.deepEqual(
    [opened.status, opened.stderr, liveClaimWriters(remote, new Date())],
    [0, '', [writerOf(first.dir)]],
  );
});

function twoReadyClasses(dir: string): void {
  ['src/a.ts:1', 'src/b.ts:1', 'src/c.ts:1'].forEach((where) => {
    addWeed(dir, where);
  });
  ['src/d.ts:1', 'src/e.ts:1'].forEach((where) => {
    addWeed(dir, where, 'other');
  });
}

test('claim with no class, losing the first ready class to another writer in a race, claims the next ready one', (t) => {
  const { first, second, catchUp } = racedPair(t);
  twoReadyClasses(first.dir);
  sync(openSite(first.dir), { attempts: 1 });
  catchUp();
  sync(openSite(second.dir), { attempts: 1 });
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);

  const claimed = claimWith(second.dir, ['claim'], { wait: catchUp });

  assert.deepEqual([claimed.code, claimed.stdout], [0, 'claimed other until 2026-11-07T18:00:00.000Z\n']);
});

test("claim with no class whose first sync fetches another writer's claim of the first ready class claims the next one", (t) => {
  const { first, second } = sharedPair(t);
  twoReadyClasses(first.dir);
  sync(openSite(first.dir), { attempts: 1 });
  sync(openSite(second.dir), { attempts: 1 });
  assert.equal(cli(first.dir, ['claim'], process.env, now).stdout, 'claimed any-type until 2026-11-07T18:00:00.000Z\n');

  const claimed = cli(second.dir, ['claim'], process.env, now);

  assert.deepEqual([claimed.code, claimed.stdout], [0, 'claimed other until 2026-11-07T18:00:00.000Z\n']);
});

test('a claim whose until has passed lets another writer claim the class', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  const afterUntil = new Date(now.getTime() + claimLifetimeMs);

  const claimed = cli(second.dir, ['claim', '--class', 'any-type'], process.env, afterUntil);

  assert.deepEqual([claimed.code, claimed.stdout], [0, 'claimed any-type until 2026-11-08T00:00:00.000Z\n']);
});

test('release --class by the holder pushes the release, says so, and another site can then claim the class', (t) => {
  const { first, second } = sharedPair(t);
  addWeed(first.dir, 'src/a.ts:1');
  sync(openSite(first.dir), { attempts: 1 });
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);

  const released = cli(first.dir, ['release', '--class', 'any-type'], process.env, now);
  const claimed = cli(second.dir, ['claim', '--class', 'any-type'], process.env, now);

  assert.deepEqual(
    [released.code, released.stdout, claimed.stdout],
    [0, 'released any-type; synced\n', 'claimed any-type until 2026-11-07T18:00:00.000Z\n'],
  );
});

test("spike 2's control: with the look turned off, the losing claim stays live on the origin beside the winner", (t) => {
  const { first, second, remote, catchUp } = racedPair(t);
  assert.equal(cli(first.dir, ['claim', '--class', 'any-type'], process.env, now).code, 0);
  addWeed(second.dir, 'src/b.ts:1');

  claimWith(second.dir, ['claim', '--class', 'any-type'], { wait: catchUp, look: () => [] });

  assert.deepEqual(new Set(liveClaimWriters(remote)), new Set([writerOf(first.dir), writerOf(second.dir)]));
});
