import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { eventPath, weedId } from './log.ts';
import type { EventDraft } from './log.ts';
import { configValue, gitAsync, gitEnv, inRun, namedHooksOff, runGit, runGitAsync, treeEntries } from './store-git.ts';
import { append, logRef, openSite, plantWriter, readLog, startLog } from './store-log.ts';
import { git, repo } from './test-repo.ts';
import { configEnv, planted, scriptProcess } from './test-site.ts';
import { writeEntriesToLogByHand, writeToLogByHand } from './test-log.ts';
import { cli, cliProcess, now, script } from './test-weeds.ts';

async function exitOf(cwd: string, args: readonly string[]): Promise<number | null> {
  return (await scriptProcess(script, cwd, args)).code;
}

function addDraft(index: number, note = ''): EventDraft {
  const where = `src/${String(index)}.ts:1`;

  return {
    op: 'add',
    id: weedId('any-type', where, 'census:x'),
    class: 'any-type',
    where,
    source: 'census:x',
    note,
    layer: null,
    sawCloses: [],
    sawTend: null,
  };
}

test('weeds added by several processes at once all land in the log', async (t) => {
  const { dir } = planted(t);
  const wheres = Array.from({ length: 6 }, (_, index) => `src/${String(index)}.ts:1`);

  const codes = await Promise.all(
    wheres.map((where) => exitOf(dir, ['add', '--class', 'any-type', '--where', where, '--source', 'census:x'])),
  );

  assert.deepEqual(
    [
      codes,
      cli(dir, ['list'])
        .stdout.trimEnd()
        .split('\n')
        .map((line) => line.split(' ')[2])
        .sort(),
    ],
    [wheres.map(() => 0), wheres.toSorted()],
  );
});

test('a log holding more than 1 MiB of events still reads', (t) => {
  const { dir } = planted(t);
  const site = openSite(dir);
  const note = 'x'.repeat(200 * 1024);
  append(site, () => ({ drafts: Array.from({ length: 6 }, (_, index) => addDraft(index, note)) }), now);

  assert.equal(readLog(site).events.length, 6);
});

test("an async git read gives git's trimmed output and exit code, fails with the command and git's reason, and fails in a missing folder", async (t) => {
  const dir = repo(t);
  const env = inRun(process.env, () => gitEnv(dir));

  const results = await Promise.all([
    gitAsync(dir, ['rev-parse', '--is-inside-work-tree'], env),
    runGitAsync(dir, ['cat-file', '-e', 'no-such-object'], env).then(({ code, stdout }) => [code, stdout]),
    gitAsync(dir, ['cat-file', '-e', 'no-such-object'], env).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    ),
  ]);

  assert.deepEqual(results.slice(0, 2), ['true', [128, '']]);
  assert.match(results[2], /^git cat-file -e no-such-object: fatal: \S[^\n]*$/);
  await assert.rejects(runGitAsync(join(dir, 'missing'), ['status'], env), { code: 'ENOENT' });
});

test('a submodule entry in the log is skipped and named, and the events beside it still read', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  append(site, () => ({ drafts: [addDraft(1)] }), now);
  writeEntriesToLogByHand(garden, [`160000 ${'1'.repeat(40)}\tevents/50/sub`]);
  const replica = readLog(site);

  assert.deepEqual(
    [replica.events.length, replica.skipped],
    [1, [{ path: 'events/50/sub', why: 'a commit, not a file' }]],
  );
});

test('an event file whose object the site does not hold is skipped and named, and the events beside it still read', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  append(site, () => ({ drafts: [addDraft(1)] }), now);
  writeEntriesToLogByHand(garden, [`100644 ${'1'.repeat(40)}\tevents/50/absent.json`]);
  const replica = readLog(site);

  assert.deepEqual(
    [replica.events.length, replica.skipped],
    [1, [{ path: 'events/50/absent.json', why: 'missing from the site' }]],
  );
});

