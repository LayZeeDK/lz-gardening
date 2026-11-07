// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const maintainer = 'Lars Gyrup Brink Nielsen';
const publicEmail = 'larsbrinknielsen@gmail.com';
const emailShape = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi;

// The plugin must stand alone: it names none of the maintainer's own plugins or skills.
const ownTools = [
  /\bpstack\b/i,
  /\blars-[a-z]/i,
  /\blz-(?:tdd|advisor|engineering)\b/i,
  /\bgsd\b/i,
  /\bpoteto-mode\b/i,
  /\bmattpocock\b/i,
  /\bponytail\b/i,
  /\bthermos\b/i,
  /\b(?:de|un)slop\b/i,
  /\bplugin-dev\b/i,
  /\bskill-creator\b/i,
  /\bhumanizer\b/i,
  /\bpr-review-toolkit\b/i,
  /\bclaude-security\b/i,
  /\bautomate-me\b/i,
  /(?:^|[\s`(])\/(?:correct|reflect|recall|watch)\b/,
];

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);

  return result.stdout;
}

function textFiles(prefix = ''): { readonly path: string; readonly text: string }[] {
  return git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', `${prefix}.`])
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
    .filter((file) => !file.text.includes('\0'));
}

// RFC 2606 reserves example.com and its subdomains, so test fixtures may use them.
function isAllowedEmail(email: string): boolean {
  return email === publicEmail || /@(?:[\w-]+\.)*example\.com$/i.test(email);
}

function emails(text: string): string[] {
  return text.match(emailShape) ?? [];
}

test('the email scan finds addresses and skips package versions', () => {
  assert.deepEqual(emails('mail x.y@mail.example.com, not pkg@1.2.3'), ['x.y@mail.example.com']);
});

test('the only email address in the repository is the public one, apart from reserved examples', () => {
  const found = textFiles().flatMap((file) =>
    emails(file.text)
      .filter((email) => !isAllowedEmail(email))
      .map((email) => `${file.path}: ${email}`),
  );

  assert.deepEqual(found, []);
});

test("the maintainer's commits carry only the public address", (t) => {
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root }).status !== 0) {
    t.skip('no commits yet');

    return;
  }

  const found = git(['log', '--format=%h%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e'])
    .split('\x1e')
    .map((record) => record.trim().split('\0'))
    .flatMap(([sha = '', author = '', authorEmail = '', committer = '', committerEmail = '', body = '']) => [
      ...(author === maintainer && authorEmail !== publicEmail ? [`${sha} author: ${authorEmail}`] : []),
      ...(committer === maintainer && committerEmail !== publicEmail ? [`${sha} committer: ${committerEmail}`] : []),
      ...(author === maintainer || committer === maintainer
        ? emails(body)
            .filter((email) => !isAllowedEmail(email))
            .map((email) => `${sha} message: ${email}`)
        : []),
    ]);

  assert.deepEqual(found, []);
});

test('the plugin ships the same license as the repository', () => {
  assert.equal(
    readFileSync(join(root, 'plugins/lz-gardening/LICENSE'), 'utf8'),
    readFileSync(join(root, 'LICENSE'), 'utf8'),
  );
});

test('CI tests the Node.js version package.json names as its floor', () => {
  const engine = /"node":\s*">=([\d.]+)"/.exec(readFileSync(join(root, 'package.json'), 'utf8'))?.[1];
  const matrix = /^\s*node: \[(.*)\]$/m.exec(readFileSync(join(root, '.github/workflows/check.yml'), 'utf8'))?.[1];

  assert.ok(engine !== undefined, 'package.json names no ">=" floor in engines.node');
  assert.ok(matrix !== undefined, 'check.yml has no node matrix');
  assert.ok(
    matrix
      .split(',')
      .map((entry) => entry.trim().replaceAll("'", ''))
      .includes(engine),
    matrix,
  );
});

test('the own-tools scan finds a named tool', () => {
  assert.ok(ownTools.some((needle) => needle.test('run `/correct` after a fix')));
});

test("shipped plugin files name none of the maintainer's own plugins or skills", () => {
  const found = textFiles('plugins/lz-gardening/').flatMap((file) =>
    file.text
      .split('\n')
      .flatMap((line, index) =>
        ownTools
          .filter((needle) => needle.test(line))
          .map((needle) => `${file.path}:${String(index + 1)}: ${String(needle)}`),
      ),
  );

  assert.deepEqual(found, []);
});
