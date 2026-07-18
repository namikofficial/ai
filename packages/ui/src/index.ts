import type { ProjectSummary, SessionRecord, TaskRecord } from "../../shared/src/index.ts";

export interface ShellOptions {
  title: string;
  route: string;
  activeProjectId?: string | null;
  projects?: ProjectSummary[];
  sessionCount?: number;
  activeSessionCount?: number;
  liveStatus?: string;
  contentHtml: string;
  rightPanelHtml?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function linkList(projects: ProjectSummary[] = [], activeProjectId?: string | null): string {
  if (projects.length === 0) {
    return `<p class="muted">No projects indexed yet.</p>`;
  }
  return projects
    .map(
      (project) => `
        <option value="${escapeHtml(project.id)}" ${project.id === activeProjectId ? "selected" : ""}>
          ${escapeHtml(project.name)} · ${escapeHtml(project.language ?? "unknown")}
        </option>
      `
    )
    .join("");
}

export function renderShell(options: ShellOptions): string {
  const projects = options.projects ?? [];
  const projectSelect = linkList(projects, options.activeProjectId ?? null);
  const liveStatus = escapeHtml(options.liveStatus ?? "live");
  const activeCount = options.activeSessionCount ?? 0;
  const totalCount = options.sessionCount ?? 0;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)} · AI Workbench</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081018;
        --panel: rgba(15, 23, 42, 0.92);
        --panel-soft: rgba(15, 23, 42, 0.72);
        --line: rgba(148, 163, 184, 0.18);
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #38bdf8;
        --accent-strong: #0ea5e9;
        --good: #34d399;
        --warn: #f59e0b;
        --bad: #fb7185;
        --shadow: 0 24px 80px rgba(2, 6, 23, 0.45);
        --radius: 18px;
      }

      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(56, 189, 248, 0.18), transparent 24%),
          radial-gradient(circle at bottom right, rgba(14, 165, 233, 0.12), transparent 20%),
          linear-gradient(180deg, #07111c 0%, #0b1220 40%, #050814 100%);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      a { color: inherit; text-decoration: none; }
      button, select, input, textarea {
        font: inherit;
        color: inherit;
        background: rgba(15, 23, 42, 0.85);
        border: 1px solid var(--line);
        border-radius: 12px;
      }
      button, select { padding: 0.7rem 0.9rem; cursor: pointer; }
      input, textarea { padding: 0.8rem 0.95rem; width: 100%; }
      textarea { min-height: 9rem; resize: vertical; }

      .app {
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr) 340px;
        min-height: 100vh;
      }

      .sidebar {
        position: sticky;
        top: 0;
        min-height: 100vh;
        padding: 1.1rem;
        border-right: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(8,16,24,0.92), rgba(8,16,24,0.72));
        backdrop-filter: blur(16px);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.4rem 0.2rem 1rem;
        margin-bottom: 1rem;
      }

      .brand-mark {
        display: grid;
        place-items: center;
        width: 2.3rem;
        height: 2.3rem;
        border-radius: 14px;
        background: linear-gradient(135deg, rgba(56,189,248,0.95), rgba(14,165,233,0.45));
        color: #04111e;
        font-weight: 800;
      }

      .brand-title { font-size: 1rem; font-weight: 700; }
      .brand-subtitle { font-size: 0.8rem; color: var(--muted); }

      .nav {
        display: grid;
        gap: 0.35rem;
        margin: 1rem 0 1.4rem;
      }

      .nav a {
        padding: 0.7rem 0.8rem;
        border-radius: 12px;
        color: var(--muted);
        border: 1px solid transparent;
      }

      .nav a[data-active="true"] {
        color: var(--text);
        background: rgba(56, 189, 248, 0.12);
        border-color: rgba(56, 189, 248, 0.24);
      }

      .sidebar-panel {
        padding: 0.9rem;
        margin-top: 1rem;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel-soft);
        box-shadow: var(--shadow);
      }

      .sidebar-panel h3, .panel h3, .panel h2 {
        margin: 0 0 0.7rem;
        font-size: 0.95rem;
      }

      .tiny { color: var(--muted); font-size: 0.84rem; line-height: 1.45; }

      .content {
        min-width: 0;
        padding: 1.1rem 1.2rem 4rem;
      }

      .topbar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 0.8rem;
        align-items: center;
        margin-bottom: 1rem;
      }

      .topbar .title {
        font-size: 1.45rem;
        font-weight: 760;
        letter-spacing: -0.03em;
      }

      .topbar .meta {
        color: var(--muted);
        font-size: 0.9rem;
        margin-top: 0.25rem;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.55rem 0.8rem;
        border-radius: 999px;
        border: 1px solid rgba(52, 211, 153, 0.28);
        background: rgba(16, 185, 129, 0.1);
        color: #bbf7d0;
        font-size: 0.85rem;
        white-space: nowrap;
      }

      .status-dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 999px;
        background: var(--good);
        box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.14);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 1rem;
      }

      .panel {
        grid-column: span 12;
        padding: 1rem;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .panel[data-span="6"] { grid-column: span 6; }
      .panel[data-span="4"] { grid-column: span 4; }
      .panel[data-span="8"] { grid-column: span 8; }

      .kpi {
        display: grid;
        gap: 0.2rem;
      }

      .kpi .value {
        font-size: 2rem;
        font-weight: 800;
        letter-spacing: -0.04em;
      }

      .kpi .label {
        color: var(--muted);
        font-size: 0.84rem;
      }

      .list {
        display: grid;
        gap: 0.7rem;
      }

      .list-item {
        padding: 0.8rem 0.9rem;
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.52);
        border: 1px solid rgba(148, 163, 184, 0.12);
      }

      .list-item .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.35rem 0.6rem;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.12);
        color: #bae6fd;
        font-size: 0.78rem;
      }

      .badge[data-tone="good"] { background: rgba(52, 211, 153, 0.12); color: #bbf7d0; }
      .badge[data-tone="warn"] { background: rgba(245, 158, 11, 0.12); color: #fde68a; }
      .badge[data-tone="bad"] { background: rgba(251, 113, 133, 0.12); color: #fecdd3; }

      .drawer {
        position: sticky;
        top: 0;
        min-height: 100vh;
        padding: 1.1rem;
        border-left: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(8,16,24,0.84), rgba(8,16,24,0.74));
        backdrop-filter: blur(16px);
      }

      .drawer .panel + .panel { margin-top: 1rem; }

      .event-log {
        display: grid;
        gap: 0.45rem;
        max-height: 58vh;
        overflow: auto;
      }

      .event {
        padding: 0.55rem 0.7rem;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.52);
        border: 1px solid rgba(148, 163, 184, 0.1);
        font-size: 0.8rem;
      }

      .event .type { color: #bae6fd; font-weight: 700; }
      .event .ts { color: var(--muted); font-size: 0.72rem; margin-left: 0.35rem; }

      .stack {
        display: grid;
        gap: 0.65rem;
      }

      .stack > * + * { margin-top: 0; }

      .content pre, .panel pre {
        margin: 0;
        padding: 0.9rem;
        border-radius: 14px;
        overflow: auto;
        background: rgba(2, 6, 23, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.12);
      }

      .command-palette {
        position: fixed;
        inset: 0;
        display: none;
        place-items: center;
        background: rgba(2, 6, 23, 0.66);
        backdrop-filter: blur(14px);
        z-index: 20;
      }

      .command-palette[data-open="true"] { display: grid; }
      .command-palette .sheet {
        width: min(720px, calc(100vw - 2rem));
        padding: 1rem;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: rgba(8, 16, 24, 0.96);
        box-shadow: var(--shadow);
      }

      .command-palette .sheet input {
        margin-bottom: 0.75rem;
      }

      .command-palette .items {
        display: grid;
        gap: 0.35rem;
        max-height: 55vh;
        overflow: auto;
      }

      .command-palette .item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.7rem 0.85rem;
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.52);
        border: 1px solid rgba(148, 163, 184, 0.1);
      }

      .command-palette .item small { color: var(--muted); }

      @media (max-width: 1200px) {
        .app { grid-template-columns: 240px minmax(0, 1fr); }
        .drawer { display: none; }
      }

      @media (max-width: 920px) {
        .app { grid-template-columns: 1fr; }
        .sidebar { position: relative; min-height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
        .content { padding-inline: 0.85rem; }
        .topbar { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">AI</div>
          <div>
            <div class="brand-title">AI Workbench</div>
            <div class="brand-subtitle">Local-first engineering cockpit</div>
          </div>
        </div>
        <nav class="nav">
          <a href="/dashboard" data-active="${options.route === "/dashboard"}">Dashboard</a>
          <a href="/projects" data-active="${options.route.startsWith("/projects")}">Projects</a>
          <a href="/sessions" data-active="${options.route.startsWith("/sessions")}">Sessions</a>
          <a href="/tasks" data-active="${options.route.startsWith("/tasks")}">Tasks</a>
          <a href="/ask" data-active="${options.route === "/ask"}">Ask</a>
          <a href="/research" data-active="${options.route === "/research"}">Research</a>
          <a href="/planner" data-active="${options.route === "/planner"}">Planner</a>
          <a href="/handoff" data-active="${options.route === "/handoff"}">Handoff</a>
          <a href="/checks" data-active="${options.route === "/checks"}">Checks</a>
          <a href="/memory" data-active="${options.route === "/memory"}">Memory</a>
          <a href="/reviews" data-active="${options.route === "/reviews"}">Reviews</a>
          <a href="/retrieval" data-active="${options.route === "/retrieval"}">Retrieval</a>
          <a href="/models" data-active="${options.route === "/models"}">Models</a>
          <a href="/mcp" data-active="${options.route === "/mcp"}">MCP</a>
          <a href="/settings" data-active="${options.route === "/settings"}">Settings</a>
        </nav>

        <div class="sidebar-panel">
          <h3>Project Selector</h3>
          <select id="project-select">${projectSelect}</select>
          <p class="tiny">&#96;Cmd/Ctrl + K&#96; opens the command palette. &#96;Esc&#96; closes it.</p>
        </div>

        <div class="sidebar-panel">
          <h3>Live System</h3>
          <div class="stack">
            <div class="status-pill"><span class="status-dot"></span>${liveStatus}</div>
            <div class="tiny">${activeCount} active sessions · ${totalCount} total sessions</div>
          </div>
        </div>
      </aside>

      <main class="content">
        <div class="topbar">
          <div>
            <div class="title">${escapeHtml(options.title)}</div>
            <div class="meta">Local SQLite store · SSE event stream · deterministic retrieval</div>
          </div>
          <button data-action="refresh">Refresh</button>
          <button data-action="palette">Command Palette</button>
        </div>
        <div class="grid">
          ${options.contentHtml}
        </div>
      </main>

      <aside class="drawer">
        <div class="panel">
          <h3>Trace Drawer</h3>
          <div class="tiny">Recent session events stream here. This is wired to SSE so the latest index and ask events stay visible while you work.</div>
        </div>
        ${options.rightPanelHtml ?? ""}
      </aside>
    </div>

    <div class="command-palette" id="command-palette" data-open="false" aria-hidden="true">
      <div class="sheet">
        <input id="palette-input" placeholder="Jump to a page or action..." />
        <div class="items" id="palette-items">
          ${renderPaletteItems()}
        </div>
      </div>
    </div>

    <script>
      (function () {
        const palette = document.getElementById("command-palette");
        const paletteInput = document.getElementById("palette-input");
        const paletteItems = document.getElementById("palette-items");
        const refreshButton = document.querySelector('[data-action="refresh"]');
        const paletteButton = document.querySelector('[data-action="palette"]');
        const projectSelect = document.getElementById("project-select");
        const eventLog = document.querySelector("[data-event-log]");

        const entries = Array.from(paletteItems.querySelectorAll(".item"));
        function openPalette() {
          palette.dataset.open = "true";
          palette.setAttribute("aria-hidden", "false");
          paletteInput.value = "";
          filterPalette();
          paletteInput.focus();
        }
        function closePalette() {
          palette.dataset.open = "false";
          palette.setAttribute("aria-hidden", "true");
        }
        function filterPalette() {
          const query = paletteInput.value.trim().toLowerCase();
          entries.forEach((entry) => {
            const text = entry.textContent.toLowerCase();
            entry.style.display = text.includes(query) ? "" : "none";
          });
        }

        paletteButton?.addEventListener("click", openPalette);
        refreshButton?.addEventListener("click", () => location.reload());
        paletteInput?.addEventListener("input", filterPalette);
        paletteInput?.addEventListener("keydown", (event) => {
          if (event.key === "Escape") closePalette();
          if (event.key === "Enter") {
            const firstVisible = entries.find((entry) => entry.style.display !== "none");
            if (firstVisible) {
              location.href = firstVisible.dataset.href;
            }
          }
        });

        palette.addEventListener("click", (event) => {
          if (event.target === palette) closePalette();
        });
        paletteItems.addEventListener("click", (event) => {
          const item = event.target.closest(".item");
          if (!item) return;
          location.href = item.dataset.href;
        });

        document.addEventListener("keydown", (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            openPalette();
          }
          if (event.key === "Escape") closePalette();
          if (event.key === "g" && !event.metaKey && !event.ctrlKey) {
            const nextKeyHandler = (nextEvent) => {
              const key = nextEvent.key.toLowerCase();
              const target = {
                d: "/dashboard",
                p: "/projects",
                s: "/sessions",
                a: "/ask",
                r: "/research",
                m: "/memory",
                c: "/checks",
              }[key];
              if (target) {
                location.href = target;
              }
              document.removeEventListener("keydown", nextKeyHandler, true);
            };
            document.addEventListener("keydown", nextKeyHandler, true);
          }
        });

        projectSelect?.addEventListener("change", () => {
          if (projectSelect.value) {
            location.href = "/projects/" + encodeURIComponent(projectSelect.value);
          }
        });

        try {
          const source = new EventSource("/events/stream");
          source.addEventListener("message", (event) => {
            if (!eventLog) return;
            const data = JSON.parse(event.data);
            const item = document.createElement("div");
            item.className = "event";
            item.innerHTML = '<span class="type">' + data.type + '</span> <span class="ts">' + data.ts + '</span><div>' + (data.projectId || data.sessionId || "system") + '</div>';
            eventLog.prepend(item);
          });
        } catch (error) {
          console.warn("SSE unavailable", error);
        }
      }());
    </script>
  </body>
</html>`;
}

function renderPaletteItems(): string {
  const items = [
    ["/dashboard", "Dashboard", "Overview and live status"],
    ["/projects", "Projects", "Indexed repos and health"],
    ["/sessions", "Sessions", "Traceable task history"],
    ["/tasks", "Tasks", "Task graph and lifecycle"],
    ["/ask", "Ask", "Retrieval-backed question answering"],
    ["/research", "Research", "Topic exploration workspace"],
    ["/planner", "Planner", "Task graph generation"],
    ["/handoff", "Handoff", "Target-specific prompt export"],
    ["/checks", "Checks", "Allowlisted validation runs"],
    ["/memory", "Memory", "Lessons and rules"],
    ["/reviews", "Reviews", "Review summaries and risk checks"],
    ["/retrieval", "Retrieval", "Search and rerank view"],
    ["/models", "Models", "Local model routing"],
    ["/mcp", "MCP", "Safe tool gateway"],
    ["/settings", "Settings", "Local runtime configuration"],
  ];
  return items
    .map(
      ([href, label, description]) =>
        `<div class="item" data-href="${href}"><strong>${label}</strong><small>${description}</small></div>`
    )
    .join("");
}

export function renderCard(title: string, bodyHtml: string, span: 12 | 8 | 6 | 4 = 12): string {
  return `<section class="panel" data-span="${span}"><h3>${escapeHtml(title)}</h3>${bodyHtml}</section>`;
}

export function renderKeyValueList(items: Array<[string, string]>): string {
  return `<div class="list">${items
    .map(
      ([label, value]) =>
        `<div class="list-item"><div class="tiny">${escapeHtml(label)}</div><div>${escapeHtml(value)}</div></div>`
    )
    .join("")}</div>`;
}

export function renderSessionItem(session: SessionRecord): string {
  return `<div class="list-item">
    <div class="row">
      <div>
        <div><strong>${escapeHtml(session.title)}</strong></div>
        <div class="tiny">${escapeHtml(session.userGoal)}</div>
      </div>
      <span class="badge">${escapeHtml(session.status)}</span>
    </div>
    <div class="tiny">${escapeHtml(session.startedAt)}</div>
  </div>`;
}

export function renderTaskItem(task: TaskRecord): string {
  return `<div class="list-item">
    <div class="row">
      <div>
        <div><strong>${escapeHtml(task.title)}</strong></div>
        <div class="tiny">${escapeHtml(task.type)} · ${escapeHtml(task.risk)} · session ${escapeHtml(task.sessionId)}</div>
      </div>
      <span class="badge">${escapeHtml(task.status)}</span>
    </div>
    <div class="tiny">Priority ${task.priority}</div>
  </div>`;
}

export function renderProjectItem(project: ProjectSummary): string {
  return `<div class="list-item">
    <div class="row">
      <div>
        <div><strong>${escapeHtml(project.name)}</strong></div>
        <div class="tiny">${escapeHtml(project.path)}</div>
      </div>
      <span class="badge">${escapeHtml(project.status)}</span>
    </div>
    <div class="tiny">${escapeHtml(project.language ?? "unknown")} · ${escapeHtml(project.framework ?? "unknown")} · ${project.fileCount} files · ${project.chunkCount} chunks</div>
  </div>`;
}

export function renderEventFeed(
  events: Array<{
    type: string;
    ts: string;
    sessionId: string | null;
    projectId: string | null;
    payload: Record<string, unknown>;
  }>
): string {
  return `<div class="event-log" data-event-log>${events
    .slice(-20)
    .reverse()
    .map(
      (event) =>
        `<div class="event"><span class="type">${escapeHtml(event.type)}</span> <span class="ts">${escapeHtml(event.ts)}</span><div>${escapeHtml(
          event.projectId ?? event.sessionId ?? "system"
        )}</div></div>`
    )
    .join("")}</div>`;
}

export function renderEmptyState(title: string, description: string): string {
  return `<div class="list-item"><strong>${escapeHtml(title)}</strong><div class="tiny">${escapeHtml(description)}</div></div>`;
}
