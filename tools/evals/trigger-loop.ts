// The description optimization loop of skill-creator's run_loop.py (claude-plugins-official, Apache License 2.0),
// with the trigger evaluation and the model call passed in. Repository-only; nothing here ships with the plugin.
import type { EvalQuery } from './trigger-cases.ts';
import { improvePrompt, maxDescription, parseDescription, shortenPrompt } from './trigger-improve.ts';
import type { Results } from './trigger-results.ts';

export interface LoopInput {
  readonly skillName: string;
  readonly skillContent: string;
  readonly original: string;
  readonly train: readonly EvalQuery[];
  readonly test: readonly EvalQuery[];
  readonly maxIterations: number;
}

export interface LoopDeps {
  readonly evaluate: (description: string, queries: readonly EvalQuery[], iteration: number) => Promise<Results>;
  readonly improve: (prompt: string) => Promise<string>;
}

export interface Iteration {
  readonly iteration: number;
  readonly description: string;
  readonly train: Results;
  readonly test: Results | undefined;
}

export interface LoopResult {
  readonly exit_reason: string;
  readonly original_description: string;
  readonly best_description: string;
  readonly best_score: string;
  readonly best_train_score: string;
  readonly best_test_score: string | null;
  readonly final_description: string;
  readonly iterations_run: number;
  readonly train_size: number;
  readonly test_size: number;
  readonly history: readonly Iteration[];
}

function subset(all: Results, queries: readonly EvalQuery[]): Results {
  const wanted = new Set(queries.map(({ query }) => query));
  const results = all.results.filter(({ query }) => wanted.has(query));
  const passed = results.filter((result) => result.pass).length;

  return { results, summary: { passed, failed: results.length - passed, total: results.length } };
}

function score(results: Results | undefined): string {
  return results === undefined ? '?' : `${String(results.summary.passed)}/${String(results.summary.total)}`;
}

// Train and test queries run in one evaluation; the model that writes the next description sees train results only.
// The best iteration is the one with the most test queries passed (train, with no test set); the earliest wins a tie.
export async function optimize(input: LoopInput, deps: LoopDeps): Promise<LoopResult> {
  const history: Iteration[] = [];
  let description = input.original;
  let exit = '';

  for (let iteration = 1; exit === ''; iteration += 1) {
    const all = await deps.evaluate(description, [...input.train, ...input.test], iteration);
    const train = subset(all, input.train);
    const test = input.test.length === 0 ? undefined : subset(all, input.test);
    history.push({ iteration, description, train, test });

    if (train.summary.failed === 0) {
      exit = `all_passed (iteration ${String(iteration)})`;
    } else if (iteration >= input.maxIterations) {
      exit = `max_iterations (${String(input.maxIterations)})`;
    } else {
      const prompt = improvePrompt({
        skillName: input.skillName,
        skillContent: input.skillContent,
        current: description,
        train,
        history: history.map((entry) => ({ description: entry.description, train: entry.train })),
      });
      const proposed = parseDescription(await deps.improve(prompt));
      description =
        proposed.length > maxDescription
          ? parseDescription(await deps.improve(shortenPrompt(prompt, proposed)))
          : proposed;
    }
  }

  const passedOf = (entry: Iteration): number => (entry.test ?? entry.train).summary.passed;
  const best = history.reduce((top, entry) => (passedOf(entry) > passedOf(top) ? entry : top));

  return {
    exit_reason: exit,
    original_description: input.original,
    best_description: best.description,
    best_score: score(best.test ?? best.train),
    best_train_score: score(best.train),
    best_test_score: best.test === undefined ? null : score(best.test),
    final_description: description,
    iterations_run: history.length,
    train_size: input.train.length,
    test_size: input.test.length,
    history,
  };
}