test('an append to a log naming an event file the site does not hold lands, and keeps naming that file', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  writeEntriesToLogByHand(garden, [`100644 ${'1'.repeat(40)}\tevents/50/absent.json`]);

  append(site, () => ({ drafts: [addDraft(1)] }), now);
  const replica = readLog(site);

  assert.deepEqual(
    [replica.events.length, replica.skipped],
    [1, [{ path: 'events/50/absent.json', why: 'missing from the site' }]],
  );
});

test('an event file git cannot read stops the read with the error git gives', (t) => {
  const { dir, garden } = planted(t);
  const text = '{}';
  writeToLogByHand(garden, 'events/50/broken.json', text);
  const oid = createHash('sha1')
    .update(`blob ${String(text.length)}\0${text}`)
    .digest('hex');
  const object = join(garden, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, deflateSync(`bogus ${String(text.length)}\0${text}`));

  assert.throws(() => readLog(openSite(dir)), { message: /^git cat-file --batch: fatal: invalid object type$/ });
});

test('an append on a log holding the largest clock a whole number allows is refused, and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const uuid = '0f3c2a6e-1b2d-4c5e-8f90-a1b2c3d4e5f6';
  const top = { ...addDraft(1), uuid, clock: Number.MAX_SAFE_INTEGER, at: now.toISOString() };
  writeToLogByHand(garden, eventPath(uuid), JSON.stringify(top));
  const tip = git(garden, ['rev-parse', logRef]);

  assert.throws(() => append(site, () => ({ drafts: [addDraft(2)] }), now), {
    message: `${logRef} holds clock 9007199254740991; the next clock would pass the largest whole number`,
  });
  assert.equal(git(garden, ['rev-parse', logRef]), tip);
});

test('an append of an event its own reader would skip is refused with the reason, and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const tip = git(garden, ['rev-parse', logRef]);

  assert.throws(() => append(site, () => ({ drafts: [{ ...addDraft(1), layer: 7 }] }), now), {
    message: 'an event to append would be skipped by every reader: layer is not a whole number from 1 to 6',
  });
  assert.equal(git(garden, ['rev-parse', logRef]), tip);
});

test('a recursive tree listing as every git version prints it reads as each entry type, object and path', () => {
  const listed = `160000 commit ${'1'.repeat(40)}\tevents/50/sub\u0000100644 blob ${'2'.repeat(40)}\tevents/ab/a b.json\u0000`;

  assert.deepEqual(treeEntries(listed), [
    { type: 'commit', oid: '1'.repeat(40), path: 'events/50/sub' },
    { type: 'blob', oid: '2'.repeat(40), path: 'events/ab/a b.json' },
  ]);
});

function moveLog(garden: string): string {
  const tip = git(garden, ['rev-parse', logRef]);
  const moved = git(garden, ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'moved']);
  git(garden, ['update-ref', logRef, moved]);

  return moved;
}

test('an append whose log another writer moves after the read plans again on the moved log', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const plannedOn: string[] = [];
  let moved = '';

  append(
    site,
    (replica) => {
      plannedOn.push(replica.tip);

      if (plannedOn.length === 1) {
        moved = moveLog(garden);
      }

      return { drafts: [addDraft(1)] };
    },
    now,
  );

  assert.deepEqual(
    [plannedOn.length, plannedOn[1], git(garden, ['rev-parse', `${logRef}^`]), readLog(site).events.length],
    [2, moved, moved, 1],
  );
});

test('an append whose log moves after each of its tries gives up after that many plans and says the log kept moving', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  let plans = 0;

  assert.throws(
    () =>
      append(
        site,
        () => {
          plans += 1;

          if (plans <= 4) {
            moveLog(garden);
          }

          return { drafts: [addDraft(1)] };
        },
        now,
        3,
      ),
    { message: 'refs/garden/log kept moving; 3 tries to append failed' },
  );
  assert.equal(plans, 3);
});

