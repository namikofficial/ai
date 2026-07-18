import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startWorkbenchServer } from "../../../apps/api/src/server.ts";
import { startWorkbenchWeb } from "../../../apps/web/src/server.ts";
import { startWorkbenchWorker } from "../../../apps/worker/src/worker.ts";
import { startMcpServer } from "../../../mcp/server/src/stdio.ts";
import { readActiveContextCache } from "../../../packages/active-context/src/index.ts";
import { createApiClient } from "../../../packages/api-client/src/index.ts";
import { resolveConfig, resolveProjectConfig } from "../../../packages/config/src/index.ts";
import { projectManifestSchema } from "../../../packages/contracts/src/index.ts";
import { runRetrievalExplain } from "../../../packages/db/src/retrieval-explain.ts";
import { createStore, initializeStore } from "../../../packages/db/src/store.ts";
import { createModelRuntime } from "../../../packages/model-runtime/src/index.ts";
import {
  atomicWriteJson,
  createWorkbenchBackup,
  defaultRegistryCachePath,
  diffProjectManifests,
  importLegacyProjectProfiles,
  readProjectLocalManifest,
  refreshRegistryCache,
} from "../../../packages/project-registry/src/index.ts";
import { readProjectStatusCache } from "../../../packages/project-status/src/index.ts";
import type { RetrievalDepth, RetrievalMode } from "../../../packages/shared/src/index.ts";
import { buildSessionTimeline } from "../../../packages/timeline/src/index.ts";

function printUsage(): void {
  console.log(`ai commands:
  ai web
  ai web --port <web-port> [--api-port <api-port>]
  ai api
  ai api --port <api-port>
  ai worker
  ai project add <path> [--name <name>]
  ai project list
  ai project status [project] [--compact]
  ai project pin <project> [--scope workspace|session|persistent]
  ai project unpin
  ai project import-legacy <project-profile.sh> [--apply]
  ai project import <manifest.json> --project <project-id> [--apply]
  ai project proposal <approve|reject> <proposal-id>
  ai project scan [project-id] [--apply]
  ai project export <project> [--output <path>]
  ai project backup <sqlite-output-path>
  ai project index <project>
  ai project graph <project>
  ai project symbols <project> [--query <text>] [--limit <n>]
  ai project symbol <symbol-id>
  ai ask "<question>" --project <project> [--session <session-id>]
  ai context explain "<question>" --project <project>
  ai context status [--json] [--compact]
  ai context explain
  ai config show --project <project>
  ai config init --project <project>
  ai config validate --project <project>
  ai plan "<goal>" --project <project> [--session <session-id>]
  ai research "<topic>" --project <project>
  ai handoff --session <session-id> --project <project> --target <target> --subtask "<text>"
  ai sessions [list]
  ai sessions create "<goal>" --project <project> [--title <title>]
  ai sessions show <session-id>
  ai sessions append <session-id> "<message>" [--role user|assistant|agent]
  ai sessions context <session-id> [--query <query>] [--token-budget <tokens>]
  ai sessions resume <session-id>
  ai sessions close <session-id> [--cancelled] [--summary <summary>]
  ai sessions memory <session-id> "<outcome>" [--title <title>] [--tags <comma-list>]
  ai trace <session-id>
  ai trace timeline <session-id>
  ai checks list
  ai checks run <name> --project <project>
  ai mcp
  ai mcp calls
  ai reviews list
  ai reviews create --project <project> [--session <session-id>] [--title <title>] [--planned <files>] [--edited <files>] [--checks <checks>] [--notes <notes>]
  ai prompts list [--session <session-id>] [--limit <n>]
  ai prompts show <prompt-id>
  ai replay <session-id> --prompt <compiled-prompt-id> --model <profile-id>
  ai memory candidates [--status <pending|accepted|rejected>]
  ai memory accept <candidate-id>
  ai memory reject <candidate-id> [--reason <text>]
  ai memory list [--scope <scope>]
  ai models list
  ai models health
  ai models probe [--profile <profile-id>] [--prompt <text>]
  ai models route "<task>" [--mode <local|cloud|hybrid|any>] [--risk <low|medium|high>] [--depth <shallow|standard|deep>] [--question <text>] [--goal <text>]
  ai models call --role <role> --prompt "<text>" [--profile-id <id>]
  ai trace conversation <session-id>
  ai skills candidates [--status <status>]
  ai skills accept <candidate-id>
  ai skills reject <candidate-id> [--reason <text>]
  ai eval add --project <project> --query "<q>" --expected "<e>" [--kind <retrieval|answer>]
  ai eval run --project <project> [--limit <n>]
  ai embeddings stats
  ai embeddings purge [--older-than <days>] [--provider <id>] [--model <name>]
  ai dev "<goal>" --project <project> [--session <session-id>] [--mode local|hybrid|cloud] [--approve-edits] [--checks <checks>] [--max-repairs <n>]
  ai dev runs
  ai dev show <run-id>
  ai dev diff <run-id>
  ai dev approve <run-id>
  ai dev cancel <run-id>
  ai tools list
  ai tools call <name> --project <project> [--args <json>] [--allow-high-risk]
  ai status
  ai runtime status
  ai health [--deep]
  ai health --deep --json`);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options: Record<string, string> = {};
  const positionals: string[] = [];

  while (args.length > 0) {
    const value = args.shift();
    if (value === undefined) break;
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = args[0];
      if (next && !next.startsWith("--")) {
        const optionValue = args.shift();
        if (optionValue !== undefined) options[key] = optionValue;
      } else {
        options[key] = "true";
      }
      continue;
    }
    positionals.push(value);
  }

  return { command, options, positionals };
}

