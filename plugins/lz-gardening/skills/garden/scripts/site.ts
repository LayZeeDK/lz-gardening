// The garden site: a clone beside the repository whose `garden` branch holds the queue and the census.
// Usage, from the repository: node site.ts open [--base <branch>]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCensus } from './census.ts';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

// For a ref that may not exist, such as origin/HEAD in a repository with no remote.
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
}

export function resolveBase(facts: BaseFacts): string {
  // A clone of a local path takes its origin/HEAD from whatever the source has checked out.
  const remoteDefault = facts.originHead === facts.current ? undefined : facts.originHead;

  return facts.base ?? facts.censusRev ?? remoteDefault ?? (facts.branches.includes('main') ? 'main' : 'master');
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);

  return index === -1 ? undefined : argv[index + 1];
}

// A clone with no checkout, its own identity copied from the repository, and an orphan branch that will hold only the
// gardener's record.
function plant(top: string, site: string): void {
  git(dirname(top), ['clone', '-q', '--no-checkout', top, site]);

  for (const key of ['user.name', 'user.email']) {
    git(site, ['config', key, git(top, ['config', key])]);
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

function baseFacts(top: string, site: string, argv: readonly string[]): BaseFacts {
  return {
    base: argValue(argv, '--base'),
    censusRev: recordedRev(site),
    originHead: optionalGit(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(
      /^origin\//,
      '',
    ),
    current: git(top, ['branch', '--show-current']),
    branches: git(top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n'),
  };
}

function main(argv: readonly string[], cwd: string): number {
  const top = resolve(git(cwd, ['rev-parse', '--show-toplevel']));
  const site = join(dirname(top), `${basename(top)}.garden`);
  const created = !existsSync(join(site, '.git'));

  if (created) {
    plant(top, site);
  } else {
    git(site, ['fetch', '-q', '--prune', 'origin']);
  }

  const base = resolveBase(baseFacts(top, site, argv));
  process.stdout.write(`${JSON.stringify({ site, created, base })}\n`);

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
