// Throwaway git repositories for the scripts' tests. Each repository sits alone in its own temporary folder, so a
// test can create siblings beside it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

export function repo(t: TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
  });
  const dir = join(parent, 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);

  return dir;
}

export function commit(dir: string, files: Readonly<Record<string, string>>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'x']);

  return git(dir, ['rev-parse', 'HEAD']);
}