function readCliArg(argv: string[], name: string): string | undefined {
  const valueArg = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (valueArg) {
    return valueArg.slice(name.length + 3);
  }
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      return next;
    }
  }
  return undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function openLocalStore() {
  const config = resolveConfig();
  return createStore(initializeStore(config.databasePath));
}

function parseJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function projectConfigCandidates(projectPath: string): string[] {
  return [".ai-workbench.json", ".ai-workbench", ".aiconfig"].map((name) => join(projectPath, name));
}

function validateProjectConfigFile(projectPath: string): {
  path: string | null;
  valid: boolean;
  error: string | null;
  value: Record<string, unknown> | null;
} {
  for (const candidate of projectConfigCandidates(projectPath)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, { encoding: "utf8" }));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          path: candidate,
          valid: false,
          error: "project config must be a JSON object",
          value: null,
        };
      }
      return {
        path: candidate,
        valid: true,
        error: null,
        value: parsed as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        continue;
      }
      return {
        path: candidate,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
        value: null,
      };
    }
  }
  return { path: null, valid: true, error: null, value: null };
}

async function getProjectRecord(client: ReturnType<typeof createApiClient>, projectId: string) {
  const response = await client.getProject(projectId);
  if (!response.data) {
    throw new Error(`Unknown project: ${projectId}`);
  }
  return response.data;
}

function formatPromptSummary(prompt: {
  id: string;
  sessionId: string | null;
  mode: string;
  role: string;
  estimatedTokens: number;
  createdAt: string;
}): string {
  return [
    `${prompt.id}`,
    `mode=${prompt.mode}`,
    `role=${prompt.role}`,
    `session=${prompt.sessionId ?? "none"}`,
    `tokens=${prompt.estimatedTokens}`,
    `created=${prompt.createdAt}`,
  ].join(" | ");
}

function formatPromptDetail(prompt: {
  id: string;
  sessionId: string | null;
  taskId: string | null;
  retrievalQueryId: string | null;
  contextPackId: string | null;
  mode: string;
  role: string;
  messagesJson: string;
  estimatedTokens: number;
  includedContextJson: string;
  omittedContextJson: string;
  safetyNotesJson: string;
  outputSchemaJson: string | null;
  createdAt: string;
}): string {
  const lines = [
    `Prompt ${prompt.id}`,
    `Mode: ${prompt.mode}`,
    `Role: ${prompt.role}`,
    `Session: ${prompt.sessionId ?? "none"}`,
    `Task: ${prompt.taskId ?? "none"}`,
    `Retrieval Query: ${prompt.retrievalQueryId ?? "none"}`,
    `Context Pack: ${prompt.contextPackId ?? "none"}`,
    `Estimated Tokens: ${prompt.estimatedTokens}`,
    `Created At: ${prompt.createdAt}`,
    "",
    "Messages:",
    JSON.stringify(parseJson(prompt.messagesJson), null, 2) ?? prompt.messagesJson,
    "",
    "Included Context:",
    JSON.stringify(parseJson(prompt.includedContextJson), null, 2) ?? prompt.includedContextJson,
    "",
    "Omitted Context:",
    JSON.stringify(parseJson(prompt.omittedContextJson), null, 2) ?? prompt.omittedContextJson,
    "",
    "Safety Notes:",
    JSON.stringify(parseJson(prompt.safetyNotesJson), null, 2) ?? prompt.safetyNotesJson,
    "",
    "Output Schema:",
    JSON.stringify(parseJson(prompt.outputSchemaJson), null, 2) ?? "null",
  ];
  return lines.join("\n");
}

async function ensureServer(baseUrl?: string) {
  const config = resolveConfig(baseUrl ? { apiUrl: baseUrl } : {});
  return createApiClient({ baseUrl: config.apiUrl });
}

async function buildTimelineFromStore(store: ReturnType<typeof createStore>, sessionId: string) {
  const session = store.getSession(sessionId);
  if (!session) {
    return null;
  }
  return buildSessionTimeline({
    session,
    messages: store.conversation.listMessages(sessionId, 500),
    events: store.listEvents(sessionId, 500),
    agentRuns: store.agents.listRuns(sessionId, 200),
    modelCalls: store.models.listCalls(sessionId, 200),
    compiledPrompts: store.listCompiledPrompts(sessionId, 100),
    retrievalQueries: store.retrieval.listQueriesForSession(sessionId, 100),
    contextPacks: store.context.listPacksForSession(sessionId, 100),
    outcomes: store.evals.listOutcomes(sessionId, 100),
  });
}

