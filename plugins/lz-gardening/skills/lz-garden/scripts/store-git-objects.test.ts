// Run: node --test store-git-objects.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeRequests,
  outOfStep,
  parseContents,
  parseInfos,
  parseTree,
  readStrategyOf,
  walkTree,
} from './store-git-objects.ts';
import type { ObjectContents } from './store-git-objects.ts';

const oid = 'a'.repeat(40);

test('a blob answer in -Z framing parses to its header and bytes', () => {
  const output = Buffer.from(`${oid} blob 5\0hello\0`);

  assert.deepEqual(parseContents(output, ['HEAD:a.txt']), {
    done: true,
    answers: [['HEAD:a.txt', { kind: 'object', oid, type: 'blob', size: 5, bytes: Buffer.from('hello') }]],
    end: output.length,
  });
});

test('a name git has no object for, spaces included, parses as missing', () => {
  const output = Buffer.from('HEAD:a b.txt missing\0');

  assert.deepEqual(parseContents(output, ['HEAD:a b.txt']), {
    done: true,
    answers: [['HEAD:a b.txt', { kind: 'missing' }]],
    end: output.length,
  });
});

test('one answer per name, in the order asked', () => {
  const output = Buffer.from(`${oid} blob 2\0hi\0gone missing\0`);

  assert.deepEqual(parseContents(output, ['HEAD:a.txt', 'gone']), {
    done: true,
    answers: [
      ['HEAD:a.txt', { kind: 'object', oid, type: 'blob', size: 2, bytes: Buffer.from('hi') }],
      ['gone', { kind: 'missing' }],
    ],
    end: output.length,
  });
});

test('output that ends inside a header has no answer yet', () => {
  assert.deepEqual(parseContents(Buffer.from(`${oid} blob 2`), ['HEAD:a.txt']), { done: false, answers: [], end: 0 });
});

test('a parse that stops inside an answer gives the answers before it and the byte where they end', () => {
  const whole = `gone missing\0${oid} blob 5\0hello\0`;

  assert.deepEqual(parseContents(Buffer.from(whole.slice(0, -4)), ['gone', 'HEAD:a.txt']), {
    done: false,
    answers: [['gone', { kind: 'missing' }]],
    end: 'gone missing\0'.length,
  });
});

test("output that ends with an object's bytes but not their closing NUL has no answer yet", () => {
  const whole = `${oid} blob 5\0hello\0`;

  assert.deepEqual(parseContents(Buffer.from(whole.slice(0, -1)), ['HEAD:a.txt']), {
    done: false,
    answers: [],
    end: 0,
  });
});

test('--batch framing ends headers and objects with a line break', () => {
  const output = Buffer.from(`gone missing\n${oid} blob 3\na\0b\n`);

  assert.deepEqual(parseContents(output, ['gone', 'HEAD:a.txt'], '\n'), {
    done: true,
    answers: [
      ['gone', { kind: 'missing' }],
      ['HEAD:a.txt', { kind: 'object', oid, type: 'blob', size: 3, bytes: Buffer.from('a\0b') }],
    ],
    end: output.length,
  });
});

test('info answers are headers alone, an object or missing per name', () => {
  const output = Buffer.from(`${oid} commit 136\0gone missing\0`);

  assert.deepEqual(parseInfos(output, ['HEAD', 'gone']), {
    done: true,
    answers: [
      ['HEAD', { kind: 'object', oid, type: 'commit', size: 136 }],
      ['gone', { kind: 'missing' }],
    ],
    end: output.length,
  });
});

test('a missing name whose last word is a number parses as missing, not as an object', () => {
  const output = Buffer.from('HEAD:a b 12 missing\0');

  assert.deepEqual(parseInfos(output, ['HEAD:a b 12']), {
    done: true,
    answers: [['HEAD:a b 12', { kind: 'missing' }]],
    end: output.length,
  });
});

test('a header of more than three fields parses as missing', () => {
  const output = Buffer.from(`HEAD ${oid} commit 136\0`);

  assert.deepEqual(parseInfos(output, ['HEAD']), {
    done: true,
    answers: [['HEAD', { kind: 'missing' }]],
    end: output.length,
  });
});

test('info output that ends inside a header gives the answers before it and the byte where they end', () => {
  const output = Buffer.from(`${oid} commit 136\0gone mis`);

  assert.deepEqual(parseInfos(output, ['HEAD', 'gone']), {
    done: false,
    answers: [['HEAD', { kind: 'object', oid, type: 'commit', size: 136 }]],
    end: `${oid} commit 136\0`.length,
  });
});

