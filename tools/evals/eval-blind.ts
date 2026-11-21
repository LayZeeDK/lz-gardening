// Blind copies of an eval case's runs for an LLM judge, and the judge's verdicts copied back. Repository-only; nothing
// here ships with the plugin.
//
//   node tools/evals/eval-blind.ts blind <iteration dir> <case> <judge 1|2|3> [run dir...]
//   node tools/evals/eval-blind.ts unblind <iteration dir> <case> <judge 1|2|3>
//
// blind writes <iteration dir>/judge-<case>-<judge>/<letter>/ per run (calls.jsonl, final.md, eval_metadata.json and
// run.json with the model, checkout and site), in a random order, with the plugin paths and configuration names
// replaced; the letter key goes beside the folder, where the judge's brief keeps it out of reach. unblind copies each
// letter's llm-grades.json back to its run as that judge's verdict file.
import { randomInt } from 'node:crypto';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isMainModule } from '../../plugins/lz-gardening/skills/lz-garden/scripts/cli.ts';
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';
import { judgeFiles } from './eval-grade.ts';
import { evalFolder, evalFolderOf, readIteration, readJson } from './eval-layout.ts';
import { slimOutput } from './slim-output.ts';

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every spelling of a plugin path a session's calls use: forward slashes, backslashes, JSON-escaped backslashes and
// Git Bash's /d/ form, in any letter case.
export function blindText(text: string, plugins: readonly string[], configs: readonly string[]): string {
  const spellings = plugins.flatMap((plugin) => {
    const drive = /^([A-Za-z]):\/(.*)$/.exec(plugin);

    return [
      plugin.replaceAll('/', '\\\\'),
      plugin.replaceAll('/', '\\'),
      plugin,
      ...(drive === null ? [] : [`/${(drive[1] ?? '').toLowerCase()}/${drive[2] ?? ''}`]),
    ];
  });
  const withoutPlugins = spellings.reduce(
    (blinded, spelling) => blinded.replace(new RegExp(escaped(spelling), 'gi'), '<plugin>'),
    text,
  );

  return configs.reduce((blinded, config) => blinded.replaceAll(config, '<config>'), withoutPlugins);
}

function letter(index: number): string {
  const rest = Math.floor(index / 26);

  return `${rest === 0 ? '' : letter(rest - 1)}${String.fromCharCode(97 + (index % 26))}`;
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    const item = result[index];
    const swapped = result[other];

    if (item !== undefined && swapped !== undefined) {
      result[index] = swapped;
      result[other] = item;
    }
  }

  return result;
}

function judgeName(iterationDir: string, evalCase: string, judge: number): string {
  if (!Number.isInteger(judge) || judge < 1 || judge > judgeFiles.length) {
    throw new Error(`the judge is 1, 2 or 3, not ${String(judge)}`);
  }

  return `${iterationDir}/judge-${evalCase}-${String(judge)}`;
}

// Blinds the named run folders, or every run of the case when none are named.
export function blind(iterationDir: string, evalCase: string, judge: number, runDirs: readonly string[]): void {
  const folder = judgeName(iterationDir, evalCase, judge);
  const { configs, models } = readIteration(iterationDir);
  const runs =
    runDirs.length > 0
      ? runDirs
      : models.flatMap((model) =>
          globSync('*/run-*', { cwd: evalFolder(iterationDir, evalCase, model) })
            .sort()
            .map((run) => `${evalFolder(iterationDir, evalCase, model)}/${run.replaceAll('\\', '/')}`),
        );

  if (existsSync(folder)) {
    throw new Error(`${folder} exists; judge ${String(judge)} of ${evalCase} was blinded before`);
  }

  const ungraded = runs.filter((runDir) => !existsSync(`${runDir}/outputs/calls.jsonl`));

  if (runs.length === 0 || ungraded.length > 0) {
    throw new Error(`grade these runs with eval-grade.ts first: ${ungraded.join(', ') || `no runs of ${evalCase}`}`);
  }

  const hide = (text: string): string => blindText(text, Object.values(configs), Object.keys(configs));
  const key = shuffled(runs).map((runDir, index) => [letter(index), runDir] as const);

  key.forEach(([name, runDir]) => {
    const target = `${folder}/${name}`;
    const { cwd } = slimOutput(readJson(`${runDir}/outputs/result.json`));
    const model = basename(evalFolderOf(runDir)).slice(`eval-${evalCase}-`.length);
    mkdirSync(target, { recursive: true });
    ['calls.jsonl', 'final.md'].forEach((file) => {
      writeFileSync(`${target}/${file}`, hide(readFileSync(`${runDir}/outputs/${file}`, 'utf8')));
    });
    copyFileSync(`${evalFolderOf(runDir)}/eval_metadata.json`, `${target}/eval_metadata.json`);
    writeFileSync(
      `${target}/run.json`,
      `${JSON.stringify({ model, checkout: cwd, site: cwd === null ? null : `${cwd}.garden` }, null, 2)}\n`,
    );
  });
  writeFileSync(`${folder}.key.json`, `${JSON.stringify(Object.fromEntries(key), null, 2)}\n`);
}

export function unblind(iterationDir: string, evalCase: string, judge: number): void {
  const folder = judgeName(iterationDir, evalCase, judge);
  const key = readJson(`${folder}.key.json`);
  const entries = isRecord(key) ? Object.entries(key) : [];
  const runs = entries.flatMap(([name, runDir]) => (typeof runDir === 'string' ? [[name, runDir] as const] : []));
  const missing = runs.filter(([name]) => !existsSync(`${folder}/${name}/llm-grades.json`));

  if (runs.length === 0 || runs.length !== entries.length) {
    throw new Error(`${folder}.key.json is not a letter-to-run key`);
  }

  if (missing.length > 0) {
    throw new Error(`no llm-grades.json for ${missing.map(([name]) => name).join(', ')} in ${folder}`);
  }

  runs.forEach(([name, runDir]) => {
    copyFileSync(`${folder}/${name}/llm-grades.json`, `${runDir}/${judgeFiles[judge - 1] ?? ''}`);
  });
}

if (isMainModule(import.meta.url)) {
  const [command, iterationDir, evalCase, judge, ...runDirs] = process.argv.slice(2);

  if (iterationDir === undefined || evalCase === undefined || judge === undefined) {
    throw new Error('usage: eval-blind.ts blind|unblind <iteration dir> <case> <judge 1|2|3> [run dir...]');
  }

  const iteration = iterationDir.replaceAll('\\', '/');

  if (command === 'blind') {
    blind(
      iteration,
      evalCase,
      Number(judge),
      runDirs.map((runDir) => runDir.replaceAll('\\', '/')),
    );
  } else if (command === 'unblind' && runDirs.length === 0) {
    unblind(iteration, evalCase, Number(judge));
  } else {
    throw new Error('usage: eval-blind.ts blind|unblind <iteration dir> <case> <judge 1|2|3> [run dir...]');
  }
}
