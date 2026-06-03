import { createApiClient } from "../../../packages/api-client/src/index.ts";
import { resolveConfig } from "../../../packages/config/src/index.ts";
import { startWorkbenchServer } from "../../../apps/api/src/server.ts";
import { startWorkbenchWeb } from "../../../apps/web/src/server.ts";
import { startWorkbenchWorker } from "../../../apps/worker/src/worker.ts";
import { startMcpServer } from "../../../mcp/server/src/stdio.ts";
import { initializeStore, createStore } from "../../../packages/db/src/store.ts";

function printUsage(): void {
  console.log(`ai commands:
  ai web
  ai web --port <web-port> [--api-port <api-port>]
  ai api
  ai api --port <api-port>
  ai worker
  ai project add <path> [--name <name>]
  ai project index <project>
  ai ask "<question>" --project <project>
  ai plan "<goal>" --project <project>
  ai research "<topic>" --project <project>
  ai handoff --session <session-id> --project <project> --target <target> --subtask "<text>"
  ai sessions
  ai trace <session-id>
  ai checks list
  ai checks run <name> --project <project>
  ai mcp
  ai mcp calls
  ai reviews list
  ai reviews create --project <project> [--session <session-id>] [--title <title>] [--planned <files>] [--edited <files>] [--checks <checks>] [--notes <notes>]
  ai memory candidates [--status <pending|accepted|rejected>]
  ai memory accept <candidate-id>
  ai memory reject <candidate-id> [--reason <text>]
  ai memory list [--scope <scope>]
  ai models list
  ai models health
  ai trace conversation <session-id>
  ai skills candidates [--status <status>]
  ai skills accept <candidate-id>
  ai skills reject <candidate-id> [--reason <text>]
  ai eval add --project <project> --query "<q>" --expected "<e>" [--kind <retrieval|answer>]
  ai eval run --project <project> [--limit <n>]
  ai status`);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: Record<string, string> = {};
  const positionals: string[] = [];

  while (args.length > 0) {
    const value = args.shift()!;
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = args[0];
      if (next && !next.startsWith("--")) {
        options[key] = args.shift()!;
      } else {
        options[key] = "true";
      }
      continue;
    }
    positionals.push(value);
  }

  return { command, options, positionals };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function ensureServer(baseUrl?: string) {
  const config = resolveConfig(baseUrl ? { apiUrl: baseUrl } : {});
  return createApiClient({ baseUrl: config.apiUrl });
}

