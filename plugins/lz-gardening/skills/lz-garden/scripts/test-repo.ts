import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env['GIT_CONFIG_GLOBAL'] = fileURLToPath(new URL('test.gitconfig', import.meta.url));
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout.trim();
}

export function repo(t: TestContext): string {
  const folderWithRoomForSiblings = mkdtempSync(join(tmpdir(), 'garden-'));
  t.after(() => {
    rmSync(folderWithRoomForSiblings, { recursive: true, force: true });
  });
  const dir = join(folderWithRoomForSiblings, 'repo');
  init(dir);

  return dir;
}

export function init(dir: string): void {
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  appendFileSync(join(dir, '.git', 'config'), '[user]\n\temail = test@example.com\n\tname = test\n');
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
