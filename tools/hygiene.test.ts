// Repository-only checks; nothing here ships with the plugin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const maintainer = 'Lars Gyrup Brink Nielsen';
const publicEmail = 'larsbrinknielsen@gmail.com';
const emailShape = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi;

// The plugin must stand alone: it names none of the maintainer's own plugins or skills.
const ownTools = [
  /\bpstack\b/i,
  /\blars-[a-z]/i,
  /\blz-(?:tdd|advisor|engineering|cybernetics)\b/i,
  /\blz\.windows\b/i,
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

function gitPaths(args: readonly string[]): readonly string[] {
  return git(['ls-files', '-z', ...args])
    .split('\0')
    .filter((path) => path !== '');
}

function textFiles(prefix = ''): { readonly path: string; readonly text: string }[] {
  return gitPaths(['--cached', '--others', '--exclude-standard', '--', `${prefix}.`])
    .filter((path) => existsSync(join(root, path)))
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

const trailerName =
  /^(?:Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Helped-by|Cc):\s*(.*?)\s*<[^<>]+>\s*$/i;

// "Lars Nielsen" is a common Danish name, so only forms that keep a middle name mark a name as the maintainer's.
const maintainerForms = [
  maintainer,
  'Lars Gyrup',
  'Lars Brink',
  'Lars Gyrup Brink',
  'Lars Gyrup Nielsen',
  'Lars Brink Nielsen',
].map((form) => form.replaceAll(' ', '').toLowerCase());

// Insertions, deletions, substitutions and swaps of two neighbouring letters each count as one edit.
function editDistance(from: string, to: string): number {
  const rows = [Array.from({ length: to.length + 1 }, (_, column) => column)];

  for (let row = 1; row <= from.length; row++) {
    const above = rows[row - 1] ?? [];
    const current = [row];

    for (let column = 1; column <= to.length; column++) {
      const substitution = (above[column - 1] ?? 0) + (from[row - 1] === to[column - 1] ? 0 : 1);
      const swapped = row > 1 && column > 1 && from[row - 1] === to[column - 2] && from[row - 2] === to[column - 1];
      const swap = swapped ? (rows[row - 2]?.[column - 2] ?? 0) + 1 : Infinity;

      current.push(Math.min((above[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution, swap));
    }

    rows.push(current);
  }

  return rows[from.length]?.[to.length] ?? 0;
}

// A misspelling counts within one edit per eight letters of the form, and at least one.
function namesMaintainer(name: string): boolean {
  const squashed = name.replaceAll(/\s/g, '').toLowerCase();

  return maintainerForms.some((form) => editDistance(squashed, form) <= Math.max(1, Math.floor(form.length / 8)));
}

// A trailer naming someone else (Co-authored-by and the like) holds their address, which is theirs to choose.
function messageLeaks(message: string): string[] {
  return message.split('\n').flatMap((line) => {
    const name = trailerName.exec(line)?.[1];

    return name === undefined || namesMaintainer(name) ? emails(line).filter((email) => !isAllowedEmail(email)) : [];
  });
}

interface Commit {
  readonly sha: string;
  readonly author: string;
  readonly authorEmail: string;
  readonly committer: string;
  readonly committerEmail: string;
  readonly body: string;
}

function commitLeaks({ sha, author, authorEmail, committer, committerEmail, body }: Commit): string[] {
  const byAuthor = namesMaintainer(author);
  const byCommitter = namesMaintainer(committer);

  return [
    ...(byAuthor && authorEmail !== publicEmail ? [`${sha} author: ${authorEmail}`] : []),
    ...(byCommitter && committerEmail !== publicEmail ? [`${sha} committer: ${committerEmail}`] : []),
    ...(byAuthor || byCommitter ? messageLeaks(body).map((email) => `${sha} message: ${email}`) : []),
  ];
}

test('the email scan finds addresses and skips package versions', () => {
  assert.deepEqual(emails('mail x.y@mail.example.com, not pkg@1.2.3'), ['x.y@mail.example.com']);
});

// Built at run time so the repository scan does not report the fixture itself.
const contributorEmail = ['ada', 'example.org'].join('@');

test("a contributor's co-author trailer in the maintainer's commit is theirs to choose", () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: Ada Contributor <${contributorEmail}>\n`), []);
});

test('a co-author trailer naming the maintainer must carry the public address', () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: ${maintainer} <${contributorEmail}>`), [
    contributorEmail,
  ]);
});

test('a co-author trailer naming the maintainer by a shorter form of the name must carry the public address', () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nco-authored-by: lars gyrup nielsen <${contributorEmail}>`), [
    contributorEmail,
  ]);
});

test('a co-author trailer naming the maintainer by first name and the second middle name must carry the public address', () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: Lars Brink <${contributorEmail}>`), [
    contributorEmail,
  ]);
});

