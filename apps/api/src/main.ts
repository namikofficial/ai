import { startWorkbenchServer } from "./server.ts";

const handle = await startWorkbenchServer();
console.log(`AI Workbench api listening at ${handle.url}`);

process.on?.("SIGINT", async () => {
  await handle.close();
  process.exit(0);
});
