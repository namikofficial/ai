import type { ConfigSnapshot } from "../../shared/src/index.ts";

export function resolveConfig(overrides: Partial<ConfigSnapshot> = {}): ConfigSnapshot {
  const cwd = process.cwd();
  const envDatabasePath = process.env.AI_DATABASE_PATH;
  const envRuntimeDir = process.env.AI_RUNTIME_DIR;
  const envApiPort = process.env.AI_API_PORT ? Number(process.env.AI_API_PORT) : null;
  const envWebPort = process.env.AI_WEB_PORT ? Number(process.env.AI_WEB_PORT) : null;
  const envApiUrl = process.env.AI_API_URL;
  const apiPort = overrides.apiPort ?? 4242;
  return {
    databasePath: overrides.databasePath ?? envDatabasePath ?? `${cwd}/runtime/ai.db`,
    runtimeDir: overrides.runtimeDir ?? envRuntimeDir ?? `${cwd}/runtime`,
    apiUrl: overrides.apiUrl ?? envApiUrl ?? `http://127.0.0.1:${envApiPort ?? apiPort}`,
    webPort: overrides.webPort ?? envWebPort ?? 3000,
    apiPort: overrides.apiPort ?? envApiPort ?? apiPort,
  };
}
