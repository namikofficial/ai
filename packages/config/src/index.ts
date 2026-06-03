import type { ConfigSnapshot } from "../../shared/src/index.ts";

export function resolveConfig(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  const cwd = process.cwd();
  const apiPort = overrides.apiPort ?? 4242;
  return {
    databasePath: overrides.databasePath ?? `${cwd}/runtime/ai.db`,
    runtimeDir: overrides.runtimeDir ?? `${cwd}/runtime`,
    apiUrl: overrides.apiUrl ?? `http://127.0.0.1:${apiPort}`,
    webPort: overrides.webPort ?? 3000,
    apiPort,
  };
}