test('an append given fewer than one try still gives up after its first plan when the log moves', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  let plans = 0;

  assert.throws(
    () =>
      append(
        site,
        () => {
          plans += 1;

          if (plans <= 2) {
            moveLog(garden);
          }

          return { drafts: [addDraft(1)] };
        },
        now,
        0,
      ),
    { message: 'refs/garden/log kept moving; 0 tries to append failed' },
  );
  assert.equal(plans, 1);
});

test('an append whose ref stays locked while the log has not moved throws git message after one plan', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  writeFileSync(join(garden, '.git', 'refs', 'garden', 'log.lock'), '');
  let plans = 0;

  assert.throws(
    () =>
      append(
        site,
        () => {
          plans += 1;

          return { drafts: [addDraft(1)] };
        },
        now,
      ),
    { message: /^git fast-import refs\/garden\/log: .*cannot lock ref 'refs\/garden\/log'[\s\S]*\S$/ },
  );
  assert.equal(plans, 1);
});

test('an append whose plan adds no events returns that plan and leaves the log where it was', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const tip = git(garden, ['rev-parse', logRef]);

  assert.deepEqual(
    [append(site, () => ({ drafts: [], said: 'kept' }), now), git(garden, ['rev-parse', logRef])],
    [{ drafts: [], said: 'kept' }, tip],
  );
});

test('an event file that does not parse is skipped with its reason, and the events beside it still read', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  append(site, () => ({ drafts: [addDraft(1)] }), now);
  writeToLogByHand(garden, 'events/50/broken.json', '{"uuid":');
  const replica = readLog(site);

  assert.deepEqual([replica.events.length, replica.skipped], [1, [{ path: 'events/50/broken.json', why: 'not JSON' }]]);
});

test('an append waits for a ref lock another writer releases within a second, and lands', async (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const lock = join(garden, '.git', 'refs', 'garden', 'log.lock');
  const holdMs = 1000;
  let released: Promise<unknown> = Promise.resolve();
  let plannedAt = 0;

  append(
    site,
    () => {
      writeFileSync(lock, '');
      plannedAt = Date.now();
      const releaser = spawn(
        process.execPath,
        ['-e', `setTimeout(() => require("node:fs").rmSync(process.env.LOCK), ${String(holdMs)})`],
        { env: { ...process.env, LOCK: lock }, stdio: 'ignore' },
      );
      released = new Promise((resolve) => releaser.on('close', resolve));

      return { drafts: [addDraft(1)] };
    },
    now,
  );
  const waited = Date.now() - plannedAt;
  await released;

  assert.deepEqual([waited >= holdMs, readLog(site).events.length], [true, 1]);
});

test('a site without a writer id is refused with a message that names what is missing and the fix', (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['config', '--unset', 'lzGardening.writer']);

  assert.throws(
    () => openSite(dir),
    /^Error: no writer id \(lzGardening\.writer\) at .+repo\.garden; run site\.ts open first$/,
  );
});

test('a log whose garden.json is not JSON is refused, naming the file', (t) => {
  const { dir, garden } = planted(t);
  writeToLogByHand(garden, 'garden.json', '{"format":');

  assert.throws(() => readLog(openSite(dir)), { message: 'refs/garden/log:garden.json is not JSON' });
});

test('a log without its garden.json is refused, saying the file is missing', (t) => {
  const { dir, garden } = planted(t);
  writeEntriesToLogByHand(garden, [`0 ${'0'.repeat(40)}\tgarden.json`]);

  assert.throws(() => readLog(openSite(dir)), { message: 'refs/garden/log has no garden.json' });
});

test('a log whose garden.json names no format from 1 up is refused as damaged, not as too new', (t) => {
  const { dir, garden } = planted(t);
  const site = openSite(dir);
  const refusal = (text: string): unknown => {
    writeToLogByHand(garden, 'garden.json', text);

    try {
      readLog(site);
    } catch (error: unknown) {
      return error instanceof Error ? error.message : error;
    }

    return undefined;
  };

  assert.deepEqual(
    [refusal('{}'), refusal('{"format":0}'), refusal('{"format":"1"}')],
    [
      'refs/garden/log:garden.json names no log format',
      'refs/garden/log:garden.json names no log format',
      'refs/garden/log:garden.json names no log format',
    ],
  );
});

