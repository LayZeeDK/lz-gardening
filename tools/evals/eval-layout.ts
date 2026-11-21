// The eval iteration folder and the files that describe it, read and named in one place:
//
//   <iteration>/iteration.json                      configs (name -> {plugin, commit, text}), models, runs
//   <iteration>/eval-<case>-<model>/eval_metadata.json
//   <iteration>/eval-<case>-<model>/<config>/run-<k>/outputs/result.json, grading.json, timing.json
//
// Repository-only; nothing here ships with the plugin.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

export interface Iteration {
  readonly configs: Readonly<Record<string, string>>;
  readonly models: readonly string[];
  readonly runs: number;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Each configuration's plugin folder, absolute, in the order iteration.json names them: the first is the one under
// test, the second its baseline.
export function readIteration(iterationDir: string): Iteration {
  const file = `${iterationDir}/iteration.json`;
  const parsed = readJson(file);
  const configs = isRecord(parsed) && isRecord(parsed['configs']) ? Object.entries(parsed['configs']) : [];
  const plugins = configs.flatMap(([name, config]) =>
    isRecord(config) && typeof config['plugin'] === 'string'
      ? [[name, resolve(config['plugin']).replaceAll('\\', '/')] as const]
      : [],
  );
  const models = isRecord(parsed) && Array.isArray(parsed['models']) ? parsed['models'] : [];
  const runs = isRecord(parsed) ? parsed['runs'] : undefined;

  if (
    plugins.length === 0 ||
    plugins.length !== configs.length ||
    models.length === 0 ||
    !models.every((model) => typeof model === 'string') ||
    typeof runs !== 'number'
  ) {
    throw new Error(`${file} needs configs (name -> {plugin}), models and runs`);
  }

  return { configs: Object.fromEntries(plugins), models, runs };
}

export interface Assertion {
  readonly text: string;
  readonly check?: string;
}

export function isAssertion(value: unknown): value is Assertion {
  return (
    isRecord(value) &&
    typeof value['text'] === 'string' &&
    (value['check'] === undefined || typeof value['check'] === 'string')
  );
}

export function evalFolder(iterationDir: string, evalCase: string, model: string): string {
  return `${iterationDir}/eval-${evalCase}-${model}`;
}

export function runFolder(iterationDir: string, evalCase: string, model: string, config: string, run: number): string {
  return `${evalFolder(iterationDir, evalCase, model)}/${config}/run-${String(run)}`;
}

// A run folder's eval folder, two levels up.
export function evalFolderOf(runDir: string): string {
  return resolve(runDir, '..', '..');
}