test('answers that end where the output ends are in step', () => {
  assert.equal(outOfStep([['HEAD', { kind: 'object', oid, type: 'commit', size: 136 }]], 60, 60), undefined);
});

test('output that goes on past the last answer is out of step', () => {
  assert.equal(
    outOfStep([['HEAD', { kind: 'object', oid, type: 'commit', size: 136 }]], 60, 61),
    'the output goes on past the last answer',
  );
});

test('an answer that names another object than the object id asked for is out of step', () => {
  const other = 'b'.repeat(40);

  assert.equal(
    outOfStep([[oid, { kind: 'object', oid: other, type: 'blob', size: 1 }]], 60, 60),
    `the answer to ${oid} names ${other}`,
  );
});

test('requests are one verb and name per NUL-ended line, then a flush', () => {
  assert.equal(encodeRequests('info', ['HEAD', 'HEAD:a b.txt']), 'info HEAD\0info HEAD:a b.txt\0flush\0');
});

test('a name holding NUL is refused, so it cannot add a request of its own', () => {
  assert.throws(() => encodeRequests('contents', ['HEAD\0flush']), {
    message: 'git cannot read a name that holds NUL: "HEAD\\u0000flush"',
  });
});

test('a tree entry is a mode, a name and the raw object id', () => {
  const bytes = Buffer.concat([Buffer.from('100644 a b.txt\0'), Buffer.from(oid, 'hex')]);

  assert.deepEqual(parseTree(bytes, 20), [{ mode: '100644', name: 'a b.txt', oid }]);
});

test('tree entries follow each other in stored order', () => {
  const other = 'b'.repeat(40);
  const bytes = Buffer.concat([
    Buffer.from('40000 events\0'),
    Buffer.from(oid, 'hex'),
    Buffer.from('100644 garden.json\0'),
    Buffer.from(other, 'hex'),
  ]);

  assert.deepEqual(parseTree(bytes, 20), [
    { mode: '40000', name: 'events', oid },
    { mode: '100644', name: 'garden.json', oid: other },
  ]);
});

test('a SHA-256 tree holds 32-byte object ids, and an empty tree holds no entry', () => {
  const long = 'c'.repeat(64);
  const bytes = Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(long, 'hex')]);

  assert.deepEqual(
    [parseTree(bytes, 32), parseTree(Buffer.alloc(0), 20)],
    [[{ mode: '100644', name: 'a.txt', oid: long }], []],
  );
});

test('a tree whose entry has no space or no NUL is refused, not walked', () => {
  assert.throws(() => parseTree(Buffer.from('100644a.txt'), 20), { message: 'a tree entry is malformed at byte 0' });
});

test('a tree entry with no space is refused even when its last byte is NUL', () => {
  const bytes = Buffer.concat([Buffer.from('100644a.txt\0'), Buffer.alloc(20)]);

  assert.throws(() => parseTree(bytes, 20), { message: 'a tree entry is malformed at byte 0' });
});

test('a tree entry whose name runs to the end without a NUL is refused', () => {
  const bytes = Buffer.concat([Buffer.from('100644 a.txt\0'), Buffer.from(oid, 'hex'), Buffer.from('100644 b.txt')]);

  assert.throws(() => parseTree(bytes, 20), { message: 'a tree entry is malformed at byte 33' });
});

function treeOf(entries: readonly (readonly [mode: string, name: string, oid: string])[]): Buffer {
  return Buffer.concat(
    entries.flatMap(([mode, name, id]) => [Buffer.from(`${mode} ${name}\0`), Buffer.from(id, 'hex')]),
  );
}

function storedObjects(objects: Readonly<Record<string, readonly [type: string, bytes: Buffer, oid: string]>>) {
  const asked: (readonly string[])[] = [];
  const contents = (names: readonly string[]): readonly (readonly [string, ObjectContents])[] => {
    asked.push(names);

    return names.map((name) => {
      const found = objects[name];

      return [
        name,
        found === undefined
          ? { kind: 'missing' }
          : { kind: 'object', oid: found[2], type: found[0], size: found[1].length, bytes: found[1] },
      ];
    });
  };

  return { asked, contents };
}

test("a commit's tree with one file walks to that file", () => {
  const blob = 'b'.repeat(40);
  const { contents } = storedObjects({ 'main^{tree}': ['tree', treeOf([['100644', 'a.txt', blob]]), oid] });

  assert.deepEqual(walkTree(contents, 'main'), [{ type: 'blob', oid: blob, path: 'a.txt' }]);
});

