import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { run } from './site.ts';
import { censusRef, pendingCensusRef, writePendingCensus } from './store-census.ts';
import { capturingIo, commit, git, init, scriptRun, summaryOf } from './test-repo.ts';

export const siteScript = join(import.meta.dirname, 'site.ts');

export interface SiteRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly summary: ReadonlyMap<string, unknown>;
}

function siteRun(status: number | null, stdout: string, stderr: string): SiteRun {
  return { status, stderr, summary: summaryOf(stdout) };
}

export function site(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  const captured = capturingIo(cwd, env);
  const status = run(args, captured.io);

  return siteRun(status, captured.stdout(), captured.stderr());
}

export function siteProcess(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SiteRun {
  const result = scriptRun(siteScript, cwd, args, env);

  return siteRun(result.status, result.stdout, result.stderr);
}

// A repository with one commit on main and its site, planted once per test process and outside every test. A child
// process plants it, so a mutation-test runner does not count what site.ts open reaches as reached by every test.
// Each test plants a copy.
const template = plantTemplate();

function plantTemplate(): string {
  const folder = mkdtempSync(join(tmpdir(), 'garden-'));
  process.once('exit', () => {
    rmSync(folder, { recursive: true, force: true });
  });
  const dir = join(folder, 'repo');
  init(dir);
  commit(dir, { 'src/a.ts': 'export const a = 1;\n' });
  const opened = siteProcess(dir, ['open', '--base', 'main']);
  assert.equal(opened.status, 0, opened.stderr);

  return folder;
}

export interface Planted {
  readonly dir: string;
  readonly garden: string;
}

export function planted(t: TestContext): Planted {
  const folder = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
  });
  cpSync(template, folder, { recursive: true });
  const dir = join(folder, 'repo');
  const garden = join(folder, 'repo.garden');
  const config = join(garden, '.git', 'config');
  const origin = (folderOfRepo: string): string =>
    `url = ${join(realpathSync.native(folderOfRepo), 'repo').replaceAll('\\', '\\\\')}\n`;
  const text = readFileSync(config, 'utf8');
  assert.ok(text.includes(origin(template)), `${config} names its origin as ${origin(template)}`);
  assert.match(text, /^\twriter = /m);
  writeFileSync(
    config,
    // Replacer functions, as a replacement string would expand a $& or $1 in the path.
    text
      .replace(origin(template), () => origin(folder))
      .replace(/^\twriter = .*$/m, () => `\twriter = ${randomUUID()}`),
  );

  return { dir, garden };
}

// A bare remote with the template's main pushed to it, made once per test process: a local push starts several
// processes, so bareRemote and sharedPair copy this one for a checkout whose main is still the template's.
const templateRemote = pushedRemote(join(template, 'repo'));
const templateMain = mainOf(join(template, 'repo'));

function pushedRemote(checkout: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'garden-remote-'));
  process.once('exit', () => {
    rmSync(folder, { recursive: true, force: true });
  });
  const remote = join(folder, 'remote.git');
  git(folder, ['init', '-q', '--bare', remote]);
  git(checkout, ['push', '-q', remote, 'main']);

  return remote;
}

function mainOf(checkout: string): string | undefined {
  const ref = join(checkout, '.git', 'refs', 'heads', 'main');

  return existsSync(ref) ? readFileSync(ref, 'utf8').trim() : undefined;
}

// For a checkout whose main is the template's and a remote path git writes to its config as it is: what git remote add
// origin <remote> writes, and the remote-tracking main a push or fetch of main then writes (not its reflog, which no
// test reads, nor a fetch's FETCH_HEAD, which every test that reads it fetches first).
function addedTemplateOrigin(dir: string, remote: string): boolean {
  const config = join(dir, '.git', 'config');

  if (
    templateMain === undefined ||
    mainOf(dir) !== templateMain ||
    !/^[\w.~:\\/-]+$/.test(remote) ||
    readFileSync(config, 'utf8').includes('[remote "origin"]')
  ) {
    return false;
  }

  appendFileSync(
    config,
    `[remote "origin"]\n\turl = ${remote.replaceAll('\\', '\\\\')}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  mkdirSync(join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), `${templateMain}\n`);

  return true;
}

export function bareRemote(dir: string): string {
  const remote = join(dirname(dir), 'remote.git');

  if (addedTemplateOrigin(dir, remote)) {
    cpSync(templateRemote, remote, { recursive: true });
  } else {
    git(dirname(dir), ['init', '-q', '--bare', remote]);
    git(dir, ['remote', 'add', 'origin', remote]);
    git(dir, ['push', '-q', 'origin', 'main']);
  }

  return remote;
}

// git runs a #!/bin/sh hook on every platform the tests run on, Windows included.
export function remoteHook(remote: string, name: string, body: string): void {
  writeFileSync(join(remote, 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

export function sharedPair(t: TestContext): {
  readonly first: Planted;
  readonly second: Planted;
  readonly remote: string;
} {
  const first = planted(t);
  const remote = bareRemote(first.dir);
  const second = planted(t);

  // first's main is the template's, so the remote's main is too, as a fetch would write it.
  if (!addedTemplateOrigin(second.dir, remote)) {
    git(second.dir, ['remote', 'add', 'origin', remote]);
    git(second.dir, ['fetch', '-q', 'origin']);
  }

  return { first, second, remote };
}

export function writeCensusText(garden: string, text: string): void {
  // A census fixture by hand: its commit's identity is not under test, so it reads the site's config.
  writePendingCensus({ path: garden, checkout: garden }, 'fixture', text);
  git(garden, ['update-ref', censusRef, pendingCensusRef('fixture')]);
  git(garden, ['update-ref', '-d', pendingCensusRef('fixture')]);
}

export function censusText(sha: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const census = {
    rev: 'main',
    sha,
    takenAt: '2026-11-13T00:00:00.000Z',
    counts: {},
    hits: {},
    duplicates: {},
    ...extra,
  };

  return `${JSON.stringify(census, null, 2)}\n`;
}

export function anotherSyncMovesTheCensusFirst(t: TestContext, garden: string, to: string): void {
  const { spawnSync } = childProcess;
  const spawned = t.mock.method(childProcess, 'spawnSync', (...args: readonly unknown[]): unknown => {
    const [, gitArgs] = args;

    if (Array.isArray(gitArgs) && gitArgs.includes('update-ref') && gitArgs.includes(censusRef)) {
      spawnSync('git', ['update-ref', censusRef, to], { cwd: garden });
    }

    return Reflect.apply(spawnSync, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    syncBuiltinESMExports();
  });
}

export function writeCensus(garden: string, sha = 'a'.repeat(40), rev = 'main'): void {
  writeCensusText(garden, censusText(sha, { rev }));
}

// The process environment plus git settings, as a user passes them to git through GIT_CONFIG_COUNT.
export function configEnv(settings: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
  };
}