test("a co-author trailer misspelling the maintainer's name by a letter or two must carry the public address", () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: Lars Gyrp Brink Nielson <${contributorEmail}>`), [
    contributorEmail,
  ]);
});

test("a co-author trailer swapping two letters of the maintainer's short name must carry the public address", () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: Lasr Brink <${contributorEmail}>`), [
    contributorEmail,
  ]);
});

test("a commit authored under a shorter form of the maintainer's name must carry the public address", () => {
  assert.deepEqual(
    commitLeaks({
      sha: 'abc1234',
      author: 'Lars Brink',
      authorEmail: contributorEmail,
      committer: 'Ada Contributor',
      committerEmail: contributorEmail,
      body: 'fix: a thing',
    }),
    [`abc1234 author: ${contributorEmail}`],
  );
});

test('a co-author named Lars Nielsen keeps their own address', () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nCo-authored-by: Lars Nielsen <${contributorEmail}>`), []);
});

test('a line shaped like a trailer whose key is no git trailer is read as message text', () => {
  assert.deepEqual(messageLeaks(`fix: a thing\n\nContact: Ada Contributor <${contributorEmail}>`), [contributorEmail]);
});

test('an address in the message text is reported', () => {
  assert.deepEqual(messageLeaks(`fix: write to ${contributorEmail}`), [contributorEmail]);
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
    .flatMap(([sha = '', author = '', authorEmail = '', committer = '', committerEmail = '', body = '']) =>
      commitLeaks({ sha, author, authorEmail, committer, committerEmail, body }),
    );

  assert.deepEqual(found, []);
});

test('the plugin ships the same license as the repository', () => {
  assert.equal(
    readFileSync(join(root, 'plugins/lz-gardening/LICENSE'), 'utf8'),
    readFileSync(join(root, 'LICENSE'), 'utf8'),
  );
});

test('no file under a node_modules folder is committed, the plugin folder included', () => {
  assert.deepEqual(gitPaths(['--', ':(glob)**/node_modules/**']), []);
});

test('CI tests the Node.js version package.json names as its floor', () => {
  const engine = /"node":\s*">=([\d.]+)"/.exec(readFileSync(join(root, 'package.json'), 'utf8'))?.[1];
  const matrix = /^\s*node: \[(.*)\]$/m.exec(readFileSync(join(root, '.github/workflows/check.yml'), 'utf8'))?.[1];

  assert.ok(engine !== undefined, 'package.json names no ">=" floor in engines.node');
  assert.ok(matrix !== undefined, 'check.yml has no node matrix');
  assert.ok(
    matrix
      .split(',')
      .map((entry) => entry.trim().replaceAll(/['"]/g, ''))
      .includes(engine),
    matrix,
  );
});

test('the own-tools scan finds a named tool', () => {
  assert.ok(ownTools.some((needle) => needle.test('run `/correct` after a fix')));
});

test("the own-tools scan finds the maintainer's other lz plugins", () => {
  assert.deepEqual(
    ['install lz.windows first', 'see lz-cybernetics'].filter((line) => !ownTools.some((needle) => needle.test(line))),
    [],
  );
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
