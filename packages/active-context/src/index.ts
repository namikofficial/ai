import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ActiveContext,
  ActiveContextSource,
  ContextEvidence,
  DesktopObservation,
  ProjectManifest,
} from "../../contracts/src/index.ts";
import { CONTROL_PLANE_SCHEMA_VERSION, desktopObservationSchema } from "../../contracts/src/index.ts";
import type { ActiveProjectSelection } from "../../db/src/repositories/project-registry.ts";
import { atomicWriteJson, defaultRegistryCachePath } from "../../project-registry/src/index.ts";

export interface ResolveActiveContextInput {
  observation: DesktopObservation;
  manifests: ProjectManifest[];
  selection: ActiveProjectSelection | null;
  previous: ActiveContext | null;
  now?: string;
  hysteresisMs?: number;
}

export interface ActiveContextCache {
  schemaVersion: 1;
  generatedAt: string;
  context: Pick<
    ActiveContext,
    | "id"
    | "observedAt"
    | "expiresAt"
    | "state"
    | "project"
    | "source"
    | "confidence"
    | "pinned"
    | "pinScope"
    | "evidence"
    | "rejectedCandidates"
    | "fallbackUsed"
    | "confirmationRecommended"
  >;
}

export function defaultActiveContextCachePath(): string {
  return join(dirname(defaultRegistryCachePath()), "active-context-v1.json");
}

export async function writeActiveContextCache(
  context: ActiveContext,
  path = defaultActiveContextCachePath()
): Promise<ActiveContextCache> {
  const cache: ActiveContextCache = {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    context: {
      id: context.id,
      observedAt: context.observedAt,
      expiresAt: context.expiresAt,
      state: context.state,
      project: context.project,
      source: context.source,
      confidence: context.confidence,
      pinned: context.pinned,
      pinScope: context.pinScope,
      evidence: context.evidence,
      rejectedCandidates: context.rejectedCandidates,
      fallbackUsed: context.fallbackUsed,
      confirmationRecommended: context.confirmationRecommended,
    },
  };
  await atomicWriteJson(path, cache);
  return cache;
}

export async function readActiveContextCache(
  path = defaultActiveContextCachePath()
): Promise<ActiveContextCache | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as ActiveContextCache;
    return value.schemaVersion === CONTROL_PLANE_SCHEMA_VERSION && value.context ? value : null;
  } catch {
    return null;
  }
}

interface Candidate {
  project: ProjectManifest;
  source: ActiveContextSource;
  confidence: number;
  priority: number;
  evidence: ContextEvidence;
}

function isWithin(candidate: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !relation.startsWith(sep));
}

function projectForPath(manifests: ProjectManifest[], path: string | null): ProjectManifest | null {
  if (!path) return null;
  return (
    manifests
      .filter((manifest) =>
        [manifest.path, manifest.repositoryRoot, ...manifest.approvedRoots].some((root) => isWithin(path, root))
      )
      .sort((left, right) => right.repositoryRoot.length - left.repositoryRoot.length)[0] ?? null
  );
}

function projectById(manifests: ProjectManifest[], id: string | null): ProjectManifest | null {
  return id ? (manifests.find((manifest) => manifest.id === id) ?? null) : null;
}

function isEditorWindow(observation: DesktopObservation): boolean {
  const className = observation.window?.className?.toLowerCase() ?? "";
  const role = observation.window?.role?.toLowerCase() ?? "";
  return (
    role === "editor" ||
    ["code", "code-oss", "codium", "vscodium", "zed", "sublime_text"].includes(className) ||
    className.startsWith("jetbrains-")
  );
}

function makeEvidence(
  kind: string,
  value: string,
  source: ActiveContextSource,
  confidence: number,
  accepted: boolean,
  reason: string
): ContextEvidence {
  return { kind, value, source, confidence, accepted, reason };
}

function candidate(
  project: ProjectManifest | null,
  source: ActiveContextSource,
  confidence: number,
  priority: number,
  kind: string,
  value: string,
  rejectedReason: string,
  rejected: ContextEvidence[],
  acceptedReason = `${kind} matched a registered project`
): Candidate | null {
  if (!project) {
    if (value) rejected.push(makeEvidence(kind, value, source, confidence, false, rejectedReason));
    return null;
  }
  return {
    project,
    source,
    confidence,
    priority,
    evidence: makeEvidence(kind, value, source, confidence, true, acceptedReason),
  };
}