async function run(): Promise<void> {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));
  const apiPort = Number(options["api-port"] ?? 4417);
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
    const webPort = Number(options.port ?? 4317);
    const apiOnlyPort = Number(options["api-port"] ?? 4417);
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
    if (subcommand === "list") {
      printJson(await client.getRegistry());
      return;
    }
    if (subcommand === "status") {
      const projectId = positionals.shift();
      printJson(
        options.compact === "true"
          ? await client.getCompactProjectStatus(projectId)
          : await client.getProjectStatus(projectId)
      );
      return;
    }
    if (subcommand === "pin") {
      const projectId = positionals.shift();
      if (!projectId) throw new Error("project pin requires a project id");
      const scope = options.scope ?? "persistent";
      if (scope !== "workspace" && scope !== "session" && scope !== "persistent") {
        throw new Error("project pin --scope must be workspace, session, or persistent");
      }
      printJson(await client.selectProject(projectId, scope));
      return;
    }
    if (subcommand === "unpin") {
      printJson(await client.clearProjectSelection());
      return;
    }
    if (subcommand === "import-legacy") {
      const sourcePath = positionals.shift();
      if (!sourcePath) throw new Error("project import-legacy requires a project-profile.sh path");
      const manifests = importLegacyProjectProfiles(readFileSync(sourcePath, "utf8"), {
        home: process.env.HOME ?? "",
        sourceRef: sourcePath,
      });
      if (options.apply !== "true") {
        printJson({ dryRun: true, manifests, mutations: [] });
        return;
      }
      const store = openLocalStore();
      try {
        const proposals = manifests.map((manifest) => {
          const existing = store.getProjectByPath(manifest.path);
          const project = existing ?? store.createProject({ path: manifest.path, name: manifest.name });
          const canonical = { ...manifest, id: project.id, name: project.name };
          return store.projectRegistry.proposeManifest(project.id, canonical, sourcePath);
        });
        await refreshRegistryCache(store.projectRegistry, defaultRegistryCachePath());
        printJson({ dryRun: false, proposals });
      } finally {
        store.db.close();
      }
      return;
    }
    if (subcommand === "import") {
      const sourcePath = positionals.shift();
      const projectId = options.project;
      if (!sourcePath || !projectId) throw new Error("project import requires a manifest path and --project");
      const manifest = projectManifestSchema.parse(JSON.parse(readFileSync(sourcePath, "utf8")));
      const store = openLocalStore();
      try {
        const diff = diffProjectManifests(store.projectRegistry.getManifest(projectId), manifest);
        if (options.apply !== "true") {
          printJson({ dryRun: true, projectId, manifest, diff, mutations: [] });
        } else {
          const proposal = store.projectRegistry.proposeManifest(projectId, manifest, sourcePath);
          printJson({ dryRun: false, proposal, diff });
        }
      } finally {
        store.db.close();
      }
      return;
    }
    if (subcommand === "proposal") {
      const resolution = positionals.shift();
      const proposalId = positionals.shift();
      if ((resolution !== "approve" && resolution !== "reject") || !proposalId) {
        throw new Error("project proposal requires approve|reject and a proposal id");
      }
      printJson(await client.resolveManifestProposal(proposalId, resolution));
      return;
    }
    if (subcommand === "scan") {
      const requestedProjectId = positionals.shift();
      const store = openLocalStore();
      try {
        const projects = requestedProjectId
          ? store.listProjects().filter((project) => project.id === requestedProjectId)
          : store.listProjects();
        if (requestedProjectId && projects.length === 0) throw new Error(`Unknown project: ${requestedProjectId}`);
        const results = [];
        for (const project of projects) {
          const local = await readProjectLocalManifest(project.path);
          if (!local.manifest) {
            results.push({
              projectId: project.id,
              path: local.path,
              status: local.error ? "invalid" : "absent",
              error: local.error,
            });
            continue;
          }
          if (local.manifest.id !== project.id) {
            results.push({
              projectId: project.id,
              path: local.path,
              status: "conflict",
              error: `manifest id ${local.manifest.id} does not match ${project.id}`,
            });
            continue;
          }
          const diff = diffProjectManifests(store.projectRegistry.getManifest(project.id), local.manifest);
          const proposal =
            options.apply === "true" && diff.length > 0
              ? store.projectRegistry.proposeManifest(project.id, local.manifest, local.path)
              : null;
          results.push({
            projectId: project.id,
            path: local.path,
            status: diff.length === 0 ? "unchanged" : "proposed",
            dryRun: options.apply !== "true",
            diff,
            proposal,
          });
        }
        printJson({ results });
      } finally {
        store.db.close();
      }
      return;
    }
    if (subcommand === "export") {
      const projectId = positionals.shift();
      if (!projectId) throw new Error("project export requires a project id");
      const store = openLocalStore();
      try {
        const manifest = store.projectRegistry.getManifest(projectId);
        if (!manifest) throw new Error(`No approved manifest for project: ${projectId}`);
        if (options.output) {
          await atomicWriteJson(options.output, manifest);
          printJson({ projectId, output: options.output });
        } else {
          printJson(manifest);
        }
      } finally {
        store.db.close();
      }
      return;
    }
    if (subcommand === "backup") {
      const output = positionals.shift();
      if (!output) throw new Error("project backup requires an output path");
      const store = openLocalStore();
      try {
        printJson(await createWorkbenchBackup(store.db, output));
      } finally {
        store.db.close();
      }
      return;
    }
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
    if (subcommand === "graph") {
      const project = positionals.shift();
      if (!project) {
        throw new Error("project graph requires a project identifier");
      }
      const result = await client.getProjectGraph(project);
      printJson(result);
      return;
    }
    if (subcommand === "symbols") {
      const projectIdentifier = positionals.shift();
      if (!projectIdentifier) {
        throw new Error("project symbols requires a project identifier");
      }
      const store = openLocalStore();
      try {
        const project = store.getProject(projectIdentifier);
        if (!project) {
          throw new Error(`Unknown project: ${projectIdentifier}`);
        }
        const symbols = store.codeIntelligence.listSymbols(
          project.id,
          options.query ?? null,
          Number(options.limit ?? 50) || 50
        );
        printJson({
          project,
          query: options.query ?? null,
          limit: Number(options.limit ?? 50) || 50,
          symbols,
        });
      } finally {
        store.db.close();
      }
      return;
    }
    if (subcommand === "symbol") {
      const symbolId = positionals.shift();
      if (!symbolId) {
        throw new Error("project symbol requires a symbol id");
      }
      const store = openLocalStore();
      try {
        const symbol = store.codeIntelligence.getSymbol(symbolId);
        if (!symbol) {
          throw new Error(`Unknown symbol: ${symbolId}`);
        }
        printJson({
          symbol,
          chunks: store.codeIntelligence.listSymbolChunks(symbolId),
          edges: store.codeIntelligence.listEdgesForSymbol(symbolId),
        });
      } finally {
        store.db.close();
      }
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
      sessionId: options.session ?? null,
      mode: options.mode === "cloud" || options.mode === "hybrid" ? options.mode : "local",
      depth: options.depth === "shallow" || options.depth === "deep" ? options.depth : "standard",
    });
    printJson(result);
    return;
  }

  if (command === "context") {
    const subcommand = positionals.shift();
    if (subcommand === "status") {
      try {
        printJson(
          options.compact === "true" ? await client.getCompactProjectStatus() : await client.getProjectStatus()
        );
      } catch (error) {
        const statusCache = await readProjectStatusCache();
        if (statusCache) {
          printJson({
            status: "offline",
            stale: true,
            data: options.compact === "true" ? statusCache.compact : statusCache.status,
            generatedAt: statusCache.generatedAt,
          });
          return;
        }
        const contextCache = await readActiveContextCache();
        if (!contextCache) throw error;
        printJson({
          status: "offline",
          stale: true,
          data: contextCache.context,
          generatedAt: contextCache.generatedAt,
        });
      }
      return;
    }
    if (subcommand === "explain") {
      const question = positionals.join(" ");
      const project = options.project;
      if (!question && !project) {
        printJson(await client.explainActiveContext());
        return;
      }
      if (!project) {
        throw new Error("context explain requires --project <project>");
      }
      if (!question) {
        throw new Error("context explain requires a query string");
      }
      const result = await client.explainContext({
        project,
        query: question,
        mode: options.mode === "cloud" || options.mode === "hybrid" ? options.mode : "local",
        depth: options.depth === "shallow" || options.depth === "deep" ? options.depth : "standard",
        limit: Number(options.limit ?? 8) || 8,
      });
      printJson(result);
      return;
    }
  }

  if (command === "config") {
    const subcommand = positionals.shift();
    if (subcommand === "show" || subcommand === "validate") {
      const projectId = options.project;
      if (!projectId) {
        throw new Error(`config ${subcommand} requires --project <project>`);
      }
      const project = await getProjectRecord(client, projectId);
      const resolved = resolveProjectConfig(project.path);
      const inspection = validateProjectConfigFile(project.path);
      if (subcommand === "show") {
        printJson({
          project,
          config: resolved,
          inspection,
        });
        return;
      }
      printJson({
        project,
        valid: inspection.valid,
        filePath: inspection.path,
        error: inspection.error,
        config: resolved,
      });
      return;
    }
    if (subcommand === "init") {
      const projectId = options.project;
      if (!projectId) {
        throw new Error("config init requires --project <project>");
      }
      const project = await getProjectRecord(client, projectId);
      const target = join(project.path, ".ai-workbench.json");
      const template = {
        ignore: ["dist/**", "coverage/**"],
        include: ["apps/**", "packages/**"],
        chunking: {
          preferTreeSitter: true,
          maxChunkTokens: 900,
        },
        retrieval: {
          boostPaths: ["apps/api/**", "packages/**"],
          authHints: ["auth", "session", "jwt", "tenant"],
        },
        models: {
          answer: "ask-deep-local",
          embedding: "embedding-local",
        },
      };
      let existed = true;
      try {
        readFileSync(target, { encoding: "utf8" });
      } catch {
        existed = false;
      }
      if (!existed) {
        await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8" });
      }
      printJson({
        project,
        path: target,
        existed,
        config: validateProjectConfigFile(project.path),
      });
      return;
    }
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
      sessionId: options.session ?? null,
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
    const target =
      options.target === "opencode" ||
      options.target === "codex" ||
      options.target === "clipboard" ||
      options.target === "file"
        ? options.target
        : "manual";
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
    const subcommand = positionals.shift() ?? "list";
    if (subcommand === "list") {
      printJson(await client.listSessions());
      return;
    }
    if (subcommand === "create") {
      const projectId = options.project;
      const goal = positionals.join(" ").trim();
      if (!projectId || !goal) throw new Error('sessions create requires "<goal>" --project <project>');
      printJson(
        await client.createSession({
          projectId,
          title: options.title?.trim() || `Session: ${goal.slice(0, 80)}`,
          userGoal: goal,
          mode: "local",
          source: "cli",
        })
      );
      return;
    }
    const sessionId = positionals.shift();
    if (!sessionId) throw new Error(`sessions ${subcommand} requires a session id`);
    if (subcommand === "show") {
      printJson(await client.getSession(sessionId));
      return;
    }
    if (subcommand === "append") {
      const content = positionals.join(" ").trim();
      const role = options.role === "assistant" || options.role === "agent" ? options.role : "user";
      if (!content) throw new Error("sessions append requires a message");
      printJson(await client.appendSessionMessage(sessionId, { role, content, agent: "cli" }));
      return;
    }
    if (subcommand === "context") {
      printJson(
        await client.getSessionContext(sessionId, {
          query: options.query,
          tokenBudget: options["token-budget"] ? Number(options["token-budget"]) : undefined,
        })
      );
      return;
    }
    if (subcommand === "resume") {
      printJson(await client.resumeSession(sessionId));
      return;
    }
    if (subcommand === "close") {
      printJson(
        await client.closeSession(sessionId, {
          status: options.cancelled === "true" ? "cancelled" : "completed",
          summary: options.summary,
        })
      );
      return;
    }
    if (subcommand === "memory") {
      const body = positionals.join(" ").trim();
      if (!body) throw new Error("sessions memory requires an outcome");
      printJson(
        await client.saveSessionMemory(sessionId, {
          body,
          title: options.title,
          tags: options.tags
            ?.split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        })
      );
      return;
    }
    throw new Error(`unknown sessions subcommand: ${subcommand}`);
  }

  if (command === "trace") {
    const requestedSubcommand = positionals[0];
    const subcommand =
      requestedSubcommand === "timeline" || requestedSubcommand === "conversation"
        ? (positionals.shift() ?? "conversation")
        : "conversation";
    const sessionId = positionals[0] ?? (subcommand === "conversation" ? positionals.shift() : null);
    if (!sessionId) {
      throw new Error("trace requires a session id");
    }
    if (subcommand === "timeline") {
      try {
        printJson(await client.getSessionTimeline(sessionId));
        return;
      } catch {
        await withDirectStore(async (store) => {
          const timeline = await buildTimelineFromStore(store, sessionId);
          if (!timeline) {
            throw new Error(`Unknown session: ${sessionId}`);
          }
          printJson(timeline);
        });
      }
      return;
    }
    const result = await client.getSessionEvents(sessionId);
    printJson(result);
    return;
  }

  if (command === "replay") {
    const sessionId = positionals.shift();
    if (!sessionId) {
      throw new Error("replay requires a session id");
    }
    const promptId = options.prompt;
    const modelProfileId = options.model ?? options["model-profile-id"] ?? null;
    if (!promptId || !modelProfileId) {
      throw new Error("replay requires --prompt <compiled-prompt-id> and --model <profile-id>");
    }
    const result = await client.replaySession(sessionId, {
      selectedPromptId: promptId,
      modelProfileId,
      mode:
        options.mode === "local" || options.mode === "cloud" || options.mode === "hybrid" ? options.mode : undefined,
      dryRun: options["dry-run"] === "true" || options.dryRun === "true",
    });
    printJson(result);
    return;
  }

  if (command === "status") {
    printJson(await client.status());
    return;
  }

  if (command === "runtime") {
    const subcommand = positionals.shift() ?? "status";
    if (subcommand !== "status") {
      throw new Error(`Unknown runtime command: ${subcommand}`);
    }
    printJson(await client.runtimeHealth());
    return;
  }

  if (command === "health") {
    if (options.deep === "true" || options.json === "true") {
      printJson(await client.healthDeep());
    } else {
      printJson(await client.health());
    }
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
        plannedFiles: (options.planned ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        editedFiles: (options.edited ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        checks: (options.checks ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        notes: options.notes,
      });
      printJson(result);
      return;
    }
  }

  if (command === "retrieval") {
    const subcommand = positionals.shift();
    const project = options.project;
    const query = subcommand ? `${subcommand} ${positionals.join(" ")}`.trim() : positionals.join(" ");
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

  if (command === "dev") {
    const subcommand = positionals[0];
    const runIdOrGoal = positionals[1];

    // ai dev runs — list all runs
    if (subcommand === "runs") {
      printJson(await client.listDevRuns(undefined, 50));
      return;
    }

    // ai dev show <run-id>
    if (subcommand === "show") {
      if (!runIdOrGoal) throw new Error("ai dev show <run-id>");
      printJson(await client.getDevRun(runIdOrGoal));
      return;
    }

    // ai dev diff <run-id>
    if (subcommand === "diff") {
      if (!runIdOrGoal) throw new Error("ai dev diff <run-id>");
      printJson(await client.getDevRunDiff(runIdOrGoal));
      return;
    }

    // ai dev approve <run-id>
    if (subcommand === "approve") {
      if (!runIdOrGoal) throw new Error("ai dev approve <run-id>");
      printJson(await client.approveDevRun(runIdOrGoal));
      return;
    }

    // ai dev cancel <run-id>
    if (subcommand === "cancel") {
      if (!runIdOrGoal) throw new Error("ai dev cancel <run-id>");
      printJson(await client.cancelDevRun(runIdOrGoal));
      return;
    }

    // ai dev apply <run-id>
    if (subcommand === "apply") {
      if (!runIdOrGoal) throw new Error("ai dev apply <run-id>");
      printJson(await client.applyDevRun(runIdOrGoal));
      return;
    }

    // ai dev "<goal>" — start a new dev run
    if (subcommand) {
      const project = options.project;
      if (!project) throw new Error('ai dev "<goal>" --project <project> [...]');
      const mode = options.mode === "cloud" || options.mode === "hybrid" ? options.mode : "local";
      const approveEdits = options["approve-edits"] === "true" || options["approve-edits"] === "1";
      const checks = options.checks
        ? options.checks
            .split(",")
            .map((c: string) => c.trim())
            .filter(Boolean)
        : undefined;
      const maxRepairs = Number(options["max-repairs"] ?? 1) || 1;
      printJson(
        await client.devRun({
          project,
          goal: subcommand,
          sessionId: options.session ?? null,
          mode,
          approveEdits,
          checks,
          maxRepairs,
        })
      );
      return;
    }

    printUsage();
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

async function dispatchRetrievalExplain(input: {
  positionals: string[];
  options: Record<string, string>;
}): Promise<void> {
  const project = input.options.project;
  if (!project) {
    throw new Error("retrieval explain requires --project <name>");
  }
  const query = input.positionals.join(" ").trim();
  if (!query) {
    throw new Error("retrieval explain requires a query string");
  }
  const mode: RetrievalMode =
    input.options.mode === "cloud" || input.options.mode === "hybrid" ? input.options.mode : "local";
  const depth: RetrievalDepth =
    input.options.depth === "shallow" || input.options.depth === "deep" ? input.options.depth : "standard";
  const limit = Number(input.options.limit ?? 8) || 8;
  await withDirectStore((store) => {
    const projectRecord = store.getProject(project);
    if (!projectRecord) {
      throw new Error(`Unknown project: ${project}`);
    }
    const projectId = projectRecord.id;
    const output = runRetrievalExplain(store, {
      projectId,
      query,
      mode,
      depth,
      limit,
    });
    printJson(output);
  });
}

if (process.argv[2] === "retrieval" && process.argv[3] === "explain") {
  const explainArgs = process.argv.slice(4);
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < explainArgs.length; i++) {
    const value = explainArgs[i];
    if (value === undefined) continue;
    if (value === "--project" || value === "--mode" || value === "--depth" || value === "--limit") {
      const next = explainArgs[i + 1];
      if (next) {
        options[value.slice(2)] = next;
        i++;
      }
      continue;
    }
    if (value.startsWith("--project=")) options.project = value.slice("--project=".length);
    else if (value.startsWith("--mode=")) options.mode = value.slice("--mode=".length);
    else if (value.startsWith("--depth=")) options.depth = value.slice("--depth=".length);
    else if (value.startsWith("--limit=")) options.limit = value.slice("--limit=".length);
    else if (value.startsWith("--")) {
      // ignore unknown flag
    } else {
      positionals.push(value);
    }
  }
  withDirectStore(async () => {
    await dispatchRetrievalExplain({ positionals, options });
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "memory") {
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
        | "global"
        | "project"
        | "repo"
        | "path"
        | undefined;
      printJson(store.memory.listEntries(undefined, scopeArg));
      return;
    }
    throw new Error(`unknown memory subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "embeddings") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "stats";
    if (sub === "stats") {
      const repo = store.embeddingCache;
      printJson({
        entryCount: repo.count(),
        stats: repo.stats(),
      });
      return;
    }
    if (sub === "purge") {
      const olderThan = process.argv.find((arg) => arg.startsWith("--older-than="))?.split("=")[1];
      const provider = process.argv.find((arg) => arg.startsWith("--provider="))?.split("=")[1];
      const model = process.argv.find((arg) => arg.startsWith("--model="))?.split("=")[1];
      const repo = store.embeddingCache;
      const removed = repo.purge({
        olderThanDays: olderThan ? Number(olderThan) : undefined,
        providerId: provider ?? null,
        modelName: model ?? null,
      });
      printJson({ removed });
      return;
    }
    throw new Error(`unknown embeddings subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "tools") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "list";
    if (sub === "list") {
      const { createDefaultToolRegistry } = await import("../../../packages/tools/src/index.ts");
      const registry = createDefaultToolRegistry();
      printJson({ tools: registry.list() });
      return;
    }
    if (sub === "call") {
      const name = process.argv[4];
      if (!name) {
        throw new Error("tools call requires a tool name");
      }
      const projectArg = readCliArg(process.argv, "project");
      if (!projectArg) {
        throw new Error("tools call requires --project <name>");
      }
      const argsJson = readCliArg(process.argv, "args");
      const allowHigh = process.argv.includes("--allow-high-risk");
      const project = store.getProject(projectArg);
      if (!project) {
        throw new Error(`Unknown project: ${projectArg}`);
      }
      const parsedArgs = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      const { createDefaultToolRegistry } = await import("../../../packages/tools/src/index.ts");
      const registry = createDefaultToolRegistry();
      const started = Date.now();
      const result = await registry.call(name, parsedArgs, {
        projectPath: project.path,
        projectId: project.id,
        sessionId: "cli",
        allowHighRisk: allowHigh,
      });
      printJson({ durationMs: Date.now() - started, ...result });
      return;
    }
    throw new Error(`unknown tools subcommand: ${sub}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "models") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "list";
    const config = resolveConfig({});
    const runtime = createModelRuntime({
      providers: store.models.listProviders().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        apiKeyEnv: provider.apiKeyEnv,
        enabled: provider.enabled,
      })),
      profiles: store.models.listProfiles(),
      cloudEnabled: config.cloudEnabled,
    });
    if (sub === "list") {
      printJson({
        providers: store.models.listProviders(),
        profiles: store.models.listProfiles(),
        routes: store.listModelRoutes(50),
      });
      return;
    }
    if (sub === "health") {
      const health = await Promise.all(store.models.listProviders().map((provider) => runtime.health(provider.id)));
      const calls = store.models.listAllCalls(50);
      printJson({
        providers: store.models.listProviders(),
        health,
        recentCalls: calls,
        routes: store.listModelRoutes(50),
        usageDaily: store.models.listUsageDaily(50),
      });
      return;
    }
    if (sub === "probe") {
      const profileArg = readCliArg(process.argv.slice(4), "profile");
      const promptArg = readCliArg(process.argv.slice(4), "prompt") ?? "Reply with the single word PONG.";
      const profiles = store.models.listProfiles();
      const targets = profileArg ? profiles.filter((profile) => profile.id === profileArg) : profiles;
      const results: Array<Record<string, unknown>> = [];
      for (const profile of targets) {
        const started = Date.now();
        try {
          const result = await runtime.invoke(profile.id, {
            role: profile.role,
            messages: [{ role: "user", content: promptArg }],
            temperature: 0,
            maxOutputTokens: 32,
          });
          results.push({
            profileId: profile.id,
            role: profile.role,
            modelName: profile.modelName,
            providerId: profile.providerId,
            status: "ok",
            latencyMs: Date.now() - started,
            text: result.text.slice(0, 240),
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          });
        } catch (error) {
          results.push({
            profileId: profile.id,
            role: profile.role,
            modelName: profile.modelName,
            providerId: profile.providerId,
            status: "failed",
            latencyMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      printJson({ results });
      return;
    }
    if (sub === "route") {
      const args = process.argv.slice(4);
      const taskPattern = args.filter((arg) => !arg.startsWith("--")).join(" ") || "ask";
      const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1];
      const risk = process.argv.find((arg) => arg.startsWith("--risk="))?.split("=")[1];
      const depth = process.argv.find((arg) => arg.startsWith("--depth="))?.split("=")[1];
      const question = process.argv
        .find((arg) => arg.startsWith("--question="))
        ?.split("=")
        .slice(1)
        .join("=");
      const goal = process.argv
        .find((arg) => arg.startsWith("--goal="))
        ?.split("=")
        .slice(1)
        .join("=");
      const routeDecision = await runtime.route({
        role: taskPattern.includes("plan")
          ? "planner"
          : taskPattern.includes("handoff")
            ? "coder_handoff"
            : taskPattern.includes("check")
              ? "reviewer"
              : "answer",
        mode: mode === "local" || mode === "cloud" || mode === "hybrid" ? mode : "any",
        cloudEnabled: config.cloudEnabled,
        details: {
          risk: risk === "low" || risk === "medium" || risk === "high" ? risk : undefined,
          depth: depth === "shallow" || depth === "standard" || depth === "deep" ? depth : undefined,
          question,
          goal,
        },
      });
      const route = store.recordModelRoute({
        taskPattern,
        mode: mode === "local" || mode === "cloud" || mode === "hybrid" ? mode : "any",
        selectedProfileId:
          routeDecision.profileId ??
          store.recommendModelProfile(
            taskPattern.includes("plan")
              ? "plan"
              : taskPattern.includes("handoff")
                ? "handoff"
                : taskPattern.includes("check")
                  ? "check"
                  : "ask",
            {
              risk: risk === "low" || risk === "medium" || risk === "high" ? risk : undefined,
              depth: depth === "shallow" || depth === "standard" || depth === "deep" ? depth : undefined,
              question,
              goal,
            }
          ),
        fallbackProfileId: routeDecision.fallbackProfileId,
        reason: routeDecision.reason,
      });
      printJson({
        route,
        profile: store.models.getProfile(route.selectedProfileId),
        decision: routeDecision,
      });
      return;
    }
    if (sub === "call") {
      const role =
        process.argv
          .find((arg) => arg.startsWith("--role="))
          ?.split("=")
          .slice(1)
          .join("=") ?? "summarizer";
      const prompt =
        process.argv
          .find((arg) => arg.startsWith("--prompt="))
          ?.split("=")
          .slice(1)
          .join("=") ?? "";
      const profileId =
        process.argv
          .find((arg) => arg.startsWith("--profile-id="))
          ?.split("=")
          .slice(1)
          .join("=") ?? null;
      const roleForRouting =
        role === "planner"
          ? "planner"
          : role === "coder_handoff"
            ? "coder_handoff"
            : role === "reflection"
              ? "reflection"
              : role === "query_rewrite"
                ? "query_rewrite"
                : role === "retrieval_judge"
                  ? "retrieval_judge"
                  : "summarizer";
      const chosenProfileId =
        profileId ??
        (
          await runtime.route({
            role: roleForRouting as
              | "intent"
              | "query_rewrite"
              | "retrieval_judge"
              | "answer"
              | "planner"
              | "coder_handoff"
              | "reviewer"
              | "reflection"
              | "summarizer"
              | "embedding"
              | "reranker",
            mode: "local",
            cloudEnabled: config.cloudEnabled,
            details: { question: prompt },
          })
        ).profileId ??
        store.recommendModelProfile("ask", { question: prompt });
      const callProfile = chosenProfileId ? store.models.getProfile(chosenProfileId) : null;
      if (!callProfile) {
        throw new Error("No model profile available for the requested role");
      }
      const result = await runtime.invoke(callProfile.id, {
        role: roleForRouting as
          | "intent"
          | "query_rewrite"
          | "retrieval_judge"
          | "answer"
          | "planner"
          | "coder_handoff"
          | "reviewer"
          | "reflection"
          | "summarizer"
          | "embedding"
          | "reranker",
        messages: [
          { role: "system", content: "You are a local model runtime." },
          { role: "user", content: prompt },
        ],
        metadata: { source: "cli", role },
      });
      const call = store.models.recordCall({
        profileId: callProfile.id,
        role: roleForRouting as
          | "intent"
          | "query_rewrite"
          | "retrieval_judge"
          | "answer"
          | "planner"
          | "coder_handoff"
          | "reviewer"
          | "reflection"
          | "summarizer"
          | "embedding"
          | "reranker",
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: result.latencyMs,
        status: "ok",
        request: { prompt, role, profileId: callProfile.id },
        response: { text: result.text, usage: result.usage ?? null },
      });
      printJson({ call, profile: callProfile, result });
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
    const compiledPrompts = store.listCompiledPrompts(sessionId, 100);
    const modelCalls = store.models.listCalls(sessionId);
    const events = store.listEvents(sessionId);
    const outcomes = store.evals.listOutcomes(sessionId);
    printJson({
      messages,
      runs,
      handoffs,
      retrievalQueries: queries,
      contextPacks: packs,
      compiledPrompts,
      modelCalls,
      events,
      outcomes,
    });
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else if (process.argv[2] === "prompts") {
  withDirectStore(async (store) => {
    const sub = process.argv[3] ?? "list";
    if (sub === "list") {
      const sessionId = readCliArg(process.argv, "session");
      const limit = Number(readCliArg(process.argv, "limit") ?? 50) || 50;
      const prompts = store.listCompiledPrompts(sessionId ?? null, limit);
      if (prompts.length === 0) {
        console.log("No compiled prompts found.");
        return;
      }
      for (const prompt of prompts) {
        console.log(formatPromptSummary(prompt));
      }
      return;
    }
    if (sub === "show") {
      const id = process.argv[4];
      if (!id) {
        throw new Error("prompts show requires a prompt id");
      }
      const prompt = store.getCompiledPrompt(id);
      if (!prompt) {
        throw new Error(`Unknown compiled prompt: ${id}`);
      }
      console.log(formatPromptDetail(prompt));
      return;
    }
    throw new Error(`unknown prompts subcommand: ${sub}`);
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
          : store.skills.listCandidates()
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
      const query = process.argv
        .find((arg) => arg.startsWith("--query="))
        ?.split("=")
        .slice(1)
        .join("=");
      const expected = process.argv
        .find((arg) => arg.startsWith("--expected="))
        ?.split("=")
        .slice(1)
        .join("=");
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
        const answer = await store.ask({
          project,
          question: c.question,
          mode: "local",
          depth: "standard",
        });
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
