// Pass@k and Pass^k per eval and configuration of an eval iteration, which skill-creator's aggregate_benchmark.py does
// not report. Repository-only; nothing here ships with the plugin.
//   node tools/evals/eval-summary.ts <iteration dir>   writes <iteration dir>/summary.md
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

// A run passes in full when it has graded expectations, every one passed, and none waits for the judge.
function outcome(iteration: string, grading: string): RunOutcome {
  const [evalName = '', config = ''] = grading.split(sep);
  const parsed: unknown = JSON.parse(readFileSync(join(iteration, grading), 'utf8'));
  const summary = isRecord(parsed) ? parsed['summary'] : undefined;
  const notes = isRecord(parsed) ? parsed['user_notes_summary'] : undefined;
  const pending = isRecord(notes) && Array.isArray(notes['needs_review']) ? notes['needs_review'].length : 0;
  const fullyPassed = isRecord(summary) && summary['failed'] === 0 && Number(summary['total']) > 0 && pending === 0;

  return { evalName, config, fullyPassed };
}

if (isMainModule(import.meta.url)) {
  const iteration = process.argv[2] ?? '';

  if (!existsSync(iteration)) {
    throw new Error(`usage: eval-summary.ts <iteration dir> (${iteration} does not exist)`);
  }

  const gradings = globSync(join('eval-*', '*', 'run-*', 'grading.json'), { cwd: iteration });
  writeFileSync(
    join(iteration, 'summary.md'),
    `${summaryTable(gradings.map((grading) => outcome(iteration, grading)))}\n`,
  );
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }

  let result = 1;

  for (let index = 1; index <= k; index += 1) {
    result = (result * (n - k + index)) / index;
  }

  return result;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RunOutcome {
  readonly evalName: string;
  readonly config: string;
  readonly fullyPassed: boolean;
}

const ks = [1, 3, 5];

function row(label: string, config: string, outcomes: readonly RunOutcome[]): string {
  const n = outcomes.length;
  const c = outcomes.filter((outcome) => outcome.fullyPassed).length;
  const cells = [
    ...ks.map((k) => passAt(n, c, k)),
    passAt(n, c, n),
    ...ks.map((k) => passHat(n, c, k)),
    passHat(n, c, n),
  ];

  return `| ${[label, config, n, c, ...cells].join(' | ')} |`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function summaryTable(runs: readonly RunOutcome[]): string {
  const configs = sortedUnique(runs.map((run) => run.config));
  const evals = sortedUnique(runs.map((run) => run.evalName)).flatMap((evalName) => {
    const own = runs.filter((run) => run.evalName === evalName);
    const label = own.every((run) => run.fullyPassed) ? `${evalName} (saturated)` : evalName;

    return configs
      .map((config) => ({ config, outcomes: own.filter((run) => run.config === config) }))
      .filter(({ outcomes }) => outcomes.length > 0)
      .map(({ config, outcomes }) => row(label, config, outcomes));
  });
  const overall = configs.map((config) =>
    row(
      'overall',
      config,
      runs.filter((run) => run.config === config),
    ),
  );
  const headings = [
    'Eval',
    'Config',
    'Runs',
    'Fully passed',
    'Pass@1',
    'Pass@3',
    'Pass@5',
    'Pass@n',
    'Pass^1',
    'Pass^3',
    'Pass^5',
    'Pass^n',
  ];

  return [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`, ...evals, ...overall].join(
    '\n',
  );
}

// n runs, c of them fully passed; k above n reads as n, since no more samples exist.
export function passAt(n: number, c: number, k: number): number {
  const samples = Math.min(k, n);

  return rounded(1 - choose(n - c, samples) / choose(n, samples));
}

export function passHat(n: number, c: number, k: number): number {
  const samples = Math.min(k, n);

  return rounded(choose(c, samples) / choose(n, samples));
}
