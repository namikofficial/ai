import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  AskResponse,
  HandoffResponse,
  PlanResponse,
  ProjectSummary,
  ReviewRecord,
  SessionRecord,
  TaskRecord,
} from "../../../packages/shared/src/index.ts";
import { api } from "./api.ts";
import { Badge, EmptyState, KeyValueList, Panel, StatCard } from "./components.tsx";
import { useWorkbenchStore } from "./store.ts";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

function useResource<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown> = []): ResourceState<T> {
  const liveTick = useWorkbenchStore((state) => state.liveTick);
  const [reloadTick, setReloadTick] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(() => {
    setReloadTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loaderRef.current()
      .then((value) => {
        if (active) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [liveTick, reloadTick, ...deps]);

  return { data, loading, error, refresh };
}

function PageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <div className="topbar">
        <div>
          <div className="title">{title}</div>
          {subtitle ? <div className="meta">{subtitle}</div> : null}
        </div>
        <button type="button" data-action="refresh">
          Refresh
        </button>
        <button type="button" data-action="palette">
          Command Palette
        </button>
      </div>
      <div className="grid">{children}</div>
    </>
  );
}

function formatList(items: string[]): ReactNode {
  if (items.length === 0) {
    return <div className="tiny">None</div>;
  }
  return items.join(", ");
}

function DashboardPage(): ReactNode {
  const resource = useResource(() => api.status());
  const status = resource.data?.data as any;
  const projects = Array.isArray(status?.projects) ? (status.projects as ProjectSummary[]) : [];
  const sessions = Array.isArray(status?.sessions) ? (status.sessions as SessionRecord[]) : [];
  const checks = Array.isArray(status?.checks) ? (status.checks as Array<{ name: string; status: string }>) : [];
  const settings = status?.settings ?? {};

  return (
    <PageShell title="Dashboard" subtitle="Local SQLite store, typed events, and SSE updates">
      <StatCard label="Projects" value={status?.summary?.projects ?? projects.length} detail="Indexed repos" />
      <StatCard label="Active Sessions" value={status?.summary?.activeSessions ?? 0} detail="Live work" />
      <StatCard label="Checks" value={status?.summary?.checks ?? checks.length} detail="Recent validations" />
      <Panel title="Projects" span={6}>
        <div className="list">
          {projects.length > 0 ? (
            projects.map((project) => (
              <a href={`/projects/${project.id}`} key={project.id} className="list-item">
                <div className="row">
                  <div>
                    <div>
                      <strong>{project.name}</strong>
                    </div>
                    <div className="tiny">{project.path}</div>
                  </div>
                  <Badge tone={project.status === "ready" ? "good" : project.status === "error" ? "bad" : "neutral"}>{project.status}</Badge>
                </div>
                <div className="tiny">
                  {project.language ?? "unknown"} · {project.framework ?? "unknown"} · {project.fileCount} files · {project.chunkCount} chunks
                </div>
              </a>
            ))
          ) : (
            <EmptyState title="No projects yet" body="Add a repo path to begin indexing." />
          )}
        </div>
      </Panel>
      <Panel title="Sessions" span={6}>
        <div className="list">
          {sessions.length > 0 ? (
            sessions.slice(0, 8).map((session) => (
              <a href={`/sessions/${session.id}`} key={session.id} className="list-item">
                <div className="row">
                  <div>
                    <div>
                      <strong>{session.title}</strong>
                    </div>
                    <div className="tiny">{session.userGoal}</div>
                  </div>
                  <Badge>{session.status}</Badge>
                </div>
                <div className="tiny">{session.startedAt}</div>
              </a>
            ))
          ) : (
            <EmptyState title="No sessions yet" body="Ask a question or index a repo to create one." />
          )}
        </div>
      </Panel>
      <Panel title="Checks" span={6}>
        <div className="list">
          {checks.length > 0 ? (
            checks.slice(0, 8).map((check) => (
              <div className="list-item" key={`${check.name}-${check.status}`}>
                <div className="row">
                  <strong>{check.name}</strong>
                  <Badge tone={check.status === "completed" ? "good" : check.status === "failed" ? "bad" : "warn"}>{check.status}</Badge>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No checks yet" body="Allowlisted validation runs will appear here." />
          )}
        </div>
      </Panel>
      <Panel title="Settings" span={6}>
        <div className="list">
          {Object.entries(settings).length > 0 ? (
            Object.entries(settings).map(([key, value]) => (
              <div className="list-item" key={key}>
                <div className="tiny">{key}</div>
                <div>{typeof value === "string" ? value : JSON.stringify(value)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No settings" body="Configuration will surface here once loaded." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function ProjectsPage(): ReactNode {
  const navigate = useNavigate();
  const selectedProjectId = useWorkbenchStore((state) => state.selectedProjectId);
  const setSelectedProjectId = useWorkbenchStore((state) => state.setSelectedProjectId);
  const resource = useResource(() => api.listProjects());
  const projects = resource.data?.data ?? [];
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const path = String(form.get("path") ?? "");
    const name = String(form.get("name") ?? "");
    setSubmitting(true);
    try {
      const result = await api.createProject({ path, name: name.trim() || undefined });
      setSelectedProjectId(result.data.id);
      navigate(`/projects/${result.data.id}`);
      resource.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell title="Projects" subtitle="Indexed repositories and local retrieval state">
      <Panel title="Projects" span={8}>
        <div className="list">
          {projects.length > 0 ? (
            projects.map((project) => (
              <a href={`/projects/${project.id}`} key={project.id} className="list-item">
                <div className="row">
                  <div>
                    <div>
                      <strong>{project.name}</strong>
                    </div>
                    <div className="tiny">{project.path}</div>
                  </div>
                  <Badge tone={project.id === selectedProjectId ? "good" : "neutral"}>{project.status}</Badge>
                </div>
                <div className="tiny">
                  {project.language ?? "unknown"} · {project.framework ?? "unknown"} · {project.fileCount} files · {project.chunkCount} chunks
                </div>
              </a>
            ))
          ) : (
            <EmptyState title="No projects yet" body="Add a repo path to begin indexing." />
          )}
        </div>
      </Panel>
      <Panel title="Add Project" span={4}>
        <form className="stack" onSubmit={submit}>
          <input name="path" placeholder="/home/namik/Documents/code/noxcrm" required />
          <input name="name" placeholder="optional display name" />
          <button type="submit" disabled={submitting}>
            {submitting ? "Adding..." : "Add project"}
          </button>
        </form>
      </Panel>
    </PageShell>
  );
}

function ProjectDetailPage(): ReactNode {
  const { projectId = "" } = useParams();
  const setSelectedProjectId = useWorkbenchStore((state) => state.setSelectedProjectId);
  const [indexing, setIndexing] = useState(false);
  const resource = useResource(() => Promise.all([api.getProject(projectId), api.getProjectMemory(projectId), api.getProjectRetrieval(projectId)]), [projectId]);
  const project = resource.data?.[0].data ?? null;
  const memory = resource.data?.[1].data ?? null;
  const retrieval = resource.data?.[2].data ?? null;
  const sessionsResource = useResource(() => api.listSessions(), [projectId]);
  const sessions = sessionsResource.data?.data.filter((session) => session.projectId === projectId) ?? [];

  useEffect(() => {
    if (project?.id) {
      setSelectedProjectId(project.id);
    }
  }, [project?.id, setSelectedProjectId]);

  if (!project) {
    return (
      <PageShell title="Project" subtitle={projectId}>
        <Panel title="Missing project" span={12}>
          <EmptyState title="Project not found" body={`No project found for ${projectId}.`} />
        </Panel>
      </PageShell>
    );
  }

  const lessons = Array.isArray(memory?.lessons) ? memory.lessons : [];
  const rules = Array.isArray(memory?.rules) ? memory.rules : [];
  const chunks = retrieval?.chunks ?? [];

  const reindex = async () => {
    setIndexing(true);
    try {
      await api.indexProject(project.id);
      resource.refresh();
      sessionsResource.refresh();
    } finally {
      setIndexing(false);
    }
  };

  return (
    <PageShell title={project.name} subtitle={project.path}>
      <Panel title="Project Summary" span={6}>
        <KeyValueList
          items={[
            ["Path", project.path],
            ["Language", project.language ?? "unknown"],
            ["Framework", project.framework ?? "unknown"],
            ["Status", project.status],
            ["Files", project.fileCount],
            ["Chunks", project.chunkCount],
          ]}
        />
      </Panel>
      <Panel title="Actions" span={6}>
        <div className="stack">
          <button type="button" onClick={reindex} disabled={indexing}>
            {indexing ? "Reindexing..." : "Reindex project"}
          </button>
        </div>
      </Panel>
      <Panel title="Recent Chunks" span={8}>
        <div className="list">
          {chunks.length > 0 ? (
            chunks.map((chunk) => (
              <div className="list-item" key={chunk.id}>
                <div className="row">
                  <strong>{chunk.path}</strong>
                  <Badge>score {chunk.score.toFixed(1)}</Badge>
                </div>
                <div className="tiny">
                  Lines {chunk.startLine}-{chunk.endLine}
                </div>
                <pre>{chunk.content.slice(0, 260)}</pre>
              </div>
            ))
          ) : (
            <EmptyState title="No chunks yet" body="Index the project to populate retrieval data." />
          )}
        </div>
      </Panel>
      <Panel title="Memory" span={4}>
        <div className="list">
          {[...lessons, ...rules].length > 0 ? (
            [...lessons, ...rules].map((entry: any, index: number) => (
              <div className="list-item" key={`${String(entry?.title ?? entry?.id ?? index)}`}>
                <strong>{entry?.title ?? entry?.id ?? "Memory"}</strong>
                <div className="tiny">{entry?.body ?? entry?.source ?? ""}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No memory yet" body="Lessons and rules show up here after work happens." />
          )}
        </div>
      </Panel>
      <Panel title="Sessions" span={12}>
        <div className="list">
          {sessions.length > 0 ? (
            sessions.map((session) => (
              <a className="list-item" href={`/sessions/${session.id}`} key={session.id}>
                <div className="row">
                  <div>
                    <div>
                      <strong>{session.title}</strong>
                    </div>
                    <div className="tiny">{session.mode}</div>
                  </div>
                  <Badge>{session.status}</Badge>
                </div>
              </a>
            ))
          ) : (
            <EmptyState title="No sessions" body="Indexing or asking against this project will create traces." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function SessionsPage(): ReactNode {
  const resource = useResource(() => api.listSessions());
  const sessions = resource.data?.data ?? [];
  return (
    <PageShell title="Sessions" subtitle="Traceable session history">
      <Panel title="Sessions" span={12}>
        <div className="list">
          {sessions.length > 0 ? (
            sessions.map((session) => (
              <a className="list-item" href={`/sessions/${session.id}`} key={session.id}>
                <div className="row">
                  <div>
                    <div>
                      <strong>{session.title}</strong>
                    </div>
                    <div className="tiny">{session.userGoal}</div>
                  </div>
                  <Badge>{session.status}</Badge>
                </div>
                <div className="tiny">{session.startedAt}</div>
              </a>
            ))
          ) : (
            <EmptyState title="No sessions" body="Ask a question or index a project to create one." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function SessionDetailPage(): ReactNode {
  const { sessionId = "" } = useParams();
  const resource = useResource(
    () => Promise.all([api.getSession(sessionId), api.getSessionEvents(sessionId), api.listTasks(), api.getSessionTrace(sessionId)]),
    [sessionId],
  );
  const session = resource.data?.[0].data ?? null;
  const events = resource.data?.[1].data ?? [];
  const tasks = resource.data?.[2].data.filter((task) => task.sessionId === sessionId) ?? [];
  const trace = resource.data?.[3].data ?? null;

  if (!session) {
    return (
      <PageShell title="Session" subtitle={sessionId}>
        <Panel title="Missing session" span={12}>
          <EmptyState title="Session not found" body={`No session found for ${sessionId}.`} />
        </Panel>
      </PageShell>
    );
  }

  return (
    <PageShell title={session.title} subtitle={session.userGoal}>
      <Panel title="Session Summary" span={6}>
        <KeyValueList
          items={[
            ["Goal", session.userGoal],
            ["Mode", session.mode],
            ["Status", session.status],
            ["Source", session.source],
            ["Started", session.startedAt],
            ["Finished", session.finishedAt ?? "running"],
          ]}
        />
      </Panel>
      <Panel title="Final Summary" span={6}>
        <pre>{session.finalSummary ?? "No final summary yet."}</pre>
      </Panel>
      <Panel title="Tasks" span={12}>
        <div className="list">
          {tasks.length > 0 ? (
            tasks.map((task) => (
              <a className="list-item" href={`/tasks/${task.id}`} key={task.id}>
                <div className="row">
                  <strong>{task.title}</strong>
                  <Badge tone={task.status === "completed" ? "good" : task.status === "failed" ? "bad" : "neutral"}>{task.status}</Badge>
                </div>
                <div className="tiny">
                  {task.type} · {task.risk}
                </div>
              </a>
            ))
          ) : (
            <EmptyState title="No tasks yet" body="Plan generation and worker jobs create task records here." />
          )}
        </div>
      </Panel>
      <Panel title="Events" span={12}>
        <div className="list">
          {events.length > 0 ? (
            events.map((event) => (
              <div className="list-item" key={event.id}>
                <div className="row">
                  <strong>{event.type}</strong>
                  <Badge>{event.ts}</Badge>
                </div>
                <div className="tiny">{JSON.stringify(event.payload ?? {})}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No events yet" body="Session events will stream here once work begins." />
          )}
        </div>
      </Panel>
      <Panel title="Trace Replay" span={12}>
        <div className="list">
          {trace ? (
            <>
              <div className="list-item">
                <strong>Model Calls</strong>
                <div className="tiny">{Array.isArray(trace.modelCalls) ? trace.modelCalls.length : 0} calls recorded</div>
              </div>
              <div className="list-item">
                <strong>Retrieval Queries</strong>
                <div className="tiny">{Array.isArray(trace.retrievalQueries) ? trace.retrievalQueries.length : 0} queries replayable</div>
              </div>
              <div className="list-item">
                <strong>Context Packs</strong>
                <div className="tiny">{Array.isArray(trace.contextPacks) ? trace.contextPacks.length : 0} packs stored</div>
              </div>
              <div className="list-item">
                <strong>Conversation Replay</strong>
                <pre>{JSON.stringify(trace.messages ?? [], null, 2).slice(0, 1200)}</pre>
              </div>
            </>
          ) : (
            <EmptyState title="No trace" body="The session trace will appear once the API returns replay data." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function TasksPage(): ReactNode {
  const resource = useResource(() => api.listTasks());
  const tasks = resource.data?.data ?? [];
  const byStatus = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <PageShell title="Tasks" subtitle="Task graph and lifecycle">
      <StatCard label="Queued" value={byStatus.queued ?? 0} />
      <StatCard label="Running" value={byStatus.running ?? 0} />
      <StatCard label="Completed" value={byStatus.completed ?? 0} />
      <Panel title="Recent Tasks" span={12}>
        <div className="list">
          {tasks.length > 0 ? (
            tasks.map((task) => (
              <a className="list-item" href={`/tasks/${task.id}`} key={task.id}>
                <div className="row">
                  <strong>{task.title}</strong>
                  <Badge tone={task.status === "completed" ? "good" : task.status === "failed" ? "bad" : "neutral"}>{task.status}</Badge>
                </div>
                <div className="tiny">{task.description}</div>
              </a>
            ))
          ) : (
            <EmptyState title="No tasks yet" body="Plans and worker jobs will appear here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function TaskDetailPage(): ReactNode {
  const { taskId = "" } = useParams();
  const resource = useResource(() => api.getTask(taskId), [taskId]);
  const task = resource.data?.data ?? null;
  const sessionResource = useResource(() => (task ? api.getSession(task.sessionId) : Promise.resolve({ status: "ok", data: null as SessionRecord | null })), [task?.sessionId ?? ""]);
  const eventsResource = useResource(() => (task ? api.getSessionEvents(task.sessionId) : Promise.resolve({ status: "ok", data: [] as any[] })), [task?.sessionId ?? ""]);
  const session = sessionResource.data?.data ?? null;
  const events = eventsResource.data?.data ?? [];
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  if (!task) {
    return (
      <PageShell title="Task" subtitle={taskId}>
        <Panel title="Missing task" span={12}>
          <EmptyState title="Task not found" body={`No task found for ${taskId}.`} />
        </Panel>
      </PageShell>
    );
  }

  const action = async (kind: "start" | "complete" | "fail") => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/${kind}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(kind === "complete" ? { result } : kind === "fail" ? { error } : {}),
    });
    if (!response.ok) {
      throw new Error(`Failed to ${kind} task`);
    }
    resource.refresh();
    eventsResource.refresh();
  };

  return (
    <PageShell title={task.title} subtitle={task.description}>
      <Panel title="Task Summary" span={6}>
        <KeyValueList
          items={[
            ["Type", task.type],
            ["Status", task.status],
            ["Risk", task.risk],
            ["Priority", task.priority],
            ["Session", session ? session.title : task.sessionId],
          ]}
        />
      </Panel>
      <Panel title="Actions" span={6}>
        <div className="stack">
          <button type="button" onClick={() => action("start")}>
            Start task
          </button>
          <textarea placeholder="completion notes" value={result} onChange={(event) => setResult(event.currentTarget.value)} />
          <button type="button" onClick={() => action("complete")}>
            Complete task
          </button>
          <textarea placeholder="failure notes" value={error} onChange={(event) => setError(event.currentTarget.value)} />
          <button type="button" onClick={() => action("fail")}>
            Fail task
          </button>
        </div>
      </Panel>
      <Panel title="Result" span={12}>
        <pre>{task.resultJson.trim() && task.resultJson.trim() !== "{}" ? task.resultJson : "No result recorded yet."}</pre>
      </Panel>
      <Panel title="Events" span={12}>
        <div className="list">
          {events.length > 0 ? (
            events.map((event) => (
              <div className="list-item" key={event.id}>
                <div className="row">
                  <strong>{event.type}</strong>
                  <Badge>{event.ts}</Badge>
                </div>
                <div className="tiny">{JSON.stringify(event.payload ?? {})}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No events yet" body="Task events will stream here once the task starts." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function AskPage(): ReactNode {
  const resource = useResource(() => api.listProjects());
  const projects = resource.data?.data ?? [];
  const selectedProjectId = useWorkbenchStore((state) => state.selectedProjectId);
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState<"shallow" | "standard" | "deep">("standard");
  const [project, setProject] = useState(selectedProjectId ?? projects[0]?.id ?? "");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!project && projects[0]?.id) {
      setProject(projects[0].id);
    }
  }, [project, projects]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await api.ask({ project, question, depth, mode: "local" });
      setResult(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell title="Ask" subtitle="Retrieval-backed question answering">
      <Panel title="Ask a Question" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            {projects.length > 0 ? (
              projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="">Add a project first</option>
            )}
          </select>
          <textarea value={question} onChange={(event) => setQuestion(event.currentTarget.value)} placeholder="where is auth handled?" />
          <select value={depth} onChange={(event) => setDepth(event.currentTarget.value as typeof depth)}>
            <option value="standard">Standard depth</option>
            <option value="shallow">Shallow</option>
            <option value="deep">Deep</option>
          </select>
          <button type="submit" disabled={submitting}>
            {submitting ? "Asking..." : "Ask"}
          </button>
        </form>
      </Panel>
      <Panel title="Answer" span={6}>
        {result ? (
          <>
            <Badge tone={result.confidence > 0.65 ? "good" : result.confidence > 0.35 ? "warn" : "bad"}>confidence {Math.round(result.confidence * 100)}%</Badge>
            <pre>{result.answer}</pre>
          </>
        ) : (
          <EmptyState title="No answer yet" body={error || "Submit a question to see retrieved context and citations."} />
        )}
      </Panel>
      <Panel title="Citations" span={12}>
        <div className="list">
          {result?.citations.length ? (
            result.citations.map((citation) => (
              <div className="list-item" key={`${citation.chunkId}-${citation.startLine}`}>
                <div className="row">
                  <strong>{citation.path}</strong>
                  <Badge>score {citation.score.toFixed(1)}</Badge>
                </div>
                <div className="tiny">
                  Lines {citation.startLine}-{citation.endLine}
                </div>
                <pre>{citation.excerpt}</pre>
              </div>
            ))
          ) : (
            <EmptyState title="No citations" body="If retrieval misses, the response will say so explicitly." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function PlannerPage(): ReactNode {
  const resource = useResource(() => Promise.all([api.listProjects(), api.listTasks(), api.listSessions()]));
  const projects = resource.data?.[0].data ?? [];
  const tasks = resource.data?.[1].data ?? [];
  const sessions = resource.data?.[2].data ?? [];
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [goal, setGoal] = useState("");
  const [risk, setRisk] = useState<"low" | "medium" | "high">("medium");
  const [result, setResult] = useState<PlanResponse | null>(null);

  useEffect(() => {
    if (!project && projects[0]?.id) setProject(projects[0].id);
  }, [project, projects]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await api.plan({ project, goal, risk });
    setResult(response.data);
  };

  return (
    <PageShell title="Planner" subtitle="Task graph generation">
      <Panel title="Generate Plan" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            {projects.length > 0 ? (
              projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="">Add a project first</option>
            )}
          </select>
          <textarea value={goal} onChange={(event) => setGoal(event.currentTarget.value)} placeholder="Refactor auth flow without breaking login" />
          <select value={risk} onChange={(event) => setRisk(event.currentTarget.value as typeof risk)}>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="high">High</option>
          </select>
          <button type="submit">Generate plan</button>
        </form>
      </Panel>
      <Panel title="Plan Summary" span={6}>
        {result ? (
          <KeyValueList
            items={[
              ["Risk", result.risk],
              ["Model", result.modelRecommendation],
              ["Depth", result.researchDepth],
              ["Checks", formatList(result.checks)],
            ]}
          />
        ) : (
          <EmptyState title="No plan yet" body="Generate a task graph for a project goal." />
        )}
      </Panel>
      <Panel title="Task Graph" span={12}>
        <div className="list">
          {result?.taskGraph.length ? (
            result.taskGraph.map((task) => (
              <div className="list-item" key={task.id}>
                <div className="row">
                  <strong>{task.title}</strong>
                  <Badge>{task.status}</Badge>
                </div>
                <div className="tiny">{task.description}</div>
                <div className="tiny">Checks: {task.checks.join(", ")}</div>
                <div className="tiny">Files: {task.expectedFiles.join(", ") || "none"}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No graph yet" body="The plan will appear here after generation." />
          )}
        </div>
      </Panel>
      <Panel title="Recent Tasks" span={6}>
        <div className="list">
          {tasks.slice(0, 8).map((task) => (
            <a className="list-item" href={`/tasks/${task.id}`} key={task.id}>
              <div className="row">
                <strong>{task.title}</strong>
                <Badge>{task.status}</Badge>
              </div>
              <div className="tiny">{task.description}</div>
            </a>
          ))}
        </div>
      </Panel>
      <Panel title="Plan Sessions" span={6}>
        <div className="list">
          {sessions.filter((session) => session.mode === "plan").slice(0, 8).map((session) => (
            <a className="list-item" href={`/sessions/${session.id}`} key={session.id}>
              <div className="row">
                <strong>{session.title}</strong>
                <Badge>{session.status}</Badge>
              </div>
              <div className="tiny">{session.userGoal}</div>
            </a>
          ))}
        </div>
      </Panel>
    </PageShell>
  );
}

function HandoffPage(): ReactNode {
  const resource = useResource(() => Promise.all([api.listProjects(), api.listSessions()]));
  const projects = resource.data?.[0].data ?? [];
  const sessions = resource.data?.[1].data ?? [];
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [target, setTarget] = useState<HandoffResponse["target"]>("manual");
  const [subtask, setSubtask] = useState("");
  const [result, setResult] = useState<HandoffResponse | null>(null);

  useEffect(() => {
    if (!sessionId && sessions[0]?.id) setSessionId(sessions[0].id);
    if (!project && projects[0]?.id) setProject(projects[0].id);
  }, [project, projects, sessionId, sessions]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await api.handoff({ sessionId, project, target, subtask });
    setResult(response.data);
  };

  return (
    <PageShell title="Handoff" subtitle="Target-specific prompt export">
      <Panel title="Create Handoff" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={sessionId} onChange={(event) => setSessionId(event.currentTarget.value)}>
            {sessions.length > 0 ? sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>) : <option value="">Run a session first</option>}
          </select>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            {projects.length > 0 ? projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Add a project first</option>}
          </select>
          <select value={target} onChange={(event) => setTarget(event.currentTarget.value as HandoffResponse["target"])}>
            <option value="opencode">OpenCode</option>
            <option value="codex">Codex</option>
            <option value="manual">Manual</option>
            <option value="clipboard">Clipboard</option>
            <option value="file">File</option>
          </select>
          <textarea value={subtask} onChange={(event) => setSubtask(event.currentTarget.value)} placeholder="Implement the next smallest change" />
          <button type="submit">Generate handoff</button>
        </form>
      </Panel>
      <Panel title="Prompt" span={6}>
        {result ? <pre>{result.prompt}</pre> : <EmptyState title="No handoff yet" body="Generate a target-specific prompt from a live session." />}
      </Panel>
      <Panel title="Selected Context" span={12}>
        {result ? (
          <KeyValueList
            items={[
              ["Files to inspect", formatList(result.selectedContext.filesToInspect)],
              ["Files likely to edit", formatList(result.selectedContext.filesLikelyToEdit)],
              ["Checks to run", formatList(result.selectedContext.checksToRun)],
              ["Constraints", formatList(result.selectedContext.constraints)],
            ]}
          />
        ) : (
          <EmptyState title="No context yet" body="The handoff will include files, checks, and constraints." />
        )}
      </Panel>
    </PageShell>
  );
}

function ChecksPage(): ReactNode {
  const resource = useResource(() => api.listChecks());
  const checks = resource.data?.data ?? [];
  const [name, setName] = useState("typecheck");
  const [projectId, setProjectId] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await api.runCheck({ name, projectId: projectId || null });
    resource.refresh();
  };

  return (
    <PageShell title="Checks" subtitle="Allowlisted validation runs">
      <Panel title="Run Check" span={4}>
        <form className="stack" onSubmit={submit}>
          <select value={name} onChange={(event) => setName(event.currentTarget.value)}>
            <option value="typecheck">typecheck</option>
            <option value="tests">tests</option>
            <option value="build">build</option>
            <option value="lint">lint</option>
          </select>
          <input value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)} placeholder="optional project id" />
          <button type="submit">Run check</button>
        </form>
      </Panel>
      <Panel title="Recent Checks" span={8}>
        <div className="list">
          {checks.length > 0 ? (
            checks.map((check) => (
              <div className="list-item" key={check.id}>
                <div className="row">
                  <strong>{check.name}</strong>
                  <Badge tone={check.status === "completed" ? "good" : check.status === "failed" ? "bad" : check.status === "blocked" ? "bad" : "neutral"}>{check.status}</Badge>
                </div>
                <div className="tiny">{check.output ?? check.errorOutput ?? "No output yet."}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No checks yet" body="Allowlisted validation runs will show up here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function MemoryPage(): ReactNode {
  const resource = useResource(() =>
    Promise.all([
      api.listMemoryCandidates({ status: "pending" }),
      api.listMemoryEntries(),
      api.listProjects(),
    ]),
  );
  const candidates = (resource.data?.[0].data ?? []) as Array<Record<string, unknown>>;
  const entries = (resource.data?.[1].data ?? []) as Array<Record<string, unknown>>;
  const projects = (resource.data?.[2].data ?? []) as ProjectSummary[];
  const [projectId, setProjectId] = useState("");
  const [projectRules, setProjectRules] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    if (!projectId && projects[0]?.id) setProjectId(projects[0].id);
  }, [projectId, projects]);

  useEffect(() => {
    if (!projectId) {
      setProjectRules([]);
      return;
    }
    api.listProjectRules(projectId).then((response) => setProjectRules(response.data as Array<Record<string, unknown>>));
  }, [projectId]);

  const accept = async (id: string) => {
    await api.acceptMemoryCandidate(id, "accepted from web");
    resource.refresh();
  };
  const reject = async (id: string) => {
    await api.rejectMemoryCandidate(id, "rejected from web");
    resource.refresh();
  };

  return (
    <PageShell title="Memory" subtitle="Memory candidates, entries, and project rules">
      <Panel title="Pending Candidates" span={12}>
        <div className="list">
          {candidates.length > 0 ? (
            candidates.map((c) => (
              <div className="list-item" key={String(c.id)}>
                <div className="row">
                  <strong>{String(c.title ?? c.kind ?? c.id)}</strong>
                  <Badge tone="warn">{String(c.kind ?? "candidate")}</Badge>
                </div>
                <div className="tiny">{String(c.body ?? "")}</div>
                <div className="tiny">
                  confidence {Number(c.confidence ?? 0).toFixed(2)} · scope {String(c.scope ?? "project")}
                </div>
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <button type="button" onClick={() => accept(String(c.id))}>
                    Accept
                  </button>
                  <button type="button" onClick={() => reject(String(c.id))}>
                    Reject
                  </button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No pending candidates" body="Asks, reviews, and reflection jobs create candidates here." />
          )}
        </div>
      </Panel>
      <Panel title="Accepted Entries" span={8}>
        <div className="list">
          {entries.length > 0 ? (
            entries.map((entry) => (
              <div className="list-item" key={String(entry.id)}>
                <div className="row">
                  <strong>{String(entry.title ?? entry.kind ?? entry.id)}</strong>
                  <Badge tone="good">{String(entry.kind ?? "entry")}</Badge>
                </div>
                <div className="tiny">{String(entry.body ?? "")}</div>
                <div className="tiny">
                  scope {String(entry.scope ?? "project")} · used {Number(entry.useCount ?? 0)} times
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No accepted entries" body="Accept a candidate to record a durable entry." />
          )}
        </div>
      </Panel>
      <Panel title="Project Rules" span={4}>
        <div className="stack">
          <select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
            {projects.length > 0 ? projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>) : <option value="">No project</option>}
          </select>
          <div className="list">
            {projectRules.length > 0 ? (
              projectRules.map((rule) => (
                <div className="list-item" key={String(rule.id)}>
                  <strong>{String(rule.title ?? rule.id)}</strong>
                  <div className="tiny">{String(rule.body ?? "")}</div>
                </div>
              ))
            ) : (
              <EmptyState title="No rules" body="Project rules will appear here once the project memory grows." />
            )}
          </div>
        </div>
      </Panel>
    </PageShell>
  );
}

function RetrievalPage(): ReactNode {
  const resource = useResource(() =>
    Promise.all([
      api.listProjects(),
      api.listSessions(),
      api.listMemoryCandidates({ status: "pending" }),
    ]),
  );
  const projects = (resource.data?.[0].data ?? []) as ProjectSummary[];
  const sessions = (resource.data?.[1].data ?? []) as SessionRecord[];
  const misses = ((resource.data?.[2].data ?? []) as Array<Record<string, unknown>>).filter(
    (c) => c.kind === "retrieval_miss",
  );
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [queries, setQueries] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    if (!project && projects[0]?.id) setProject(projects[0].id);
    if (!sessionId && sessions[0]?.id) setSessionId(sessions[0].id);
  }, [project, projects, sessionId, sessions]);

  useEffect(() => {
    if (!sessionId) {
      setQueries([]);
      return;
    }
    api.listRetrievalQueries({ sessionId, limit: 20 }).then((response) => setQueries(response.data));
  }, [sessionId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await api.searchRetrieval({ project, query, limit: 8 });
    setResults(response.data as Array<Record<string, unknown>>);
  };

  return (
    <PageShell title="Retrieval" subtitle="Search, recent queries, and misses">
      <Panel title="Search" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            {projects.length > 0 ? projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Add a project first</option>}
          </select>
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="auth router" />
          <button type="submit">Search</button>
        </form>
      </Panel>
      <Panel title="Results" span={6}>
        <div className="list">
          {results.length > 0 ? (
            results.map((chunk) => (
              <div className="list-item" key={String(chunk.id ?? `${chunk.path}-${chunk.startLine}`)}>
                <div className="row">
                  <strong>{String(chunk.path ?? "")}</strong>
                  <Badge>score {Number(chunk.score ?? 0).toFixed(1)}</Badge>
                </div>
                <pre>{String(chunk.content ?? chunk.excerpt ?? "").slice(0, 260)}</pre>
              </div>
            ))
          ) : (
            <EmptyState title="No results" body="Run a retrieval search against a project." />
          )}
        </div>
      </Panel>
      <Panel title="Recent Retrieval Queries" span={8}>
        <div className="stack">
          <select value={sessionId} onChange={(event) => setSessionId(event.currentTarget.value)}>
            {sessions.length > 0 ? sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>) : <option value="">No sessions</option>}
          </select>
          <div className="list">
            {queries.length > 0 ? (
              queries.map((q) => (
                <a className="list-item" href={`/retrieval/queries/${String(q.id)}`} key={String(q.id)}>
                  <div className="row">
                    <strong>{String(q.originalQuery ?? q.id)}</strong>
                    <Badge tone="neutral">{String(q.intent ?? "?")}</Badge>
                  </div>
                  <div className="tiny">
                    mode {String(q.mode ?? "?")} · depth {String(q.depth ?? "?")} · {String(q.createdAt ?? "")}
                  </div>
                </a>
              ))
            ) : (
              <EmptyState title="No retrieval queries" body="Ask a question to create retrieval queries." />
            )}
          </div>
        </div>
      </Panel>
      <Panel title="Missed Paths" span={4}>
        <div className="list">
          {misses.length > 0 ? (
            misses.map((m) => (
              <div className="list-item" key={String(m.id)}>
                <strong>{String(m.title ?? m.id)}</strong>
                <div className="tiny">{String(m.body ?? "")}</div>
                <div className="tiny">
                  confidence {Number(m.confidence ?? 0).toFixed(2)} · scope {String(m.scope ?? "project")}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No misses" body="Missed retrieval paths will surface here for review." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function RetrievalQueryDetailPage(): ReactNode {
  const { queryId = "" } = useParams();
  const resource = useResource(() => api.getRetrievalQuery(queryId), [queryId]);
  const detail = resource.data?.data as
    | {
        query: Record<string, unknown>;
        rewrites: Array<Record<string, unknown>>;
        results: Array<Record<string, unknown>>;
        selected: Array<Record<string, unknown>>;
        misses: Array<Record<string, unknown>>;
        feedback: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!detail) {
    return (
      <PageShell title="Retrieval Query" subtitle={queryId}>
        <Panel title="Loading" span={12}>
          <EmptyState title="Loading retrieval query" body="Fetching the trace from the API." />
        </Panel>
      </PageShell>
    );
  }
  return (
    <PageShell title="Retrieval Query" subtitle={String(detail.query.originalQuery ?? queryId)}>
      <Panel title="Query" span={6}>
        <KeyValueList
          items={[
            ["Original", String(detail.query.originalQuery ?? "")],
            ["Intent", String(detail.query.intent ?? "?")],
            ["Mode", String(detail.query.mode ?? "?")],
            ["Depth", String(detail.query.depth ?? "?")],
            ["Project", String(detail.query.projectId ?? "—")],
            ["Session", String(detail.query.sessionId ?? "—")],
            ["Created", String(detail.query.createdAt ?? "")],
          ]}
        />
      </Panel>
      <Panel title="Rewrites" span={6}>
        <div className="list">
          {detail.rewrites.length > 0 ? (
            detail.rewrites.map((r) => (
              <div className="list-item" key={String(r.id)}>
                <strong>{String(r.variant ?? "")}</strong>
                <div className="tiny">terms: {Array.isArray(r.terms) ? (r.terms as string[]).join(", ") : "—"}</div>
                <div className="tiny">confidence {Number(r.confidence ?? 0).toFixed(2)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No rewrites" body="Query rewrite did not run." />
          )}
        </div>
      </Panel>
      <Panel title="Results" span={8}>
        <div className="list">
          {detail.results.length > 0 ? (
            detail.results.map((r) => (
              <div className="list-item" key={String(r.id)}>
                <div className="row">
                  <strong>{String(r.path ?? "")}</strong>
                  <Badge>score {Number(r.finalScore ?? r.baseScore ?? 0).toFixed(1)}</Badge>
                </div>
                <div className="tiny">
                  source {String(r.source ?? "?")} · lines {String(r.startLine ?? "?")}-{String(r.endLine ?? "?")}
                </div>
                <div className="tiny">{String(r.excerpt ?? "").slice(0, 200)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No results" body="Retrieval returned no chunks." />
          )}
        </div>
      </Panel>
      <Panel title="Selected Context" span={4}>
        <div className="list">
          {detail.selected.length > 0 ? (
            detail.selected.map((s) => (
              <div className="list-item" key={String(s.id)}>
                <div className="row">
                  <strong>rank {Number(s.rank ?? 0)}</strong>
                  <Badge tone="good">{Number(s.tokenCount ?? 0)} tokens</Badge>
                </div>
                <div className="tiny">{String(s.excerpt ?? "").slice(0, 160)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="Nothing selected" body="No chunks made it into the context pack." />
          )}
        </div>
      </Panel>
      <Panel title="Misses" span={6}>
        <div className="list">
          {detail.misses.length > 0 ? (
            detail.misses.map((m) => (
              <div className="list-item" key={String(m.id)}>
                <strong>{String(m.missedPath ?? m.id)}</strong>
                <div className="tiny">{String(m.notes ?? "")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No misses" body="No missed paths recorded for this query." />
          )}
        </div>
      </Panel>
      <Panel title="Feedback" span={6}>
        <div className="list">
          {detail.feedback.length > 0 ? (
            detail.feedback.map((f) => (
              <div className="list-item" key={String(f.id)}>
                <div className="row">
                  <strong>{String(f.kind ?? "feedback")}</strong>
                  <Badge>{String(f.rating ?? "?")}</Badge>
                </div>
                <div className="tiny">{String(f.notes ?? "")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No feedback" body="Feedback is recorded when a query is rated." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function ReviewsPage(): ReactNode {
  const resource = useResource(() => Promise.all([api.listReviews(), api.listProjects()]));
  const reviews = resource.data?.[0].data ?? [];
  const projects = resource.data?.[1].data ?? [];
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [plannedFiles, setPlannedFiles] = useState("");
  const [editedFiles, setEditedFiles] = useState("");
  const [checks, setChecks] = useState("");
  const [result, setResult] = useState<ReviewRecord | null>(null);

  useEffect(() => {
    if (!project && projects[0]?.id) setProject(projects[0].id);
  }, [project, projects]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await api.createReview({
      project,
      title: title || undefined,
      plannedFiles: plannedFiles.split(",").map((item) => item.trim()).filter(Boolean),
      editedFiles: editedFiles.split(",").map((item) => item.trim()).filter(Boolean),
      checks: checks.split(",").map((item) => item.trim()).filter(Boolean),
    });
    setResult(response.data as any);
    resource.refresh();
  };

  return (
    <PageShell title="Reviews" subtitle="Review summaries and risk checks">
      <Panel title="Create Review" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={project} onChange={(event) => setProject(event.currentTarget.value)}>
            {projects.length > 0 ? projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Add a project first</option>}
          </select>
          <input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="review title" />
          <input value={plannedFiles} onChange={(event) => setPlannedFiles(event.currentTarget.value)} placeholder="planned files, comma separated" />
          <input value={editedFiles} onChange={(event) => setEditedFiles(event.currentTarget.value)} placeholder="edited files, comma separated" />
          <input value={checks} onChange={(event) => setChecks(event.currentTarget.value)} placeholder="checks, comma separated" />
          <button type="submit">Create review</button>
        </form>
      </Panel>
      <Panel title="Summary" span={6}>
        {result ? <pre>{result.summary}</pre> : <EmptyState title="No review yet" body="Create a review to see a summary." />}
      </Panel>
      <Panel title="Recent Reviews" span={12}>
        <div className="list">
          {reviews.length > 0 ? (
            reviews.map((review: any) => (
              <a className="list-item" href={`/reviews/${review.id}`} key={review.id}>
                <div className="row">
                  <strong>{review.title}</strong>
                  <Badge>{review.createdAt}</Badge>
                </div>
                <div className="tiny">{review.summary}</div>
              </a>
            ))
          ) : (
            <EmptyState title="No reviews yet" body="Review history will accumulate here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function ReviewDetailPage(): ReactNode {
  const { reviewId = "" } = useParams();
  const resource = useResource(() => api.getReview(reviewId), [reviewId]);
  const review = resource.data?.data ?? null;
  if (!review) {
    return (
      <PageShell title="Review" subtitle={reviewId}>
        <Panel title="Missing review" span={12}>
          <EmptyState title="Review not found" body={`No review found for ${reviewId}.`} />
        </Panel>
      </PageShell>
    );
  }
  return (
    <PageShell title={review.title} subtitle={review.summary}>
      <Panel title="Review Summary" span={6}>
        <KeyValueList items={[["Project", review.projectId ?? "none"], ["Session", review.sessionId ?? "none"], ["Created", review.createdAt]]} />
      </Panel>
      <Panel title="Next Step" span={6}>
        <pre>{(review as any).nextStep ?? "No next step recorded."}</pre>
      </Panel>
    </PageShell>
  );
}

function ModelsPage(): ReactNode {
  const resource = useResource(() =>
    Promise.all([api.getModels(), api.getModelProviders(), api.getModelHealth(), api.getModelCalls(30), api.getModelRoutes()]),
  );
  const usage = (resource.data?.[0].data?.usage ?? []) as Array<{ day: string; modelName: string; promptTokens: number; completionTokens: number; requests: number }>;
  const providers = (resource.data?.[1].data?.providers ?? []) as Array<Record<string, unknown>>;
  const profiles = (resource.data?.[1].data?.profiles ?? []) as Array<Record<string, unknown>>;
  const healthProviders = (resource.data?.[2].data?.providers ?? []) as Array<Record<string, unknown>>;
  const calls = (resource.data?.[3].data ?? []) as Array<Record<string, unknown>>;
  const routes = (resource.data?.[4].data ?? []) as Array<Record<string, unknown>>;

  return (
    <PageShell title="Models" subtitle="Local model routing, providers, and recent calls">
      <Panel title="Providers" span={6}>
        <div className="list">
          {providers.length > 0 ? (
            providers.map((provider) => (
              <div className="list-item" key={String(provider.id)}>
                <div className="row">
                  <strong>{String(provider.name ?? provider.id)}</strong>
                  <Badge tone="good">{String(provider.localOnly ? "local" : "cloud")}</Badge>
                </div>
                <div className="tiny">kind {String(provider.kind ?? "?")} · {String(provider.baseUrl ?? "no base url")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No providers" body="Register a model provider to see routing options." />
          )}
        </div>
      </Panel>
      <Panel title="Profiles" span={6}>
        <div className="list">
          {profiles.length > 0 ? (
            profiles.map((profile) => (
              <div className="list-item" key={String(profile.id)}>
                <div className="row">
                  <strong>{String(profile.modelName ?? profile.id)}</strong>
                  <Badge tone="neutral">{String(profile.role ?? "?")}</Badge>
                </div>
                <div className="tiny">
                  ctx {String(profile.contextWindow ?? "?")} · max out {String(profile.maxOutputTokens ?? "?")} · quality {Number(profile.qualityScore ?? 0).toFixed(2)}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No profiles" body="Profiles are created from providers." />
          )}
        </div>
      </Panel>
      <Panel title="Routes" span={6}>
        <div className="list">
          {routes.length > 0 ? (
            routes.map((route) => (
              <div className="list-item" key={String(route.id)}>
                <div className="row">
                  <strong>{String(route.taskPattern ?? route.id)}</strong>
                  <Badge tone="neutral">{String(route.mode ?? "any")}</Badge>
                </div>
                <div className="tiny">
                  selected {String(route.selectedProfileId ?? "?")} · fallback {String(route.fallbackProfileId ?? "none")}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No routes" body="Route decisions will appear here once model routing is recorded." />
          )}
        </div>
      </Panel>
      <Panel title="Health (last call per provider)" span={6}>
        <div className="list">
          {healthProviders.length > 0 ? (
            healthProviders.map((provider) => {
              const last = provider.lastCall as Record<string, unknown> | null;
              return (
                <div className="list-item" key={String(provider.id)}>
                  <div className="row">
                    <strong>{String(provider.name ?? provider.id)}</strong>
                    <Badge tone={last ? "good" : "neutral"}>{last ? "called" : "idle"}</Badge>
                  </div>
                  <div className="tiny">
                    {last
                      ? `latency ${Number(last.latencyMs ?? 0)}ms · prompt ${Number(last.promptTokens ?? 0)} · completion ${Number(last.completionTokens ?? 0)}`
                      : "no calls recorded yet"}
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState title="No providers" body="No model providers registered." />
          )}
        </div>
      </Panel>
      <Panel title="Recent Calls" span={6}>
        <div className="list">
          {calls.length > 0 ? (
            calls.map((call) => (
              <div className="list-item" key={String(call.id)}>
                <div className="row">
                  <strong>{String(call.role ?? "call")}</strong>
                  <Badge tone={call.success === false ? "bad" : "good"}>{String(call.success === false ? "failed" : "ok")}</Badge>
                </div>
                <div className="tiny">
                  profile {String(call.profileId ?? "?")} · prompt {Number(call.promptTokens ?? 0)} · completion {Number(call.completionTokens ?? 0)} · {Number(call.latencyMs ?? 0)}ms
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No calls" body="Model calls will appear here as they happen." />
          )}
        </div>
      </Panel>
      <Panel title="Daily Usage" span={12}>
        <div className="list">
          {usage.length > 0 ? (
            usage.map((item) => (
              <div className="list-item" key={`${item.day}-${item.modelName}`}>
                <div className="row">
                  <strong>{item.modelName}</strong>
                  <Badge>{item.day}</Badge>
                </div>
                <div className="tiny">
                  {item.requests} requests · prompt {item.promptTokens} · completion {item.completionTokens}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No usage yet" body="Model usage will appear here once calls are recorded." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function SkillsPage(): ReactNode {
  const resource = useResource(() => Promise.all([api.listSkills(), api.listSkillCandidates({ status: "pending" }), api.listSkillCandidates({ status: "rejected" })]));
  const skills = (resource.data?.[0].data ?? []) as Array<Record<string, unknown>>;
  const pending = (resource.data?.[1].data ?? []) as Array<Record<string, unknown>>;
  const rejected = (resource.data?.[2].data ?? []) as Array<Record<string, unknown>>;
  const accept = async (id: string) => {
    await api.acceptSkillCandidate(id);
    resource.refresh();
  };
  const reject = async (id: string) => {
    await api.rejectSkillCandidate(id, "rejected from web");
    resource.refresh();
  };
  return (
    <PageShell title="Skills" subtitle="Promoted skills, pending candidates, and rejections">
      <Panel title="Active Skills" span={6}>
        <div className="list">
          {skills.length > 0 ? (
            skills.map((skill) => (
              <div className="list-item" key={String(skill.id)}>
                <div className="row">
                  <strong>{String(skill.title ?? skill.id)}</strong>
                  <Badge tone="good">{String(skill.status ?? "active")}</Badge>
                </div>
                <div className="tiny">{String(skill.body ?? skill.description ?? "")}</div>
                <div className="tiny">
                  used {Number(skill.useCount ?? 0)} times · last {String(skill.lastUsedAt ?? "never")}
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No active skills" body="Accept a skill candidate to record a skill." />
          )}
        </div>
      </Panel>
      <Panel title="Pending Candidates" span={6}>
        <div className="list">
          {pending.length > 0 ? (
            pending.map((candidate) => (
              <div className="list-item" key={String(candidate.id)}>
                <div className="row">
                  <strong>{String(candidate.title ?? candidate.id)}</strong>
                  <Badge tone="warn">pending</Badge>
                </div>
                <div className="tiny">{String(candidate.body ?? candidate.description ?? "")}</div>
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <button type="button" onClick={() => accept(String(candidate.id))}>
                    Accept
                  </button>
                  <button type="button" onClick={() => reject(String(candidate.id))}>
                    Reject
                  </button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No pending candidates" body="Reflection jobs and explicit suggestions create candidates." />
          )}
        </div>
      </Panel>
      <Panel title="Rejected Candidates" span={12}>
        <div className="list">
          {rejected.length > 0 ? (
            rejected.map((candidate) => (
              <div className="list-item" key={String(candidate.id)}>
                <div className="row">
                  <strong>{String(candidate.title ?? candidate.id)}</strong>
                  <Badge tone="bad">rejected</Badge>
                </div>
                <div className="tiny">{String(candidate.body ?? candidate.description ?? "")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No rejections" body="Rejected candidates accumulate here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function EvalPage(): ReactNode {
  const resource = useResource(() =>
    Promise.all([api.listEvalCases(), api.listAnswerEvaluations(), api.listSessionOutcomes()]),
  );
  const cases = (resource.data?.[0].data ?? []) as Array<Record<string, unknown>>;
  const answers = (resource.data?.[1].data ?? []) as Array<Record<string, unknown>>;
  const outcomes = (resource.data?.[2].data ?? []) as Array<Record<string, unknown>>;
  const [projectId, setProjectId] = useState("");
  const [projectOptions, setProjectOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [question, setQuestion] = useState("");
  const [expected, setExpected] = useState("");

  useEffect(() => {
    api.listProjects().then((response) => {
      setProjectOptions(response.data);
      if (!projectId && response.data[0]?.id) setProjectId(response.data[0].id);
    });
  }, [projectId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question) return;
    await api.addEvalCase({ projectId: projectId || undefined, question, expectedAnswerContains: expected || undefined });
    setQuestion("");
    setExpected("");
    resource.refresh();
  };

  return (
    <PageShell title="Evaluation" subtitle="Eval cases, answer evaluations, and session outcomes">
      <Panel title="Add Eval Case" span={6}>
        <form className="stack" onSubmit={submit}>
          <select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
            <option value="">No project</option>
            {projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <input value={question} onChange={(event) => setQuestion(event.currentTarget.value)} placeholder="what is in handleLogin?" />
          <input value={expected} onChange={(event) => setExpected(event.currentTarget.value)} placeholder="expected substring" />
          <button type="submit">Add case</button>
        </form>
      </Panel>
      <Panel title="Cases" span={6}>
        <div className="list">
          {cases.length > 0 ? (
            cases.map((c) => (
              <div className="list-item" key={String(c.id)}>
                <strong>{String(c.question ?? c.id)}</strong>
                <div className="tiny">expects: {String(c.expectedAnswerContains ?? "—")}</div>
                <div className="tiny">difficulty {String(c.difficulty ?? "standard")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No cases" body="Add a case to start evaluating answers." />
          )}
        </div>
      </Panel>
      <Panel title="Answer Evaluations" span={8}>
        <div className="list">
          {answers.length > 0 ? (
            answers.map((a) => (
              <div className="list-item" key={String(a.id)}>
                <div className="row">
                  <strong>{String(a.sessionId ?? a.id)}</strong>
                  <Badge tone={Number(a.groundedness ?? 0) >= 0.5 ? "good" : "warn"}>
                    grounded {Number(a.groundedness ?? 0).toFixed(2)}
                  </Badge>
                </div>
                <div className="tiny">
                  citation coverage {Number(a.citationCoverage ?? 0).toFixed(2)} · contradiction {Number(a.contradiction ?? 0).toFixed(2)}
                </div>
                <div className="tiny">{String(a.notes ?? "")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No answer evaluations" body="Each ask records a groundedness score here." />
          )}
        </div>
      </Panel>
      <Panel title="Session Outcomes" span={4}>
        <div className="list">
          {outcomes.length > 0 ? (
            outcomes.map((o) => (
              <div className="list-item" key={String(o.id)}>
                <div className="row">
                  <strong>{String(o.outcome ?? "?")}</strong>
                  <Badge tone={o.outcome === "success" ? "good" : o.outcome === "failed" ? "bad" : "warn"}>
                    score {Number(o.score ?? 0).toFixed(2)}
                  </Badge>
                </div>
                <div className="tiny">session {String(o.sessionId ?? "—")}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No outcomes" body="Session outcomes show up as asks complete." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function AgentsPage(): ReactNode {
  const resource = useResource(() => api.listSessions());
  const sessions = (resource.data?.data ?? []) as SessionRecord[];
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);
  const [packs, setPacks] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    if (!sessionId && sessions[0]?.id) setSessionId(sessions[0].id);
  }, [sessionId, sessions]);

  useEffect(() => {
    if (!sessionId) {
      setRuns([]);
      setPacks([]);
      return;
    }
    api.listAgentRuns(sessionId).then((response) => setRuns(response.data));
    api.listContextPacks(sessionId).then((response) => setPacks(response.data));
  }, [sessionId]);

  return (
    <PageShell title="Agents" subtitle="Agent runs and context packs for any session">
      <Panel title="Session" span={12}>
        <select value={sessionId} onChange={(event) => setSessionId(event.currentTarget.value)}>
          {sessions.length > 0 ? sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>) : <option value="">No sessions</option>}
        </select>
      </Panel>
      <Panel title="Agent Runs" span={8}>
        <div className="list">
          {runs.length > 0 ? (
            runs.map((run) => (
              <a className="list-item" href={`/agents/runs/${String(run.id)}`} key={String(run.id)}>
                <div className="row">
                  <strong>{String(run.agent ?? "?")}</strong>
                  <Badge tone={run.status === "completed" ? "good" : run.status === "failed" ? "bad" : "neutral"}>
                    {String(run.status ?? "?")}
                  </Badge>
                </div>
                <div className="tiny">
                  role {String(run.modelRole ?? "?")} · {String(run.startedAt ?? "")}
                </div>
              </a>
            ))
          ) : (
            <EmptyState title="No runs" body="Asks and handoffs create agent runs." />
          )}
        </div>
      </Panel>
      <Panel title="Context Packs" span={4}>
        <div className="list">
          {packs.length > 0 ? (
            packs.map((pack) => (
              <div className="list-item" key={String(pack.id)}>
                <div className="row">
                  <strong>{String(pack.reason ?? "pack")}</strong>
                  <Badge>{Number(pack.usedTokens ?? 0)} tokens</Badge>
                </div>
                <div className="tiny">budget {Number(pack.budgetTokens ?? 0)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No packs" body="Context packs appear after retrieval." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function AgentRunDetailPage(): ReactNode {
  const { runId = "" } = useParams();
  const resource = useResource(() => api.getAgentRun(runId), [runId]);
  const detail = resource.data?.data as
    | { run: Record<string, unknown>; messages: Array<Record<string, unknown>> }
    | undefined;
  if (!detail) {
    return (
      <PageShell title="Agent Run" subtitle={runId}>
        <Panel title="Loading" span={12}>
          <EmptyState title="Loading agent run" body="Fetching the run trace." />
        </Panel>
      </PageShell>
    );
  }
  return (
    <PageShell title="Agent Run" subtitle={String(detail.run.agent ?? runId)}>
      <Panel title="Run Summary" span={6}>
        <KeyValueList
          items={[
            ["Agent", String(detail.run.agent ?? "?")],
            ["Status", String(detail.run.status ?? "?")],
            ["Model Role", String(detail.run.modelRole ?? "?")],
            ["Session", String(detail.run.sessionId ?? "—")],
            ["Task", String(detail.run.taskId ?? "—")],
            ["Started", String(detail.run.startedAt ?? "")],
            ["Finished", String(detail.run.finishedAt ?? "—")],
          ]}
        />
      </Panel>
      <Panel title="Output" span={6}>
        <pre>{JSON.stringify(detail.run.output ?? {}, null, 2)}</pre>
      </Panel>
      <Panel title="Input" span={6}>
        <pre>{JSON.stringify(detail.run.input ?? {}, null, 2)}</pre>
      </Panel>
      <Panel title="Messages" span={6}>
        <div className="list">
          {detail.messages.length > 0 ? (
            detail.messages.map((m) => (
              <div className="list-item" key={String(m.id)}>
                <div className="row">
                  <strong>{String(m.role ?? "msg")}</strong>
                  <span className="tiny">{String(m.createdAt ?? "")}</span>
                </div>
                <pre>{String(m.content ?? "").slice(0, 400)}</pre>
              </div>
            ))
          ) : (
            <EmptyState title="No messages" body="Agent messages will appear here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function McpPage(): ReactNode {
  const resource = useResource(() => Promise.all([api.getMcpOverview(), api.getMcpCalls()]));
  const overview = resource.data?.[0].data ?? [];
  const calls = resource.data?.[1].data ?? [];
  return (
    <PageShell title="MCP" subtitle="Safe tool gateway">
      <Panel title="Overview" span={4}>
        <div className="list">
          {overview.length > 0 ? overview.map((item: any) => <div className="list-item" key={String(item.id ?? item.toolName)}>{String(item.toolName ?? item.name ?? item.id)}</div>) : <EmptyState title="No overview yet" body="MCP tool state will appear here." />}
        </div>
      </Panel>
      <Panel title="Calls" span={8}>
        <div className="list">
          {calls.length > 0 ? (
            calls.map((call: any) => (
              <a className="list-item" href={`/mcp/calls/${call.id}`} key={call.id}>
                <div className="row">
                  <strong>{call.toolName}</strong>
                  <Badge tone={call.blocked ? "bad" : "good"}>{call.blocked ? "blocked" : "allowed"}</Badge>
                </div>
                <div className="tiny">{call.inputJson}</div>
              </a>
            ))
          ) : (
            <EmptyState title="No calls yet" body="MCP calls will be logged here." />
          )}
        </div>
      </Panel>
    </PageShell>
  );
}

function McpCallDetailPage(): ReactNode {
  const { callId = "" } = useParams();
  const resource = useResource(() => api.getMcpCall(callId), [callId]);
  const call = resource.data?.data ?? null;
  if (!call) {
    return (
      <PageShell title="MCP call" subtitle={callId}>
        <Panel title="Missing call" span={12}>
          <EmptyState title="MCP call not found" body={`No MCP call found for ${callId}.`} />
        </Panel>
      </PageShell>
    );
  }
  return (
    <PageShell title={`MCP ${String((call as any).toolName ?? "call")}`} subtitle={String((call as any).blocked ? "blocked" : "allowed")}>
      <Panel title="Call Summary" span={6}>
        <KeyValueList items={[["Tool", String((call as any).toolName ?? "unknown")], ["Blocked", String(Boolean((call as any).blocked))], ["Created", String((call as any).createdAt ?? "")]]} />
      </Panel>
      <Panel title="Input" span={6}>
        <pre>{String((call as any).inputJson ?? "")}</pre>
      </Panel>
      <Panel title="Output" span={12}>
        <pre>{String((call as any).outputJson ?? "No output recorded.")}</pre>
      </Panel>
    </PageShell>
  );
}

function SettingsPage(): ReactNode {
  const resource = useResource(() => api.getSettings());
  const settings = resource.data?.data ?? null;
  return (
    <PageShell title="Settings" subtitle="Local runtime configuration">
      <Panel title="Settings Snapshot" span={12}>
        {settings ? <pre>{JSON.stringify(settings, null, 2)}</pre> : <EmptyState title="No settings yet" body="Configuration values will show up here once loaded." />}
      </Panel>
    </PageShell>
  );
}

export {
  AgentRunDetailPage,
  AgentsPage,
  AskPage,
  ChecksPage,
  DashboardPage,
  EvalPage,
  HandoffPage,
  MemoryPage,
  McpCallDetailPage,
  McpPage,
  ModelsPage,
  PlannerPage,
  ProjectDetailPage,
  ProjectsPage,
  RetrievalPage,
  RetrievalQueryDetailPage,
  ReviewDetailPage,
  ReviewsPage,
  SessionDetailPage,
  SessionsPage,
  SettingsPage,
  SkillsPage,
  TaskDetailPage,
  TasksPage,
};
