import { startWorkbenchWeb } from "./server.ts";

const handle = await startWorkbenchWeb();
console.log(`AI Workbench web listening at ${handle.url}`);

process.on?.("SIGINT", async () => {
  await handle.close();
  process.exit(0);
});