test('folders walk depth first in stored order, as ls-tree -r lists them', () => {
  const events = '1'.repeat(40);
  const ab = '2'.repeat(40);
  const x = '3'.repeat(40);
  const y = '4'.repeat(40);
  const garden = '5'.repeat(40);
  const { contents } = storedObjects({
    'main^{tree}': [
      'tree',
      treeOf([
        ['40000', 'events', events],
        ['100644', 'garden.json', garden],
      ]),
      oid,
    ],
    [events]: ['tree', treeOf([['40000', 'ab', ab]]), events],
    [ab]: [
      'tree',
      treeOf([
        ['100644', 'x.json', x],
        ['100644', 'y.json', y],
      ]),
      ab,
    ],
  });

  assert.deepEqual(walkTree(contents, 'main'), [
    { type: 'blob', oid: x, path: 'events/ab/x.json' },
    { type: 'blob', oid: y, path: 'events/ab/y.json' },
    { type: 'blob', oid: garden, path: 'garden.json' },
  ]);
});

test('the walk asks for every tree of one level in one call', () => {
  const a = '1'.repeat(40);
  const b = '2'.repeat(40);
  const file = '3'.repeat(40);
  const { asked, contents } = storedObjects({
    'main^{tree}': [
      'tree',
      treeOf([
        ['40000', 'a', a],
        ['40000', 'b', b],
      ]),
      oid,
    ],
    [a]: ['tree', treeOf([['100644', 'x.json', file]]), a],
    [b]: ['tree', treeOf([['100644', 'x.json', file]]), b],
  });
  walkTree(contents, 'main');

  assert.deepEqual(asked, [['main^{tree}'], [a, b]]);
});

test('a tree git does not have stops the walk', () => {
  const { contents } = storedObjects({});

  assert.throws(() => walkTree(contents, 'main'), {
    message: 'the tree walk read main^{tree}, which is not a tree',
  });
});

test('an object of another type where a tree should be stops the walk', () => {
  const blob = 'b'.repeat(40);
  const { contents } = storedObjects({
    'main^{tree}': ['tree', treeOf([['40000', 'events', blob]]), oid],
    [blob]: ['blob', treeOf([['100644', 'a.txt', blob]]), blob],
  });

  assert.throws(() => walkTree(contents, 'main'), {
    message: `the tree walk read ${blob}, which is not a tree`,
  });
});

test('a submodule is listed as a commit and not walked', () => {
  const pinned = 'd'.repeat(40);
  const { asked, contents } = storedObjects({ 'main^{tree}': ['tree', treeOf([['160000', 'vendor', pinned]]), oid] });

  assert.deepEqual([walkTree(contents, 'main'), asked.length], [[{ type: 'commit', oid: pinned, path: 'vendor' }], 1]);
});

test('Windows reads through a reader when nothing says otherwise', () => {
  assert.equal(readStrategyOf({}, 'win32'), 'reader');
});

test('every other platform spawns a git per read when nothing says otherwise', () => {
  assert.equal(readStrategyOf({}, 'linux'), 'spawn');
});

test('_LZ_GARDENING_INTERNAL_GIT_READS picks the strategy on any platform', () => {
  assert.deepEqual(
    [
      readStrategyOf({ _LZ_GARDENING_INTERNAL_GIT_READS: 'spawn' }, 'win32'),
      readStrategyOf({ _LZ_GARDENING_INTERNAL_GIT_READS: 'reader' }, 'linux'),
    ],
    ['spawn', 'reader'],
  );
});

test('an empty _LZ_GARDENING_INTERNAL_GIT_READS, as a shell sets for VAR= cmd, says nothing', () => {
  assert.deepEqual(
    [
      readStrategyOf({ _LZ_GARDENING_INTERNAL_GIT_READS: '' }, 'win32'),
      readStrategyOf({ _LZ_GARDENING_INTERNAL_GIT_READS: '' }, 'linux'),
    ],
    ['reader', 'spawn'],
  );
});

test('any other value of _LZ_GARDENING_INTERNAL_GIT_READS is refused, naming both strategies', () => {
  assert.throws(() => readStrategyOf({ _LZ_GARDENING_INTERNAL_GIT_READS: 'batch' }, 'linux'), {
    message: '_LZ_GARDENING_INTERNAL_GIT_READS is "batch"; it takes spawn or reader',
  });
});
