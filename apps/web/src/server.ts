import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { startWorkbenchServer } from "../../api/src/server.ts";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import type { ConfigSnapshot } from "../../../packages/shared/src/index.ts";

export interface WebServerOptions {
  config?: Partial<ConfigSnapshot>;
}

export interface WebServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startWorkbenchWeb(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const config = resolveConfig(options.config ?? {});
  const apiHandle = await startWorkbenchServer({
    config: {
      apiUrl: config.apiUrl,
      apiPort: config.apiPort,
      webPort: config.webPort,
      databasePath: config.databasePath,
      runtimeDir: config.runtimeDir,
    },
  });

  const webRoot = new URL("..", import.meta.url).pathname;
  const vite = await createViteServer({
    root: webRoot,
    appType: "spa",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: config.webPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiHandle.url,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/events/stream": {
          target: apiHandle.url,
          changeOrigin: true,
        },
      },
    },
  });

  await vite.listen();
  const localUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${config.webPort}`;

  return {
    url: localUrl,
    close: async () => {
      await vite.close();
      await apiHandle.close();
    },
  };
}
