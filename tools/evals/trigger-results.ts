// Per-query trigger results, in skill-creator's run_eval.py schema, from a `claude plugin eval --json` result.
// Repository-only; nothing here ships with the plugin.
import { isRecord } from '../../plugins/tometo/skills/garden/scripts/log-guard.ts';
import type { EvalQuery } from './trigger-cases.ts';

export interface QueryResult extends EvalQuery {
  readonly triggers: number;
  readonly runs: number;
  readonly trigger_rate: number;
  readonly pass: boolean;
}

export interface Results {
  readonly results: readonly QueryResult[];
  readonly summary: { readonly passed: number; readonly failed: number; readonly total: number };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// A run's verdict from its `invoked` grader; a run that ended before grading (an API error) has none.
function invoked(run: unknown): boolean | undefined {
  const grader = list(isRecord(run) ? run['graders'] : undefined).find(
    (entry) => isRecord(entry) && entry['name'] === 'invoked',
  );

  return isRecord(grader) && typeof grader['passed'] === 'boolean' ? grader['passed'] : undefined;
}

export function queryResults(
  pluginEval: unknown,
  names: Readonly<Record<string, string>>,
  queries: readonly EvalQuery[],
  threshold: number,
): Results {
  const cases = list(isRecord(pluginEval) ? pluginEval['cases'] : undefined);
  const results = Object.entries(names).map(([name, query]) => {
    const found = cases.find((entry) => isRecord(entry) && entry['name'] === name);
    const arms = isRecord(found) ? found['arms'] : undefined;
    const runs = list(isRecord(arms) ? arms['with'] : undefined);

    // A session the usage limit ends reports no turn and no error, and its run would count as not triggered.
    if (runs.some((entry) => isRecord(entry) && entry['turns'] === 0)) {
      throw new Error(`${name} (${query}) has a run that took no turn: a usage limit or an API stop ended it`);
    }

    const verdicts = runs.map(invoked).filter((verdict) => verdict !== undefined);
    const shouldTrigger = queries.find((entry) => entry.query === query)?.should_trigger;

    if (verdicts.length === 0 || shouldTrigger === undefined) {
      throw new Error(`${name} (${query}) has no graded run in the plugin eval result, or no query in the set`);
    }

    const triggers = verdicts.filter(Boolean).length;
    const rate = triggers / verdicts.length;

    return {
      query,
      should_trigger: shouldTrigger,
      triggers,
      runs: verdicts.length,
      trigger_rate: Math.round(rate * 10_000) / 10_000,
      pass: shouldTrigger ? rate >= threshold : rate < threshold,
    };
  });
  const passed = results.filter((result) => result.pass).length;

  return { results, summary: { passed, failed: results.length - passed, total: results.length } };
}