async function run(): Promise<void> {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));
  const apiPort = Number(options["api-port"] ?? 4242);
  const apiUrl = options["api-url"] ?? process.env.AI_API_URL ?? `http://127.0.0.1:${apiPort}`;
  const client = await ensureServer(apiUrl);

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "api") {
    const apiOnlyPort = Number(options.port ?? options["api-port"] ?? apiPort);
    const apiOnlyUrl = options["api-url"] ?? process.env.AI_API_URL ?? `http://127.0.0.1:${apiOnlyPort}`;
    const handle = await startWorkbenchServer({
      config: { apiUrl: apiOnlyUrl, webPort: apiOnlyPort, apiPort: apiOnlyPort },
    });
    console.log(`AI Workbench api listening at ${handle.url}`);
    process.on?.("SIGINT", async () => {
      await handle.close();
      process.exit(0);
    });
    return;
  }

  if (command === "web") {
    const webPort = Number(options.port ?? 3000);
    const apiOnlyPort = Number(options["api-port"] ?? 4242);
    const apiOnlyUrl = options["api-url"] ?? process.env.AI_API_URL ?? `http://127.0.0.1:${apiOnlyPort}`;
    const apiHandle = await startWorkbenchServer({
      config: { apiUrl: apiOnlyUrl, webPort: apiOnlyPort, apiPort: apiOnlyPort },
    });
    const webHandle = await startWorkbenchWeb({
      config: { apiUrl: apiOnlyUrl, webPort, apiPort: apiOnlyPort },
    });
    console.log(`AI Workbench api listening at ${apiHandle.url}`);
    console.log(`AI Workbench web listening at ${webHandle.url}`);
    process.on?.("SIGINT", async () => {
      await webHandle.close();
      await apiHandle.close();
      process.exit(0);
    });
    return;
  }

  if (command === "worker") {
    await startWorkbenchWorker({
      config: {
        apiUrl,
      },
    });
    return;
  }

  if (command === "project") {
    const subcommand = positionals.shift();
    if (subcommand === "add") {
      const path = positionals.shift();
      if (!path) {
        throw new Error("project add requires a path");
      }
      const result = await client.createProject({
        path,
        name: options.name,
        repoUrl: options["repo-url"] ?? null,
        branch: options.branch ?? null,
      });
      printJson(result);
      return;
    }
    if (subcommand === "index") {
      const project = positionals.shift();
      if (!project) {
        throw new Error("project index requires a project identifier");
      }
      const result = await client.indexProject(project);
      printJson(result);
      return;
    }
  }

  if (command === "ask") {
    const question = positionals.join(" ");
    const project = options.project;
    if (!project) {
      throw new Error("ask requires --project <name>");
    }
    const result = await client.ask({
      question,
      project,
      mode: options.mode === "cloud" || options.mode === "hybrid" ? options.mode : "local",
      depth: options.depth === "shallow" || options.depth === "deep" ? options.depth : "standard",
    });
    printJson(result);
    return;
  }

  if (command === "plan") {
    const goal = positionals.join(" ");
    const project = options.project;
    if (!project) {
      throw new Error("plan requires --project <name>");
    }
    const result = await client.plan({
      project,
      goal,
      risk: options.risk === "low" || options.risk === "high" ? options.risk : "medium",
    });
    printJson(result);
    return;
  }

  if (command === "research") {
    const topic = positionals.join(" ");
    const project = options.project;
    if (!project) {
      throw new Error("research requires --project <name>");
    }
    const result = await client.research({
      project,
      topic,
      mode: options.mode === "web" || options.mode === "hybrid" ? options.mode : "local",
    });
    printJson(result);
    return;
  }

  if (command === "handoff") {
    const sessionId = options.session;
    const project = options.project;
    const target = options.target === "opencode" || options.target === "codex" || options.target === "clipboard" || options.target === "file" ? options.target : "manual";
    const subtask = positionals.join(" ");
    if (!sessionId || !project) {
      throw new Error("handoff requires --session <id> and --project <name>");
    }
    const result = await client.handoff({
      sessionId,
      project,
      target,
      subtask,
    });
    printJson(result);
    return;
  }

  if (command === "sessions") {
    const result = await client.listSessions();
    printJson(result);
    return;
  }

  if (command === "trace") {
    const sessionId = positionals[0];
    if (!sessionId) {
      throw new Error("trace requires a session id");
    }
    const result = await client.getSessionEvents(sessionId);
    printJson(result);
    return;
  }

  if (command === "status") {
    const settings = await client.getSettings();
    const projects = await client.listProjects();
    const sessions = await client.listSessions();
    const checks = await client.listChecks();
    printJson({ settings, projects, sessions, checks });
    return;
  }

  if (command === "checks") {
    const subcommand = positionals.shift();
    if (subcommand === "list") {
      printJson(await client.listChecks());
      return;
    }
    if (subcommand === "run") {
      const name = positionals.shift();
      if (!name) {
        throw new Error("checks run requires a check name");
      }
      printJson(await client.runCheck({ name, projectId: options.project ?? null }));
      return;
    }
  }

  if (command === "settings") {
    printJson(await client.getSettings());
    return;
  }

  if (command === "reviews") {
    const subcommand = positionals.shift();
    if (subcommand === "list") {
      printJson(await client.listReviews());
      return;
    }
    if (subcommand === "create") {
      const project = options.project;
      if (!project) {
        throw new Error("reviews create requires --project <project>");
      }
      const result = await client.createReview({
        project,
        sessionId: options.session ?? null,
        title: options.title,
        plannedFiles: (options.planned ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        editedFiles: (options.edited ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        checks: (options.checks ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        notes: options.notes,
      });
      printJson(result);
      return;
    }
  }

  if (command === "retrieval") {
    const project = options.project;
    const query = positionals.join(" ");
    if (!project) {
      throw new Error("retrieval requires --project <name>");
    }
    printJson(await client.searchRetrieval({ project, query, limit: Number(options.limit ?? 8) || 8 }));
    return;
  }

  if (command === "models") {
    printJson(await client.getModels());
    return;
  }

  if (command === "mcp") {
    if (positionals[0] === "calls") {
      printJson(await client.getMcpCalls());
      return;
    }
    await startMcpServer();
    return;
  }

  printUsage();
}

type DirectStore = ReturnType<typeof createStore>;

function openDirectStore(): DirectStore {
  const config = resolveConfig({});
  const db = initializeStore(config.databasePath);
  return createStore(db);
}

function withDirectStore<T>(fn: (store: DirectStore) => T | Promise<T>): Promise<T> {
  const store = openDirectStore();
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      try {
        store.db.close();
      } catch {
        // ignore close errors
      }
    });
}

