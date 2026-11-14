// No imports: the workspace's Nx plugin loads this file on every nx command, without the plugin's packages.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