test('the hooks turned off are those the config names, by their whole name, and no other key', (t) => {
  const dir = repo(t);
  git(dir, ['config', 'hook.team.lint.event', 'pre-commit']);
  git(dir, ['config', 'hook.team.lint.command', 'npm run lint']);
  git(dir, ['config', 'alias.hook.x.command', 'log']);
  git(dir, ['config', 'hook.other.commandeer', 'x']);

  assert.deepEqual(namedHooksOff(dir), ['--config-env=hook.team.lint.enabled=LZ_GARDEN_HOOK_OFF']);
});

test('an add that writes the log runs none of the user hooks, set in a hooks folder or by name', (t) => {
  const { dir } = planted(t);
  const hooks = join(dirname(dir), 'hooks');
  const ran = join(dirname(dir), 'hooks-ran.log').replaceAll('\\', '/');
  const events = ['reference-transaction', 'post-index-change'];
  mkdirSync(hooks);

  for (const event of events) {
    writeFileSync(join(hooks, event), `#!/bin/sh\necho ${event} >> "${ran}"\nexit 1\n`, { mode: 0o755 });
  }

  const env = configEnv([
    ['core.hooksPath', hooks],
    ...events.flatMap((event): [string, string][] => [
      [`hook.user-${event}.event`, event],
      [`hook.user-${event}.command`, `echo ${event} by name >> "${ran}"`],
    ]),
  ]);

  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], env);

  assert.deepEqual([added.code, existsSync(ran) ? readFileSync(ran, 'utf8') : ''], [0, '']);
});

test('a hook set up by name with no value after its command key is turned off too', (t) => {
  const dir = repo(t);
  appendFileSync(join(dir, '.git', 'config'), '[hook "bare"]\n\tcommand\n');

  assert.deepEqual(namedHooksOff(dir), ['--config-env=hook.bare.enabled=LZ_GARDEN_HOOK_OFF']);
});

test('a site whose config git cannot read is refused with the error git gives, not as a site without a writer', (t) => {
  const { dir, garden } = planted(t);
  appendFileSync(join(garden, '.git', 'config'), '[core\n');

  assert.throws(() => openSite(dir), { message: /^git config --list -z: fatal: bad config line \d+ in file .*$/ });
});

test('an add run with GIT_DIR naming another repository lands in the garden log and leaves that repository alone', (t) => {
  const { dir, garden } = planted(t);
  const other = repo(t);

  const added = cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], {
    ...process.env,
    GIT_DIR: join(other, '.git'),
  });

  assert.deepEqual(
    [added.code, readLog(openSite(dir)).events.length, git(other, ['for-each-ref', 'refs/garden'])],
    [0, 1, ''],
  );
  assert.equal(git(garden, ['rev-parse', '--verify', logRef]).length, 40);
});

