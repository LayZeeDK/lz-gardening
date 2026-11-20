// A bed in the garden site: its worktree on bed/<class>, made from the base and origin's bed of the class, and its
// dependencies, linked to the checkout's node_modules or left with the command that installs them.
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitReason, gitSucceeds, objectIds, optionalGit, runGit } from './store-git.ts';
import { fetchedBedRef } from './store-beds.ts';
import { isRecord } from './log-guard.ts';

/** A package manager's commands for a bed, each given the bed's path quoted for the shell. */
interface PackageManager {
  readonly install: (bed: string) => string;
  readonly run: (bed: string) => string;
  readonly tool: (bed: string) => string;
}

// npm and yarn run a tool in the directory they start in, so the tool form changes into the bed.
const npxTool = (bed: string): string => `cd ${bed} && npx --no -- <tool> <args>`;
const npm: PackageManager = {
  install: (bed) => `npm --prefix ${bed} install`,
  run: (bed) => `npm --prefix ${bed} run <script> -- <args>`,
  tool: npxTool,
};
const managers: readonly (readonly [lockfile: string, manager: PackageManager])[] = [
  [
    'pnpm-lock.yaml',
    {
      install: (bed) => `pnpm -C ${bed} install --frozen-lockfile`,
      run: (bed) => `pnpm -C ${bed} run <script> <args>`,
      tool: (bed) => `pnpm -C ${bed} exec <tool> <args>`,
    },
  ],
  [
    'yarn.lock',
    {
      install: (bed) => `yarn --cwd ${bed} install --frozen-lockfile`,
      run: (bed) => `yarn --cwd ${bed} <script> <args>`,
      tool: npxTool,
    },
  ],
  ['package-lock.json', { ...npm, install: (bed) => `npm --prefix ${bed} ci` }],
];
const lockfiles = managers.map(([lockfile]) => lockfile);

function posixShellQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function managerOf(bed: string): PackageManager {
  return managers.find(([lockfile]) => existsSync(join(bed, lockfile)))?.[1] ?? npm;
}

/** How a pass runs a package script and a tool in the bed from the checkout, and the call that returns there. */
type CommandForms = { readonly run: string; readonly tool: string; readonly back: string };

function commandForms(checkout: string, bed: string): CommandForms {
  const manager = managerOf(bed);
  const quoted = posixShellQuoted(bed);

  return { run: manager.run(quoted), tool: manager.tool(quoted), back: `cd ${posixShellQuoted(checkout)}` };
}

// The bed's lockfile comes from the base, so only a plain file is read: a link can name any file, a FIFO hangs.
function sameBytes(checkout: string, bed: string): boolean {
  return (
    existsSync(checkout) &&
    lstatSync(bed, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(checkout).equals(readFileSync(bed))
  );
}

function declaresWorkspaces(dir: string): boolean {
  const file = join(dir, 'package.json');
  const text = readFileSync(file, 'utf8');
  let manifest: unknown;

  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }

  return (isRecord(manifest) && 'workspaces' in manifest) || existsSync(join(dir, 'pnpm-workspace.yaml'));
}

function mergeInto(bed: string, commitId: string, name: string): void {
  const merged = runGit(bed, ['merge', '-q', '--no-edit', commitId]);

  if (merged.status === 0) {
    return;
  }

  // A merge git refused before it began, such as over a file in the way, leaves nothing to merge by hand.
  if (!gitSucceeds(bed, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    throw new Error(`${name} does not merge into ${bed}: ${gitReason(merged.stderr)}`);
  }

  gitSucceeds(bed, ['merge', '--abort']);
  throw new Error(`${name} does not merge into ${bed} cleanly; merge it there by hand, then run bed again`);
}

type Deps = 'none' | 'linked' | 'installed' | 'install';

export type BedSummary = {
  readonly bed: string;
  readonly branch: string;
  readonly start: string;
  readonly created: boolean;
} & CommandForms &
  ({ readonly deps: Exclude<Deps, 'install'> } | { readonly deps: 'install'; readonly install: string });

export function makeBed(top: string, site: string, bedClass: string, base: string): BedSummary {
  git(site, ['fetch', '-q', 'origin', base]);
  const branch = `bed/${bedClass}`;
  const branchRef = `refs/heads/${branch}`;
  // Stryker disable next-line StringLiteral: a fetch that succeeded always leaves FETCH_HEAD, so the default never applies
  const [start = '', branchTip, shared] = objectIds(site, ['FETCH_HEAD', branchRef, fetchedBedRef(bedClass)]);
  const bed = join(site, 'beds', bedClass);
  const hasBranch = branchTip !== undefined;
  const entry = lstatSync(bed, { throwIfNoEntry: false });

  if (
    entry !== undefined &&
    (!hasBranch || !entry.isDirectory() || optionalGit(bed, ['symbolic-ref', '-q', 'HEAD']) !== branchRef)
  ) {
    throw new Error(`${bed} is not the worktree of ${branch}; move it aside, then run bed again`);
  }

  if (hasBranch) {
    if (entry === undefined) {
      git(site, ['worktree', 'prune']);
      git(site, ['worktree', 'add', '-q', bed, branch]);
    }

    if (gitSucceeds(bed, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      throw new Error(`a merge is in progress in ${bed}; finish or abort it, then run bed again`);
    }

    if (shared !== undefined) {
      mergeInto(bed, shared, `origin's ${branch}`);
    }

    mergeInto(bed, start, base);
  } else {
    git(site, ['worktree', 'add', '-q', '-b', branch, bed, shared ?? start]);

    if (shared !== undefined) {
      mergeInto(bed, start, base);
    }
  }

  const deps = plantDeps(top, bed);
  const made = { bed, branch, start, created: !hasBranch, ...commandForms(top, bed) };

  return deps === 'install'
    ? { ...made, deps, install: managerOf(bed).install(posixShellQuoted(bed)) }
    : { ...made, deps };
}

function sharesLockfile(top: string, bed: string): boolean {
  return lockfiles.some((name) => sameBytes(join(top, name), join(bed, name)));
}

function linkable(top: string, bed: string): boolean {
  return (
    lstatSync(join(bed, 'package.json'), { throwIfNoEntry: false })?.isFile() === true &&
    existsSync(join(top, 'node_modules')) &&
    sharesLockfile(top, bed) &&
    !declaresWorkspaces(bed)
  );
}

function plantDeps(top: string, bed: string): Deps {
  const entry = lstatSync(join(bed, 'node_modules'), { throwIfNoEntry: false });

  if (entry !== undefined) {
    if (!entry.isSymbolicLink()) {
      return 'installed';
    }

    if (linkable(top, bed)) {
      return 'linked';
    }

    rmSync(join(bed, 'node_modules'));
  }

  if (existsSync(join(bed, '.pnp.cjs'))) {
    return 'installed';
  }

  if (lstatSync(join(bed, 'package.json'), { throwIfNoEntry: false }) === undefined) {
    return 'none';
  }

  if (!linkable(top, bed)) {
    return 'install';
  }

  symlinkSync(join(top, 'node_modules'), join(bed, 'node_modules'), 'junction');

  return 'linked';
}
