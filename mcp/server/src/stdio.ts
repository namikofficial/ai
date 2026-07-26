import { mkdir } from "node:fs/promises";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import { createStore, initializeStore } from "../../../packages/db/src/store.ts";
import { handleMcpRequest } from "./tools.ts";

type ProcessLike = {
  stdin: {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
    resume(): void;
  };
  stdout: {
    write(chunk: string): void;
  };
  stderr: {
    write(chunk: string): void;
  };
  on(event: string, listener: (...args: any[]) => void): void;
  exit(code?: number): never;
  env: Record<string, string | undefined>;
};

const proc = process as unknown as ProcessLike;

function writeMessage(message: unknown): void {
  const json = JSON.stringify(message);
  // MCP stdio is newline-delimited JSON-RPC. Do not write logs to stdout.
  proc.stdout.write(`${json}\n`);
}

function parseMessages(buffer: string): { messages: unknown[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return {
    messages: lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line)),
    rest,
  };
}

export async function startMcpServer(): Promise<void> {
  const config = resolveConfig({
    databasePath: proc.env.AI_DATABASE_PATH,
    runtimeDir: proc.env.AI_RUNTIME_DIR,
    apiUrl: proc.env.AI_API_URL,
    webPort: proc.env.AI_WEB_PORT ? Number(proc.env.AI_WEB_PORT) : undefined,
    apiPort: proc.env.AI_API_PORT ? Number(proc.env.AI_API_PORT) : undefined,
  });
  await mkdir(config.runtimeDir, { recursive: true });
  const store = createStore(initializeStore(config.databasePath));
  await store.ensureRuntimeDirs(config.runtimeDir);

  proc.stdin.setEncoding("utf8");
  proc.stdin.resume();

  let buffer = "";
  let pending = Promise.resolve();
  proc.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    pending = pending.then(async () => {
      try {
        const parsed = parseMessages(buffer);
        buffer = parsed.rest;
        for (const message of parsed.messages) {
          const request = message as {
            jsonrpc?: string;
            id?: string | number | null;
            method?: string;
            params?: Record<string, unknown>;
          };
          if (request.jsonrpc !== "2.0" || typeof request.method !== "string") continue;
          const response = await handleMcpRequest(store, config, {
            jsonrpc: "2.0",
            id: request.id ?? null,
            method: request.method,
            params: request.params,
          });
          if (response) writeMessage(response);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        proc.stderr.write(`${message}\n`);
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message } });
      }
    });
  });

  proc.on("SIGINT", () => proc.exit(0));
  proc.on("SIGTERM", () => proc.exit(0));

  await new Promise<void>((resolve) => {
    proc.stdin.on("end", resolve);
    proc.on("SIGINT", resolve);
    proc.on("SIGTERM", resolve);
  });
}
