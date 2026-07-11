import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";

function loadEnvFile(path) {
  try {
    const contents = readFileSync(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const index = trimmed.indexOf("=");
      if (index === -1) {
        continue;
      }
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Optional file. The repo ships with one, but local overrides are not required.
  }
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function probePort(port) {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      const resolved = address && typeof address === "object" ? address.port : port;
      server.close(() => resolvePort(resolved));
    });
  });
}

async function pickFreePort(preferred) {
  if (preferred === 0) {
    return probePort(0);
  }
  try {
    return await probePort(preferred);
  } catch {
    return probePort(0);
  }
}

async function main() {
  loadEnvFile(resolve(process.cwd(), ".env"));

  const apiPort = await pickFreePort(parsePort(process.env.AI_API_PORT, 4242));
  const webPort = await pickFreePort(
    parsePort(process.env.AI_WEB_PORT, 3000) === apiPort ? 0 : parsePort(process.env.AI_WEB_PORT, 3000)
  );

  process.env.AI_API_PORT = String(apiPort);
  process.env.AI_WEB_PORT = String(webPort);
  process.env.AI_API_URL = `http://127.0.0.1:${apiPort}`;

  const commands = [
    [process.execPath, ["--experimental-strip-types", "apps/web/src/main.ts"]],
    [process.execPath, ["--experimental-strip-types", "apps/worker/src/main.ts"]],
  ];

  let shuttingDown = false;
  let exitedChildren = 0;
  let exitCode = 0;

  const children = commands.map(([command, args]) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      shell: false,
    });
    child.on("exit", (code, signal) => {
      exitedChildren += 1;
      if (!shuttingDown) {
        shuttingDown = true;
        exitCode = code ?? (signal ? 1 : 0);
        for (const other of children) {
          if (other !== child && !other.killed) {
            other.kill(signal ?? "SIGTERM");
          }
        }
      }
      if (shuttingDown && exitedChildren >= children.length) {
        process.exit(exitCode);
      }
    });
    return child;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      shuttingDown = true;
      exitCode = 0;
      for (const child of children) {
        if (!child.killed) {
          child.kill(signal);
        }
      }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
