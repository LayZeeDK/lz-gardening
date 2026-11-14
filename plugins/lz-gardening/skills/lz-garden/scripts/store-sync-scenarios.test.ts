import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay, weedId } from './log.ts';
import type { GardenEvent } from './log.ts';
import { openSite, readLog } from './store-log.ts';
import { sync } from './store-sync.ts';
import { now } from './test-repo.ts';
import { configEnv, sharedPair } from './test-site.ts';
import { cli } from './test-weeds.ts';

const weed = { class: 'any-type', where: 'src/a.ts:1', source: 'census:x' } as const;
const id = weedId(weed.class, weed.where, weed.source);
const later = { class: 'any-type', where: 'src/b.ts:1', source: 'census:x' } as const;
const laterId = weedId(later.class, later.where, later.source);

function run(dir: string, args: readonly string[]): void {
  const result = cli(dir, args);
  assert.equal(result.status, 0, result.stderr);
}

function cliWithShareOff(dir: string, args: readonly string[]): void {
  const result = cli(dir, args, configEnv([['lzGardening.share', 'false']]));
  assert.equal(result.status, 0, result.stderr);
}

function add(dir: string, found: typeof weed | typeof later): void {
  run(dir, ['add', '--class', found.class, '--where', found.where, '--source', found.source]);
}

function status(events: readonly GardenEvent[], weedOf: string): string {
  const found = replay(events, now).statusOf(weedOf);

  if (found === undefined) {
    return 'none';
  }

  if (found.state === 'closed') {
    return `closed ${found.kind}`;
  }

  return found.weed.regrownAfter === null ? 'added' : 'regrown';
}

interface Sites {
  readonly a: string;
  readonly b: string;
  readonly share: () => void;
}

const scenarios: readonly {
  readonly name: string;
  readonly act: (sites: Sites) => void;
  readonly weedOf: string;
  readonly expected: string;
}[] = [
  {
    name: 'the same weed found by both sites at once is one open weed',
    act: ({ a, b }) => {
      add(a, weed);
      add(b, weed);
    },
    weedOf: id,
    expected: 'added',
  },
  {
    name: 'a close beside an add of the same weed the closer never saw closes it',
    act: ({ a, b }) => {
      add(a, weed);
      add(b, weed);
      run(b, ['close', '--id', id, '--one-off', 'fixed by hand']);
    },
    weedOf: id,
    expected: 'closed one-off',
  },
  {
    name: 'a weed found again after a close its finder saw is open again',
    act: ({ a, b, share }) => {
      add(a, weed);
      run(a, ['close', '--id', id, '--one-off', 'fixed by hand']);
      share();
      add(b, weed);
    },
    weedOf: id,
    expected: 'added',
  },
  {
    name: 'an add beside a tend pass of its class that its writer never saw is added, not regrown',
    act: ({ a, b }) => {
      add(a, weed);
      run(a, ['claim', '--class', weed.class]);
      run(a, ['close-class', '--class', weed.class, '--tended', 'bed/any-type@abc1234', '--check', 'src/check.ts']);
      add(b, later);
    },
    weedOf: laterId,
    expected: 'added',
  },
  {
    name: 'an add after a tend pass of its class that its writer saw is regrown',
    act: ({ a, b, share }) => {
      add(a, weed);
      run(a, ['claim', '--class', weed.class]);
      run(a, ['close-class', '--class', weed.class, '--tended', 'bed/any-type@abc1234', '--check', 'src/check.ts']);
      share();
      add(b, later);
    },
    weedOf: laterId,
    expected: 'regrown',
  },
  {
    name: 'a keep beside an add of the same weed the keeper never saw keeps it',
    act: ({ a, b }) => {
      add(a, weed);
      add(b, weed);
      run(b, ['close', '--id', id, '--keep', 'deliberate']);
    },
    weedOf: id,
    expected: 'closed kept',
  },
  {
    name: 'two closes of one weed at once leave it closed by the later of the two',
    act: ({ a, b, share }) => {
      add(a, weed);
      share();
      run(a, ['close', '--id', id, '--one-off', 'fixed by hand']);
      cliWithShareOff(b, ['close', '--id', id, '--one-off', 'fixed again']);
    },
    weedOf: id,
    expected: 'closed one-off',
  },
];

for (const scenario of scenarios) {
  test(`two sites that share one origin replay as one writer: ${scenario.name}`, (t) => {
    const { first, second } = sharedPair(t);
    const share = (): void => {
      [first.dir, second.dir, first.dir].forEach((dir) => {
        assert.equal(sync(openSite(dir), { attempts: 1 }).state, 'synced');
      });
    };
    scenario.act({ a: first.dir, b: second.dir, share });
    const union = [
      ...new Map(
        [first.dir, second.dir].flatMap((dir) => readLog(openSite(dir)).events).map((event) => [event.uuid, event]),
      ).values(),
    ];

    share();

    assert.deepEqual(
      [
        status(readLog(openSite(first.dir)).events, scenario.weedOf),
        status(readLog(openSite(second.dir)).events, scenario.weedOf),
        status(union, scenario.weedOf),
      ],
      [scenario.expected, scenario.expected, scenario.expected],
    );
  });
}
