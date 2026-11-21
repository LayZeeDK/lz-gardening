// Trigger eval cases for `claude plugin eval`, adapted from skill-creator's run_loop.py and run_eval.py
// (claude-plugins-official, Apache License 2.0). Repository-only; nothing here ships with the plugin.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EvalQuery {
  readonly query: string;
  readonly should_trigger: boolean;
}

export interface Split {
  readonly train: readonly EvalQuery[];
  readonly test: readonly EvalQuery[];
}

export interface SkillParts {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const frontmatter = /^---\n([\s\S]*?)\n---\n/;

function field(skill: string, key: string): string {
  const lines = frontmatter.exec(skill)?.[1]?.split('\n') ?? [];
  const line = lines.find((entry) => entry.startsWith(`${key}:`));
  const value = line?.slice(key.length + 1).trim();

  if (value === undefined || value === '' || /^[|>']/.test(value)) {
    throw new Error(`the skill's ${key} is not a one-line plain or double-quoted frontmatter value`);
  }

  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);

    return typeof parsed === 'string' ? parsed : '';
  }

  return value;
}

// Reads the one-line `name` and `description` of a SKILL.md, plain or double-quoted, and refuses other YAML forms.
export function skillParts(skill: string): SkillParts {
  return {
    name: field(skill, 'name'),
    description: field(skill, 'description'),
    body: skill.replace(frontmatter, '').replace(/^\n+/, ''),
  };
}

// A JSON string is a YAML double-quoted scalar, so any description survives the frontmatter.
export function withDescription(skill: string, description: string): string {
  field(skill, 'description');

  return skill.replace(frontmatter, (block) =>
    block.replace(/^description:.*$/m, () => `description: ${JSON.stringify(description)}`),
  );
}

// One case per query, named q01, q02, ... and tagged train or test. Its one grader passes when the run invoked the
// skill, so a case's score over its runs is the query's trigger rate, whichever way the query should go. Three turns
// and the read-only tools are enough to reach the Skill call and keep a run short.
export function writeCases(evals: string, skill: string, split: Split): Record<string, string> {
  if (!/^[a-z0-9-]+$/.test(skill)) {
    throw new Error(`skill name ${skill} is not lowercase letters, digits and hyphens`);
  }

  const queries = [
    ...split.train.map((query) => ({ ...query, tag: 'train' })),
    ...split.test.map((query) => ({ ...query, tag: 'test' })),
  ];
  const grader = [
    '---',
    'type: tool_used',
    'tool: Skill',
    `input_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill}"'`,
    'arm: both',
    '---',
    '',
  ].join('\n');

  return Object.fromEntries(
    queries.map(({ query, tag }, index) => {
      const name = `q${String(index + 1).padStart(2, '0')}`;
      const prompt = [
        '---',
        `name: ${name}`,
        `tags: [${tag}]`,
        'max_turns: 3',
        'allowed_tools: [Read, Glob, Grep, Skill]',
        '---',
        '',
        query,
        '',
      ].join('\n');

      mkdirSync(join(evals, name, 'graders'), { recursive: true });
      writeFileSync(join(evals, name, 'prompt.md'), prompt);
      writeFileSync(join(evals, name, 'graders', 'invoked.md'), grader);

      return [name, query];
    }),
  );
}

// mulberry32: a small seeded generator, so a split is the same on every run and machine.
function generator(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = copy[index];
    const swapped = copy[other];

    if (held !== undefined && swapped !== undefined) {
      copy[index] = swapped;
      copy[other] = held;
    }
  }

  return copy;
}

// Stratified by should_trigger, as skill-creator splits: each kind gives its share, and at least one, to the test set;
// a holdout of 0 keeps no test set.
export function splitEvalSet(set: readonly EvalQuery[], holdout: number, seed: number): Split {
  if (holdout === 0) {
    return { train: [...set], test: [] };
  }

  const random = generator(seed);
  const parts = [true, false].map((kind) => {
    const own = shuffled(
      set.filter((query) => query.should_trigger === kind),
      random,
    );
    const held = own.length === 0 ? 0 : Math.max(1, Math.floor(own.length * holdout));

    return { test: own.slice(0, held), train: own.slice(held) };
  });

  return { train: parts.flatMap((part) => part.train), test: parts.flatMap((part) => part.test) };
}
