import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { createStore } from "../../db/src/store.ts";
import { isSecretFile } from "../../execution-engine/src/index.ts";
import { buildProjectStatus, collectGitChangedPaths, processCommandRunner } from "../../project-status/src/index.ts";
import { checkPathPolicy, redactSecrets } from "../../safety/src/index.ts";
import type { SessionContextPreview, SessionContextPreviewItem } from "../../shared/src/index.ts";

type Store = ReturnType<typeof createStore>;

export async function compileSessionContextPreview(
  store: Store,
  input: { sessionId: string; query?: string | null; tokenBudget?: number }
): Promise<SessionContextPreview | null> {
  const session = store.getSession(input.sessionId);
  if (!session) return null;
  const tokenBudget = Math.min(32_000, Math.max(1_000, Math.trunc(input.tokenBudget ?? 8_000)));
  const project = session.projectId ? store.getProject(session.projectId) : null;
  let redactionCount = 0;
  const redactForPreview = (value: string): string => {
    const redacted = redactSecrets(value);
    redactionCount += redacted.redactions.reduce((sum, entry) => sum + entry.count, 0);
    return redacted.text;
  };
  const messages = store.conversation.listMessages(session.id, 100).slice(-20);
  const rawQuery =
    input.query ?? [...messages].reverse().find((message) => message.role === "user")?.content ?? session.userGoal;
  const query = redactForPreview(rawQuery);
  const [status, changedFilesResult, recentCommitsResult] = project
    ? await Promise.all([
        buildProjectStatus(store, { projectId: project.id }),
        collectGitChangedPaths(project.path),
        processCommandRunner.run("git", ["log", "-5", "--pretty=format:%h%x09%s"], {
          cwd: project.path,
          timeoutMs: 5_000,
        }),
      ])
    : [null, { paths: [], error: null }, null];
  const task = session.activeTaskId ? store.getTask(session.activeTaskId) : null;
  const lessons = session.projectId ? store.listProjectLessons(session.projectId, 5) : [];
  const rules = session.projectId ? store.listProjectRules(session.projectId, 5) : [];
  const memory = session.projectId ? store.listProjectMemory(session.projectId, 5) : [];
  const chunks = session.projectId && query ? store.searchChunks(session.projectId, query, { limit: 8 }) : [];
  const estimate = (content: string): number => Math.max(1, Math.ceil(content.length / 4));
  const readContextFile = async (candidatePath: string): Promise<{ path: string; content: string } | null> => {
    if (!project) return null;
    const policy = checkPathPolicy({ projectRoot: project.path, candidatePath });
    if (!policy.allowed) return null;
    try {
      const projectRelativePath = relative(project.path, policy.resolvedPath) || candidatePath;
      if (isSecretFile(projectRelativePath)) return null;
      if ((await stat(policy.resolvedPath)).size > 1_000_000) return null;
      const content = (await readFile(policy.resolvedPath, "utf8")).slice(0, 32_000);
      if (content.includes("\0")) return null;
      return {
        path: projectRelativePath,
        content,
      };
    } catch {
      return null;
    }
  };
  const activeFile = status?.context?.activeFile ? await readContextFile(status.context.activeFile) : null;
  const changedFiles = (
    await Promise.all(changedFilesResult.paths.slice(0, 12).map((path) => readContextFile(path)))
  ).filter((entry): entry is { path: string; content: string } => entry !== null);
  const selectedSymbol = status?.context?.selectedSymbol ?? null;
  const symbolChunks =
    session.projectId && selectedSymbol ? store.searchChunks(session.projectId, selectedSymbol, { limit: 3 }) : [];
  const failedChecks = session.projectId
    ? store
        .listCheckRuns(50, session.projectId)
        .filter((check) => check.status === "failed" || (check.exitCode !== null && check.exitCode !== 0))
        .slice(0, 5)
    : [];
  const activeRun = status?.activeWork?.runId ? store.dev.getRun(status.activeWork.runId) : null;
  const latestHandoff = store.listHandoffs(session.id, 1)[0] ?? null;
  const candidates: SessionContextPreviewItem[] = [
    {
      id: session.id,
      kind: "session",
      source: "workbench-session",
      reason: "Current shared session goal",
      title: session.title,
      content: session.userGoal,
      estimatedTokens: estimate(session.userGoal),
      freshness: session.updatedAt,
    },
    ...(task
      ? [
          {
            id: task.id,
            kind: "task" as const,
            source: "active-task",
            reason: "Task explicitly attached to this session",
            title: task.title,
            content: task.description,
            estimatedTokens: estimate(task.description),
            freshness: task.updatedAt,
          },
        ]
      : []),
    ...(status?.git?.branch
      ? [
          {
            id: `git:${project?.id ?? session.id}:${status.git.branch}`,
            kind: "git" as const,
            source: "git-status",
            reason: "Current project branch",
            title: `Branch ${status.git.branch}`,
            content: `branch=${status.git.branch} head=${status.git.head ?? "unknown"} ahead=${status.git.ahead} behind=${status.git.behind}`,
            estimatedTokens: 24,
            freshness: status.generatedAt,
          },
        ]
      : []),
    ...(activeFile
      ? [
          {
            id: `active-file:${activeFile.path}`,
            kind: "active_file" as const,
            source: activeFile.path,
            reason: "File active in the resolved desktop context",
            title: activeFile.path,
            content: activeFile.content,
            estimatedTokens: estimate(activeFile.content),
            freshness: status?.context?.observedAt ?? null,
          },
        ]
      : []),
    ...changedFiles.map((file) => ({
      id: `changed-file:${file.path}`,
      kind: "changed_file" as const,
      source: file.path,
      reason: "File is changed in the current Git worktree",
      title: file.path,
      content: file.content,
      estimatedTokens: estimate(file.content),
      freshness: status?.generatedAt ?? null,
    })),
    ...symbolChunks.map((chunk) => ({
      id: `symbol:${selectedSymbol}:${chunk.id}`,
      kind: "symbol" as const,
      source: chunk.path,
      reason: `Matched selected symbol: ${selectedSymbol}`,
      title: `${selectedSymbol} in ${chunk.path}`,
      content: chunk.content,
      estimatedTokens: estimate(chunk.content),
      freshness: null,
    })),
    ...(recentCommitsResult?.exitCode === 0 && recentCommitsResult.stdout.trim()
      ? [
          {
            id: `commits:${project?.id ?? session.id}`,
            kind: "commit" as const,
            source: "git-log",
            reason: "Recent project history",
            title: "Recent commits",
            content: recentCommitsResult.stdout.trim(),
            estimatedTokens: estimate(recentCommitsResult.stdout),
            freshness: status?.generatedAt ?? null,
          },
        ]
      : []),
    ...failedChecks.map((check) => ({
      id: `check:${check.id}`,
      kind: "check" as const,
      source: check.name,
      reason: "Recent failing project check",
      title: `${check.name} failed`,
      content: check.errorOutput ?? check.output ?? `${check.command} failed`,
      estimatedTokens: estimate(check.errorOutput ?? check.output ?? check.command ?? "check failed"),
      freshness: check.finishedAt ?? check.startedAt,
    })),
    ...(activeRun
      ? [
          {
            id: `run:${activeRun.id}`,
            kind: "run" as const,
            source: "active-development-run",
            reason: "Development run attached to active work",
            title: activeRun.goal,
            content: [activeRun.summary, activeRun.diffSummary, activeRun.errorMessage].filter(Boolean).join("\n"),
            estimatedTokens: estimate(
              [activeRun.summary, activeRun.diffSummary, activeRun.errorMessage].filter(Boolean).join("\n")
            ),
            freshness: activeRun.updatedAt,
          },
        ]
      : []),
    ...(latestHandoff
      ? [
          {
            id: `handoff:${latestHandoff.id}`,
            kind: "handoff" as const,
            source: latestHandoff.target,
            reason: "Latest handoff from this shared session",
            title: `Handoff to ${latestHandoff.target}`,
            content: latestHandoff.prompt,
            estimatedTokens: estimate(latestHandoff.prompt),
            freshness: null,
          },
        ]
      : []),
    ...messages.map((message) => ({
      id: message.id,
      kind: "message" as const,
      source: `conversation:${message.role}`,
      reason: "Recent shared-session conversation",
      title: `${message.role} message`,
      content: message.content,
      estimatedTokens: message.tokenCount,
      freshness: message.ts,
    })),
    ...rules.map((entry) => ({
      id: entry.id,
      kind: "rule" as const,
      source: "project-rule",
      reason: entry.pinned ? "Pinned project rule" : "Recent project rule",
      title: entry.title,
      content: entry.body,
      estimatedTokens: estimate(entry.body),
      freshness: entry.createdAt,
    })),
    ...lessons.map((entry) => ({
      id: entry.id,
      kind: "lesson" as const,
      source: "project-lesson",
      reason: "Recent project lesson",
      title: entry.title,
      content: entry.body,
      estimatedTokens: estimate(entry.body),
      freshness: entry.createdAt,
    })),
    ...memory.map((entry) => ({
      id: entry.id,
      kind: "memory" as const,
      source: entry.source,
      reason: "Durable project memory",
      title: entry.title,
      content: entry.body,
      estimatedTokens: estimate(entry.body),
      freshness: entry.createdAt,
    })),
    ...chunks.map((chunk) => ({
      id: chunk.id,
      kind: "retrieval" as const,
      source: chunk.path,
      reason: `Matched context query: ${query.slice(0, 120)}`,
      title: chunk.path,
      content: chunk.content,
      estimatedTokens: estimate(chunk.content),
      freshness: null,
    })),
  ];
  const safeCandidates = candidates.map((item) => {
    const content = redactForPreview(item.content);
    return { ...item, content, estimatedTokens: estimate(content) };
  });
  const included: SessionContextPreviewItem[] = [];
  const excluded: SessionContextPreview["excluded"] = [];
  const deduplicated: SessionContextPreviewItem[] = [];
  const seenContent = new Set<string>();
  for (const item of safeCandidates) {
    const fingerprint = item.content.trim().replace(/\s+/g, " ").toLowerCase();
    if (seenContent.has(fingerprint)) {
      excluded.push({ id: item.id, reason: "duplicate context", estimatedTokens: item.estimatedTokens });
      continue;
    }
    seenContent.add(fingerprint);
    deduplicated.push(item);
  }
  let estimatedTokens = 0;
  for (const item of deduplicated) {
    if (estimatedTokens + item.estimatedTokens <= tokenBudget) {
      included.push(item);
      estimatedTokens += item.estimatedTokens;
    } else {
      excluded.push({ id: item.id, reason: "token budget exceeded", estimatedTokens: item.estimatedTokens });
    }
  }
  return {
    schemaVersion: 1,
    id: `session-context:${session.id}`,
    generatedAt: new Date().toISOString(),
    session: {
      ...session,
      title: redactForPreview(session.title),
      userGoal: redactForPreview(session.userGoal),
      finalSummary: session.finalSummary ? redactForPreview(session.finalSummary) : null,
      errorMessage: session.errorMessage ? redactForPreview(session.errorMessage) : null,
    },
    project: project ? { ...project, repoUrl: project.repoUrl ? redactForPreview(project.repoUrl) : null } : null,
    query,
    tokenBudget,
    estimatedTokens,
    included,
    excluded,
    selectedFiles: [
      ...new Set([
        ...(activeFile ? [activeFile.path] : []),
        ...changedFiles.map((file) => file.path),
        ...symbolChunks.map((chunk) => chunk.path),
        ...chunks.map((chunk) => chunk.path),
      ]),
    ],
    index: { stale: status?.index.stale ?? true, lastIndexedAt: project?.lastIndexedAt ?? null },
    warnings: [
      ...(project ? [] : ["Session has no project scope"]),
      ...(status?.index.stale ? ["Project index is stale"] : []),
      ...(chunks.length === 0 && project ? ["Retrieval returned no matching sources"] : []),
      ...(changedFilesResult.error ? [changedFilesResult.error] : []),
      ...(changedFilesResult.paths.length > changedFiles.length
        ? [`${changedFilesResult.paths.length - changedFiles.length} changed file(s) were unreadable or outside scope`]
        : []),
      ...(redactionCount > 0 ? [`Redacted ${redactionCount} potential secret value(s)`] : []),
    ],
  };
}
