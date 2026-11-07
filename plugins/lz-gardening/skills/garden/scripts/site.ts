// The garden site: a clone beside the repository whose `garden` branch holds the queue and the census.
// Usage, from the repository:
//   node site.ts open [--base <branch>]     create or fetch the site; prints {site, created, base}
//   node site.ts commit --message <text>    commit the site's .garden folder; prints {committed}
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseCensus } from './census.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

// For a git command whose failure is an answer rather than an error: a missing ref or config key, or `diff --quiet`.
function optionalGit(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  return result.status === 0 ? result.stdout.trim() : undefined;
}

export interface BaseFacts {
  readonly base?: string | undefined;
  readonly censusRev?: string | undefined;
  readonly originHead?: string | undefined;
  readonly current?: string | undefined;
  readonly branches: readonly string[];
  // Branches of origin, without the `origin/` prefix.
  readonly remoteBranches?: readonly string[] | undefined;
}

export function resolveBase(facts: BaseFacts): string {
  const remote = facts.remoteBranches ?? [];
  // A branch only origin has is read through its remote-tracking ref.
  const ref = (name: string): string =>
    facts.branches.includes(name) || !remote.includes(name) ? name : `origin/${name}`;
  // A clone of a local path takes its origin/HEAD from whatever the source has checked out.
  const remoteDefault = facts.originHead === facts.current ? undefined : facts.originHead;
  const fallback = facts.branches.includes('main') || remote.includes('main') ? 'main' : 'master';

  return facts.base === undefined ? (facts.censusRev ?? ref(remoteDefault ?? fallback)) : ref(facts.base);
}

function repositoryIdentity(top: string): readonly (readonly [string, string])[] {
  const identity = ['user.name', 'user.email'].map((key) => [key, optionalGit(top, ['config', key]) ?? ''] as const);
  const missing = identity.find(([, value]) => value === '');

  if (missing !== undefined) {
    throw new Error(`the repository has no ${missing[0]}; set it so the garden commits carry its owner's identity`);
  }

  return identity;
}

// A clone with no checkout, its own identity copied from the repository, and an orphan branch that will hold only the
// gardener's record.
function plant(top: string, site: string): void {
  const identity = repositoryIdentity(top);
  git(dirname(top), ['clone', '-q', '--no-checkout', top, site]);

  for (const [key, value] of identity) {
    git(site, ['config', key, value]);
  }

  git(site, ['switch', '-q', '--orphan', 'garden']);
  writeFileSync(join(site, '.gitignore'), '/beds/\n');
  git(site, ['add', '.gitignore']);
  git(site, ['commit', '-q', '-m', 'garden: plant']);
}

function recordedRev(site: string): string | undefined {
  const census = join(site, '.garden', 'census.json');

  return existsSync(census) ? parseCensus(JSON.parse(readFileSync(census, 'utf8')))?.rev : undefined;
}

function baseFacts(top: string, site: string, base: string | undefined): BaseFacts {
  return {
    base,
    censusRev: recordedRev(site),
    originHead: optionalGit(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(
      /^origin\//,
      '',
    ),
    current: git(top, ['branch', '--show-current']),
    branches: git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
    remoteBranches: git(top, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])
      .split('\n')
      .map((ref) => ref.replace('refs/remotes/origin/', ''))
      .filter((name) => name !== '' && name !== 'HEAD'),
  };
}

function openSite(top: string, site: string, base: string | undefined): object {
  const created = !existsSync(join(site, '.git'));

  if (created) {
    plant(top, site);
  } else {
    git(site, ['fetch', '-q', '--prune', 'origin']);
  }

  return { site, created, base: resolveBase(baseFacts(top, site, base)) };
}

function commitSite(site: string, message: string): object {
  git(site, ['add', '.garden']);
  // `diff --quiet` exits 0 only when nothing differs, which optionalGit reports as a string.
  const nothingStaged = optionalGit(site, ['diff', '--cached', '--quiet']) !== undefined;

  if (nothingStaged) {
    return { committed: false };
  }

  git(site, ['commit', '-q', '-m', message]);

  return { committed: true };
}

function main(argv: readonly string[], cwd: string): number {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: { base: { type: 'string' }, message: { type: 'string', default: '' } },
  });
  const [command] = positionals;

  if (command !== 'open' && command !== 'commit') {
    process.stderr.write('usage: site.ts open [--base <branch>] | site.ts commit --message <text>\n');

    return 2;
  }

  const top = resolve(git(cwd, ['rev-parse', '--show-toplevel']));
  const site = join(dirname(top), `${basename(top)}.garden`);
  const summary = command === 'commit' ? commitSite(site, values.message) : openSite(top, site, values.base);
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  return 0;
}

// import.meta.url is the real path, so compare real paths: run through a link, the CLI still runs.
if (
  process.argv[1] &&
  realpathSync.native(resolve(process.argv[1])) === realpathSync.native(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main(process.argv.slice(2), process.cwd());
  } catch (error: unknown) {
    process.stderr.write(`site: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