test('lzGardening.name and lzGardening.email passed in GIT_CONFIG_COUNT sign the commit that adds an event', (t) => {
  const { dir, garden } = planted(t);

  cli(
    dir,
    ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'],
    configEnv([
      ['lzGardening.name', 'Probe'],
      ['lzGardening.email', 'probe@example.com'],
    ]),
  );

  assert.equal(
    git(garden, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', logRef]),
    'Probe <probe@example.com>|Probe <probe@example.com>',
  );
});

test('a site opened from a linked worktree is the one beside the main checkout', (t) => {
  const { dir } = planted(t);
  const worktree = join(dirname(dir), 'agent-x');
  git(dir, ['worktree', 'add', '-q', '-b', 'agent-x', worktree]);

  assert.deepEqual(openSite(worktree), openSite(dir));
});

test("a site's writer is the id its config holds, with nothing around it", (t) => {
  const { dir } = planted(t);

  assert.match(openSite(dir).writer, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('a site opened outside a repository is refused with the git command and what git said', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'garden-outside-'));
  t.after(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(() => openSite(outside), {
    message:
      /^git rev-parse --path-format=absolute --absolute-git-dir --git-common-dir --show-toplevel: fatal: not a git repository .*\.git$/,
  });
});

test('a site opened from a folder that does not exist is refused, saying git could not start', (t) => {
  const { dir } = planted(t);

  assert.throws(() => openSite(join(dir, 'missing')), { message: /^git could not start: spawnSync git ENOENT$/ });
});

test('planting a writer id on a site that has one keeps its writer id', (t) => {
  const { garden } = planted(t);
  const before = git(garden, ['config', 'lzGardening.writer']);

  plantWriter(garden);

  assert.equal(git(garden, ['config', 'lzGardening.writer']), before);
});

test('a writer id planted during a command is the one that command reads back', (t) => {
  const { garden } = planted(t);
  git(garden, ['config', '--unset', 'lzGardening.writer']);

  const read = inRun(process.env, () => {
    plantWriter(garden);

    return configValue(garden, 'lzGardening.writer');
  });

  assert.equal(read, git(garden, ['config', 'lzGardening.writer']));
});

test('starting a log where one exists is refused and leaves the log as it was', (t) => {
  const { dir, garden } = planted(t);
  const before = git(garden, ['rev-parse', '--verify', logRef]);

  assert.throws(() => {
    startLog({ path: garden, checkout: dir });
  }, /^Error: git fast-import refs\/garden\/log: warning: not updating refs\/garden\/log .*$/s);
  assert.equal(git(garden, ['rev-parse', '--verify', logRef]), before);
});

test('a planted log holds format 1 in garden.json, in a commit named garden: log', (t) => {
  const { garden } = planted(t);

  assert.deepEqual(
    [git(garden, ['show', `${logRef}:garden.json`]), git(garden, ['log', '-1', '--format=%s', logRef])],
    ['{"format":1}', 'garden: log'],
  );
});

test('an add leaves no scratch folder in the temp directory', (t) => {
  const { dir } = planted(t);
  const temp = mkdtempSync(join(tmpdir(), 'garden-temp-'));
  t.after(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  const added = cliProcess(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], {
    ...process.env,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
  });

  assert.deepEqual([added.code, readdirSync(temp)], [0, []]);
});

test('a command run inside another leaves the outer one its own environment when it returns', (t) => {
  const dir = repo(t);

  const names = inRun(configEnv([['user.name', 'Outer']]), () => {
    const inner = inRun(configEnv([['user.name', 'Inner']]), () => configValue(dir, 'user.name'));

    return [inner, configValue(dir, 'user.name')];
  });

  assert.deepEqual(names, ['Inner', 'Outer']);
});

test('a setting with a subsection is read whatever the case of its section and name, and only by its own subsection', (t) => {
  const dir = repo(t);
  git(dir, ['config', 'garden.Main.note', 'kept']);

  assert.deepEqual([configValue(dir, 'GARDEN.Main.NOTE'), configValue(dir, 'garden.main.note')], ['kept', undefined]);
});

test('a command that throws leaves the process environment to the calls after it', (t) => {
  const dir = repo(t);
  const failing = (): never => {
    configValue(dir, 'user.name');
    throw new Error('stopped');
  };

  assert.throws(() => inRun(configEnv([['user.name', 'Inside']]), failing), /stopped/);
  assert.equal(configValue(dir, 'user.name'), git(dir, ['config', 'user.name']));
});

test('a site opened from inside a garden site is refused, naming the folder and where to run from', (t) => {
  const { garden } = planted(t);

  assert.throws(() => openSite(garden), {
    message: `${garden} is in a garden site or bed; run the garden scripts from the repository's checkout`,
  });
});

test('a site folder without a git repository is refused as no garden site', (t) => {
  const dir = repo(t);
  mkdirSync(`${dir}.garden`);

  assert.throws(() => openSite(dir), { message: /^no garden site at .*repo\.garden; run site\.ts open first$/ });
});

test('lzGardening.name without lzGardening.email leaves the commit to lz-gardening with no address', (t) => {
  const { dir, garden } = planted(t);

  cli(
    dir,
    ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'],
    configEnv([['lzGardening.name', 'Probe']]),
  );

  assert.equal(identityOfLog(garden), 'lz-gardening <>|lz-gardening <>');
});

test('lzGardening.name and lzGardening.email passed in GIT_CONFIG_PARAMETERS sign the commit that adds an event', (t) => {
  const { dir, garden } = planted(t);

  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x'], {
    ...process.env,
    GIT_CONFIG_PARAMETERS: "'lzgardening.name'='Probe' 'lzgardening.email'='probe@example.com'",
  });

  assert.equal(identityOfLog(garden), 'Probe <probe@example.com>|Probe <probe@example.com>');
});