function workbenchRouteProject(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
    return parsed.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function resolveActiveContext(input: ResolveActiveContextInput): ActiveContext {
  const observation = desktopObservationSchema.parse(input.observation);
  const now = input.now ?? new Date().toISOString();
  const rejected: ContextEvidence[] = [];
  const candidates: Candidate[] = [];
  const add = (value: Candidate | null): void => {
    if (value) candidates.push(value);
  };

  add(
    candidate(
      projectById(input.manifests, observation.explicitProjectId),
      "explicit_override",
      1,
      1,
      "explicit",
      observation.explicitProjectId ?? "",
      "explicit project is not registered",
      rejected
    )
  );
  const workspacePinValid =
    input.selection?.pinScope !== "workspace" || input.selection.workspaceId === observation.workspaceId;
  const sessionPinValid =
    input.selection?.pinScope !== "session" || input.selection.sessionId === observation.origin.instanceId;
  if (input.selection?.pinScope && workspacePinValid && sessionPinValid) {
    add(
      candidate(
        projectById(input.manifests, input.selection.projectId),
        "manual_pin",
        1,
        2,
        "pin",
        input.selection.projectId ?? "",
        "pinned project is not registered",
        rejected
      )
    );
  } else if (input.selection?.pinScope) {
    rejected.push(
      makeEvidence(
        "pin",
        input.selection.projectId ?? "unknown",
        "manual_pin",
        0,
        false,
        workspacePinValid ? "session pin expired" : "workspace pin expired"
      )
    );
  }
  const routeProjectId = workbenchRouteProject(observation.browser?.url ?? null);
  add(
    candidate(
      projectById(input.manifests, routeProjectId),
      "workbench_route",
      0.98,
      3,
      "route",
      observation.browser?.url ?? "",
      "Workbench route does not reference a registered project",
      rejected
    )
  );

  const editorPath = observation.editor?.file ?? observation.editor?.workspace ?? null;
  add(
    candidate(
      projectForPath(input.manifests, editorPath),
      "focused_editor",
      0.96,
      4,
      "editor-path",
      editorPath ?? "",
      "editor path is outside registered roots",
      rejected
    )
  );
  add(
    candidate(
      projectForPath(input.manifests, observation.terminal?.cwd ?? null),
      "focused_terminal",
      0.92,
      5,
      "terminal-cwd",
      observation.terminal?.cwd ?? "",
      "terminal cwd is outside registered roots",
      rejected
    )
  );

  if (observation.tmux) {
    if (observation.tmux.associationVerified) {
      add(
        candidate(
          projectForPath(input.manifests, observation.tmux.cwd),
          "focused_tmux",
          0.9,
          6,
          "tmux-cwd",
          observation.tmux.cwd ?? "",
          "verified tmux cwd is outside registered roots",
          rejected
        )
      );
    } else {
      rejected.push(
        makeEvidence(
          "tmux-cwd",
          observation.tmux.cwd ?? "unknown",
          "focused_tmux",
          0,
          false,
          "tmux client was not proven to belong to the focused terminal"
        )
      );
    }
  }

  const processCwd = observation.process?.cwd ?? null;
  if (processCwd && isEditorWindow(observation) && !observation.editor) {
    rejected.push(
      makeEvidence(
        "process-cwd",
        processCwd,
        "process_cwd",
        0,
        false,
        "editor process cwd is not proof of the active file or workspace"
      )
    );
  } else {
    add(
      candidate(
        projectForPath(input.manifests, processCwd),
        "process_cwd",
        0.82,
        7,
        "process-cwd",
        processCwd ?? "",
        "process cwd is outside registered roots",
        rejected
      )
    );
  }
  add(
    candidate(
      projectById(input.manifests, observation.browser?.projectId ?? null),
      "browser_route",
      0.72,
      8,
      "browser-project",
      observation.browser?.projectId ?? "",
      "browser project is not registered",
      rejected
    )
  );
  if (input.selection && !input.selection.pinScope) {
    add(
      candidate(
        projectById(input.manifests, input.selection.projectId),
        "workbench_selection",
        0.68,
        9,
        "selection",
        input.selection.projectId ?? "",
        "selected Workbench project is not registered",
        rejected
      )
    );
  }

  const previousAge = input.previous
    ? Date.parse(now) - Date.parse(input.previous.observedAt)
    : Number.POSITIVE_INFINITY;
  const preservePrevious =
    observation.transientWindow || (candidates.length === 0 && previousAge <= (input.hysteresisMs ?? 2_000));
  if (preservePrevious && input.previous?.project) {
    add(
      candidate(
        projectById(input.manifests, input.previous.project.id),
        "recent_context",
        observation.transientWindow ? 0.9 : 0.65,
        10,
        "previous-context",
        input.previous.project.id,
        "previous context project is not registered",
        rejected,
        observation.transientWindow ? "preserved across a transient window" : "preserved during resolver hysteresis"
      )
    );
  }

  candidates.sort((left, right) => left.priority - right.priority || right.confidence - left.confidence);
  const winner = candidates[0] ?? null;
  for (const losing of candidates.slice(1)) {
    rejected.push({
      ...losing.evidence,
      accepted: false,
      reason: `rejected by higher-precedence ${winner?.source ?? "candidate"}`,
    });
  }
  const changed = input.previous?.project?.id !== winner?.project.id;
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    id: `context_${observation.id}`,
    createdAt: now,
    updatedAt: now,
    origin: { source: "workbench", instanceId: observation.origin.instanceId, legacyRef: null },
    capabilities: ["explain", "pin", "hysteresis"],
    observedAt: observation.observedAt,
    expiresAt: new Date(Date.parse(observation.observedAt) + 30_000).toISOString(),
    state: winner ? "ready" : input.previous?.project ? "stale" : "unknown",
    project: winner ? { id: winner.project.id, name: winner.project.name, path: winner.project.path } : null,
    source: winner?.source ?? "unresolved",
    confidence: winner?.confidence ?? 0,
    pinned: winner?.source === "manual_pin",
    pinScope: winner?.source === "manual_pin" ? (input.selection?.pinScope ?? null) : null,
    window: observation.window,
    editor: observation.editor,
    terminal: observation.terminal,
    tmux: observation.tmux,
    git: null,
    activeFile: observation.editor?.file ?? null,
    selectedSymbol: null,
    evidence: winner ? [winner.evidence] : [],
    rejectedCandidates: rejected,
    fallbackUsed: preservePrevious ? (observation.transientWindow ? "transient-window" : "hysteresis") : null,
    confirmationRecommended: !winner || winner.confidence < 0.8 || (changed && winner.confidence < 0.9),
  };
}
