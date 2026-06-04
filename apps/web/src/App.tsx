import { useEffect, useMemo, type ReactNode } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useWorkbenchStore } from "./store.ts";
import {
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
  PromptLabPage,
  PromptDetailPage,
  PromptsPage,
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
} from "./pages.tsx";
import type { EventEnvelope } from "../../../packages/shared/src/index.ts";

const navItems = [
  ["/dashboard", "Dashboard"],
  ["/projects", "Projects"],
  ["/sessions", "Sessions"],
  ["/tasks", "Tasks"],
  ["/agents", "Agents"],
  ["/ask", "Ask"],
  ["/prompts", "Prompts"],
  ["/prompt-lab", "Prompt Lab"],
  ["/planner", "Planner"],
  ["/handoff", "Handoff"],
  ["/checks", "Checks"],
  ["/memory", "Memory"],
  ["/retrieval", "Retrieval"],
  ["/skills", "Skills"],
  ["/eval", "Eval"],
  ["/reviews", "Reviews"],
  ["/models", "Models"],
  ["/mcp", "MCP"],
  ["/settings", "Settings"],
] as const;

const commandItems = [
  ["/dashboard", "Dashboard", "Overview and live status"],
  ["/projects", "Projects", "Indexed repos and health"],
  ["/sessions", "Sessions", "Traceable task history"],
  ["/tasks", "Tasks", "Task graph and lifecycle"],
  ["/agents", "Agents", "Agent runs and context packs"],
  ["/ask", "Ask", "Retrieval-backed question answering"],
  ["/prompts", "Prompts", "Compiled prompt traces and replay"],
  ["/prompt-lab", "Prompt Lab", "Compare compiled prompts across profiles"],
  ["/planner", "Planner", "Task graph generation"],
  ["/handoff", "Handoff", "Target-specific prompt export"],
  ["/checks", "Checks", "Allowlisted validation runs"],
  ["/memory", "Memory", "Candidates, entries, and project rules"],
  ["/retrieval", "Retrieval", "Search, recent queries, and misses"],
  ["/skills", "Skills", "Promoted skills and pending candidates"],
  ["/eval", "Eval", "Eval cases, answer evaluations, and outcomes"],
  ["/reviews", "Reviews", "Review summaries and risk checks"],
  ["/models", "Models", "Local model routing"],
  ["/mcp", "MCP", "Safe tool gateway"],
  ["/settings", "Settings", "Local runtime configuration"],
] as const;

function routeTitle(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  const entry = navItems.find(([path]) => pathname === path || pathname.startsWith(`${path}/`));
  const fallback = pathname.replaceAll("/", " / ").replaceAll("-", " ").trim();
  return entry?.[1] ?? (fallback || "AI Workbench");
}

function LiveEventDrawer(): ReactNode {
  const events = useWorkbenchStore((state) => state.liveEvents);
  return (
    <aside className="drawer">
      <div className="brand" style={{ marginBottom: "0.75rem" }}>
        <div className="brand-mark">AI</div>
        <div>
          <div className="brand-title">Recent Trace</div>
          <div className="brand-subtitle">Live SSE stream</div>
        </div>
      </div>
      <div className="event-log">
        {events.length > 0 ? (
          events.slice(0, 16).map((event: EventEnvelope) => (
            <div className="event" key={event.id}>
              <div className="row">
                <strong>{event.type}</strong>
                <span className="ts">{event.ts}</span>
              </div>
              <div className="tiny">{JSON.stringify(event.payload ?? {})}</div>
            </div>
          ))
        ) : (
          <div className="tiny">No events yet.</div>
        )}
      </div>
    </aside>
  );
}

function CommandPalette(): ReactNode {
  const open = useWorkbenchStore((state) => state.commandPaletteOpen);
  const close = useWorkbenchStore((state) => state.closeCommandPalette);
  const navigate = useNavigate();
  return (
    <div
      className="command-palette"
      data-open={open ? "true" : "false"}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div className="sheet">
        <div className="row">
          <strong>Command Palette</strong>
          <button type="button" onClick={close}>
            Close
          </button>
        </div>
        <div className="items">
          {commandItems.map(([href, label, description]) => (
            <button
              key={href}
              type="button"
              className="item"
              onClick={() => {
                navigate(href);
                close();
              }}
            >
              <strong>{label}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const liveStatus = useWorkbenchStore((state) => state.liveStatus);
  const selectedProjectId = useWorkbenchStore((state) => state.selectedProjectId);
  const toggleCommandPalette = useWorkbenchStore((state) => state.toggleCommandPalette);
  const openCommandPalette = useWorkbenchStore((state) => state.openCommandPalette);
  const closeCommandPalette = useWorkbenchStore((state) => state.closeCommandPalette);
  const navigate = useNavigate();
  const title = useMemo(() => routeTitle(location.pathname), [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
      }
      if (event.key === "Escape") {
        closeCommandPalette();
      }
      if (event.key === "r" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeCommandPalette, toggleCommandPalette]);

  useEffect(() => {
    const source = new EventSource("/events/stream");
    useWorkbenchStore.getState().setLiveStatus("connecting");
    source.onopen = () => useWorkbenchStore.getState().setLiveStatus("ready");
    source.onmessage = (event) => {
      try {
        useWorkbenchStore.getState().pushEvent(JSON.parse(event.data) as EventEnvelope);
      } catch {
        useWorkbenchStore.getState().setLiveStatus("error");
      }
    };
    source.onerror = () => useWorkbenchStore.getState().setLiveStatus("error");
    return () => source.close();
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <div className="brand-title">AI Workbench</div>
            <div className="brand-subtitle">Local-first engineering cockpit</div>
          </div>
        </div>
        <nav className="nav">
          {navItems.map(([href, label]) => (
            <NavLink
              key={href}
              to={href}
              end={href === "/dashboard"}
              className={({ isActive }: { isActive: boolean }) => (isActive ? "active" : undefined)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-panel">
          <h3>Shell</h3>
          <div className="stack">
            <div className="status-pill">
              <span className="status-dot" />
              <span>{liveStatus}</span>
            </div>
            <div className="tiny">{selectedProjectId ? `Selected project ${selectedProjectId}` : "No project selected"}</div>
            <div className="tiny">`Cmd/Ctrl + K` opens the command palette. `Esc` closes it.</div>
            <button type="button" onClick={() => navigate("/dashboard")}>
              {title}
            </button>
            <button type="button" onClick={openCommandPalette}>
              Open Command Palette
            </button>
          </div>
        </div>
      </aside>
      <main className="content">{children}</main>
      <LiveEventDrawer />
      <CommandPalette />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/runs/:runId" element={<AgentRunDetailPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/prompt-lab" element={<PromptLabPage />} />
          <Route path="/prompts/:promptId" element={<PromptDetailPage />} />
          <Route path="/planner" element={<PlannerPage />} />
          <Route path="/handoff" element={<HandoffPage />} />
          <Route path="/checks" element={<ChecksPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/retrieval" element={<RetrievalPage />} />
          <Route path="/retrieval/queries/:queryId" element={<RetrievalQueryDetailPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/eval" element={<EvalPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/reviews/:reviewId" element={<ReviewDetailPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/mcp/calls/:callId" element={<McpCallDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