test('an lzGardening.name holding a line break is refused, naming the setting, and writes nothing', (t) => {
  const { dir, garden } = planted(t);
  const tip = git(garden, ['rev-parse', logRef]);

  assert.throws(
    () => {
      appendIn(
        dir,
        configEnv([
          ['lzGardening.name', 'Probe\nM 100644 inline garden.json'],
          ['lzGardening.email', 'probe@example.com'],
        ]),
      );
    },
    { message: 'lzGardening.name holds a line break, < or >, which a commit cannot name; change it' },
  );
  assert.equal(git(garden, ['rev-parse', logRef]), tip);
});

test('an lzGardening.email holding > is refused, naming the setting', (t) => {
  const { dir } = planted(t);

  assert.throws(
    () => {
      appendIn(
        dir,
        configEnv([
          ['lzGardening.name', 'Probe'],
          ['lzGardening.email', 'probe@example.com> x'],
        ]),
      );
    },
    { message: 'lzGardening.email holds a line break, < or >, which a commit cannot name; change it' },
  );
});

test('an lzGardening.name holding < is refused, naming the setting', (t) => {
  const { dir } = planted(t);

  assert.throws(
    () => {
      appendIn(
        dir,
        configEnv([
          ['lzGardening.name', 'Ann <QA'],
          ['lzGardening.email', 'probe@example.com'],
        ]),
      );
    },
    { message: 'lzGardening.name holds a line break, < or >, which a commit cannot name; change it' },
  );
});

