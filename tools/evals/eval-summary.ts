// Pass@k and Pass^k per eval and configuration of an eval iteration, which skill-creator's aggregate_benchmark.py does
// not report. Repository-only; nothing here ships with the plugin. eval-benchmark.ts writes it as summary.md.

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
