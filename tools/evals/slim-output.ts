// The `--out` file of the slim `claude -p` runner: `{cwd, status, ms, stdout}`, with the session's stream-json lines in
// `stdout`. Repository-only; nothing here ships with the plugin.
import { isRecord } from '../../plugins/lz-gardening/skills/lz-garden/scripts/log-guard.ts';

export interface SlimOutput {
  readonly cwd: string | null;
  readonly ms: number;
  // The session's last `result` line, or an empty record when the session printed none (it timed out or crashed).
  readonly result: Readonly<Record<string, unknown>>;
  // The session id its last line carried, which a session stopped before its result line printed too.
  readonly session: string | null;
}

export function slimOutput(value: unknown): SlimOutput {
  const output = isRecord(value) ? value : {};
  const { cwd, ms, stdout } = output;
  const lines = (typeof stdout === 'string' ? stdout : '').split('\n').flatMap((line): unknown[] => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const last: unknown = lines.filter((entry) => isRecord(entry) && entry['type'] === 'result').at(-1);
  const sessions = lines.flatMap((entry) =>
    isRecord(entry) && typeof entry['session_id'] === 'string' ? [entry['session_id']] : [],
  );

  return {
    cwd: typeof cwd === 'string' ? cwd : null,
    ms: typeof ms === 'number' ? ms : 0,
    result: isRecord(last) ? last : {},
    session: sessions.at(-1) ?? null,
  };
}

// A usage limit ends the session at once with status 0 and is_error false; only its result text says so.
export function limitStopped(output: SlimOutput): boolean {
  const text = output.result['result'];

  return typeof text === 'string' && /^You've hit your .*limit/.test(text);
}
