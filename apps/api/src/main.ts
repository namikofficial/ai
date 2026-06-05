import { startWorkbenchServer } from "./server.ts";

function readPort(argv: string[]): number | undefined {
  const flag = argv.find((arg) => arg.startsWith("--port="));
  if (flag) return Number(flag.slice("--port=".length));
  const index = argv.indexOf("--port");
  if (index >= 0 && argv[index + 1]) return Number(argv[index + 1]);
  return undefined;
}

const port = readPort(process.argv.slice(2));
const handle = await startWorkbenchServer({
  config: Number.isFinite(port) ? { apiPort: port } : undefined,
});
console.log(`AI Workbench api listening at ${handle.url}`);

process.on?.("SIGINT", async () => {
  await handle.close();
  process.exit(0);
});
