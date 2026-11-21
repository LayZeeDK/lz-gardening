// The `--out` file of the slim `claude -p` runner: `{cwd, status, ms, stdout}`, with the session's stream-json lines in
// `stdout`. Repository-only; nothing here ships with the plugin.
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

export interface SlimOutput {
  readonly cwd: string | null;
  readonly ms: number;
  // The session's last `result` line, or an empty record when the session printed none (it timed out or crashed).
  readonly result: Readonly<Record<string, unknown>>;
}

export function slimOutput(value: unknown): SlimOutput {
  const output = isRecord(value) ? value : {};
  const { cwd, ms, stdout } = output;
  const results = (typeof stdout === 'string' ? stdout : '')
    .split('\n')
    .flatMap((line): unknown[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((entry) => isRecord(entry) && entry['type'] === 'result');
  const last: unknown = results.at(-1);

  return {
    cwd: typeof cwd === 'string' ? cwd : null,
    ms: typeof ms === 'number' ? ms : 0,
    result: isRecord(last) ? last : {},
  };
}