if (process.argv[2] === "memory") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "candidates";
    if (sub === "candidates") {
      const status = process.argv.find((arg) => arg.startsWith("--status="))?.split("=")[1];
      const candidates = status
        ? store.memory.listCandidates(status as "pending" | "accepted" | "rejected")
        : store.memory.listCandidates("pending");
      printJson(candidates);
      return;
    }
    if (sub === "accept" || sub === "reject") {
      const id = process.argv[4];
      if (!id) {
        throw new Error(`memory ${sub} requires a candidate id`);
      }
      if (sub === "accept") {
        const entry = store.memory.acceptCandidate(id);
        printJson(entry);
        return;
      }
      const reasonArg = process.argv.find((arg) => arg.startsWith("--reason="))?.split("=")[1] ?? "";
      store.memory.reviewCandidate(id, "rejected", reasonArg);
      printJson({ id, status: "rejected" });
      return;
    }
    if (sub === "list") {
      const scopeArg = process.argv.find((arg) => arg.startsWith("--scope="))?.split("=")[1] as
        | "global" | "project" | "repo" | "path" | undefined;
      printJson(store.memory.listEntries(undefined, scopeArg));
      return;
    }
    throw new Error(`unknown memory subcommand: ${sub}`);
  })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else if (process.argv[2] === "models") {
  withDirectStore((store) => {
    const sub = process.argv[3] ?? "list";
    if (sub === "list") {
      printJson({ providers: store.models.listProviders(), profiles: store.models.listProfiles() });
      return;
    }
    if (sub === "health") {
      const providers = store.models.listProviders();
      const calls = store.models.listAllCalls(50);
      printJson({ providers, recentCalls: calls });
      return;
    }
    throw new Error(`unknown models subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "trace" && process.argv[3] === "conversation") {
  const sessionId = process.argv[4];
  if (!sessionId) {
    console.error("trace conversation requires a session id");
    process.exit(1);
  }
  withDirectStore((store) => {
    const messages = store.conversation.listMessages(sessionId);
    const runs = store.agents.listRuns(sessionId);
    const handoffs = store.agents.listHandoffs(sessionId);
    const queries = store.retrieval.listQueriesForSession(sessionId);
    const packs = store.context.listPacksForSession(sessionId);
    printJson({ messages, runs, handoffs, retrievalQueries: queries, contextPacks: packs });
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "skills") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "candidates";
    if (sub === "candidates") {
      const status = process.argv.find((arg) => arg.startsWith("--status="))?.split("=")[1];
      printJson(
        status
          ? store.skills.listCandidates(status as "pending" | "active" | "deprecated" | "rejected")
          : store.skills.listCandidates(),
      );
      return;
    }
    if (sub === "accept" || sub === "reject") {
      const id = process.argv[4];
      if (!id) {
        throw new Error(`skills ${sub} requires a candidate id`);
      }
      if (sub === "accept") {
        const skill = store.skills.acceptCandidate(id);
        printJson(skill);
        return;
      }
      const reasonArg = process.argv.find((arg) => arg.startsWith("--reason="))?.split("=")[1] ?? "";
      store.skills.reviewCandidate(id, "rejected");
      printJson({ id, status: "rejected", reason: reasonArg });
      return;
    }
    throw new Error(`unknown skills subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "eval") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "list";
    if (sub === "add") {
      const project = process.argv.find((arg) => arg.startsWith("--project="))?.split("=")[1];
      const query = process.argv.find((arg) => arg.startsWith("--query="))?.split("=").slice(1).join("=");
      const expected = process.argv.find((arg) => arg.startsWith("--expected="))?.split("=").slice(1).join("=");
      if (!project || !query || !expected) {
        throw new Error("eval add requires --project, --query, --expected");
      }
      const evalCase = store.evals.addCase({
        projectId: project,
        question: query,
        expectedAnswerContains: expected,
      });
      printJson(evalCase);
      return;
    }
    if (sub === "list") {
      printJson(store.evals.listCases());
      return;
    }
    if (sub === "run") {
      const project = process.argv.find((arg) => arg.startsWith("--project="))?.split("=")[1];
      if (!project) {
        throw new Error("eval run requires --project");
      }
      const cases = store.evals.listCases().filter((c) => c.projectId === project);
      const evaluations: Array<Record<string, unknown>> = [];
      for (const c of cases) {
        const answer = await store.ask({ project, question: c.question, mode: "local", depth: "standard" });
        const groundedness = answer.confidence;
        const citationCoverage = answer.citations.length > 0 ? 1 : 0;
        const evalRecord = store.evals.recordAnswerEvaluation({
          sessionId: answer.sessionId,
          retrievalQueryId: null,
          groundedness,
          citationCoverage,
          contradiction: 0,
          notes: `auto-graded on case ${c.id}`,
        });
        evaluations.push({ caseId: c.id, evalRecord, confidence: groundedness });
      }
      printJson({ evaluations });
      return;
    }
    throw new Error(`unknown eval subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