function identityOfLog(garden: string): string {
  return git(garden, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', logRef]);
}

test('an append commits as lz-gardening with no address, whatever user.name and user.email say', (t) => {
  const { dir, garden } = planted(t);

  cli(dir, ['add', '--class', 'any-type', '--where', 'src/a.ts:1', '--source', 'census:x']);

  assert.equal(identityOfLog(garden), 'lz-gardening <>|lz-gardening <>');
});

function appendIn(dir: string, env: NodeJS.ProcessEnv): void {
  inRun({ ...process.env, ...env }, () => {
    append(openSite(dir), () => ({ drafts: [addDraft(1)] }), now);
  });
}

function commitTreeOfLastAppend(garden: string, env: NodeJS.ProcessEnv): string {
  const gardenIdentity = {
    GIT_AUTHOR_NAME: 'lz-gardening',
    GIT_AUTHOR_EMAIL: '',
    GIT_COMMITTER_NAME: 'lz-gardening',
    GIT_COMMITTER_EMAIL: '',
  };
  const result = spawnSync('git', ['commit-tree', `${logRef}^{tree}`, '-p', `${logRef}^`, '-m', 'garden: log'], {
    cwd: garden,
    encoding: 'utf8',
    env: { ...process.env, ...gardenIdentity, ...env },
  });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

test('an append dated by GIT_COMMITTER_DATE in ISO 8601 writes the commit git commit-tree writes', (t) => {
  const { dir, garden } = planted(t);
  const env = { GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' };

  appendIn(dir, env);

  assert.equal(git(garden, ['rev-parse', logRef]), commitTreeOfLastAppend(garden, env));
});

test('an append run with an author date other than its committer date writes the commit git commit-tree writes', (t) => {
  const { dir, garden } = planted(t);
  const env = { GIT_AUTHOR_DATE: 'Thu, 07 Apr 2005 22:13:13 +0200', GIT_COMMITTER_DATE: '1700000000 +0100' };

  appendIn(dir, env);

  assert.equal(git(garden, ['rev-parse', logRef]), commitTreeOfLastAppend(garden, env));
});

test("an append with no date in the env is dated now in UTC, not in the machine's offset", (t) => {
  const { dir, garden } = planted(t);
  const before = Math.floor(Date.now() / 1000);

  appendIn(dir, { TZ: 'EST5' });
  const after = Math.ceil(Date.now() / 1000);
  const [time = '', authorZone, committerZone] = git(garden, [
    'log',
    '-1',
    '--format=%ct %ad %cd',
    '--date=format:%z',
    logRef,
  ]).split(' ');

  assert.deepEqual(
    [before <= Number(time) && Number(time) <= after, authorZone, committerZone],
    [true, '+0000', '+0000'],
  );
});

test("an append starts git only to read the log, the checkout's settings for who signs it, and to write it", (t) => {
  const { dir } = planted(t);
  const site = openSite(dir);
  const spawned = t.mock.method(childProcess, 'spawnSync');
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });

  append(site, () => ({ drafts: [addDraft(1)] }), now);

  assert.deepEqual(
    spawned.mock.calls.map(({ arguments: [, args] }) =>
      Array.isArray(args)
        ? args.filter((arg: unknown) => typeof arg === 'string').find((arg) => /^[a-z][a-z-]*$/.test(arg))
        : undefined,
    ),
    ['rev-parse', 'ls-tree', 'cat-file', 'config', 'fast-import'],
  );
});

test('a site whose garden log is gone is refused, naming the site and the fix', (t) => {
  const { dir, garden } = planted(t);
  git(garden, ['update-ref', '-d', logRef]);

  assert.throws(() => readLog(openSite(dir)), {
    message: /^no garden log at .*repo\.garden; run site\.ts open first$/,
  });
});

test('a log in a newer format than this version reads is refused, saying to update lz-gardening', (t) => {
  const { dir, garden } = planted(t);
  writeToLogByHand(garden, 'garden.json', '{"format":2}');

  assert.throws(() => readLog(openSite(dir)), {
    message: 'refs/garden/log is in format 2, which this version cannot read; update lz-gardening',
  });
});

test('a git that cannot start is named without its arguments, so a token in an origin URL stays out of the message', (t) => {
  const { garden } = planted(t);
  const empty = mkdtempSync(join(tmpdir(), 'no-git-'));
  t.after(() => {
    rmSync(empty, { recursive: true, force: true });
  });

  assert.throws(
    () =>
      runGit(garden, ['fetch', '--end-of-options', 'https://gardener:s3cret@example.com/r.git'], {
        env: { PATH: empty, Path: empty },
      }),
    { message: /^git could not start: spawnSync git ENOENT$/ },
  );
});

test('an event file whose object is not a file is refused with the header git read for it', (t) => {
  const { dir, garden } = planted(t);
  const tree = git(garden, ['rev-parse', `${logRef}^{tree}`]);
  writeEntriesToLogByHand(garden, [`100644 ${tree}\tevents/50/tree.json`]);

  assert.throws(() => readLog(openSite(dir)), {
    message: new RegExp(
      `^git cat-file --batch: read "${tree} tree \\d+" for events/50/tree\\.json, not ${tree} blob <size>$`,
    ),
  });
});
