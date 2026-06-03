import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

test("serves the split web shell and planner data routes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-web-"));
  const repo = join(workspace, "sample-repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "src", "auth.ts"),
    [
      "export function handleLogin() {",
      "  return { route: '/api/auth/login', storage: 'local sqlite' };",
      "}",
    ].join("\n"),
  );

  const apiPort = 4277;
  const webPort = 3008;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const child = spawn(process.argv[0], ["--experimental-strip-types", "/home/namik/Documents/code/ai/cli/ai/src/main.ts", "web", "--port", String(webPort), "--api-port", String(apiPort)], {
    cwd: "/home/namik/Documents/code/ai",
    env: {
      ...process.env,
      AI_DATABASE_PATH: join(workspace, "ai.db"),
      AI_RUNTIME_DIR: join(workspace, "runtime"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr!.on("data", (chunk) => logs.push(String(chunk)));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web process did not start: ${logs.join("")}`)), 10000);
    const check = () => {
      const joined = logs.join("");
      if (joined.includes("AI Workbench api listening at") && joined.includes("AI Workbench web listening at")) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (child.exitCode != null) {
        clearTimeout(timeout);
        reject(new Error(`web process exited early: ${joined}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });

  try {
    const created = await fetch(`${apiUrl}/projects`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ path: repo, name: "sample-repo" }),
    });
    assert.equal(created.ok, true);
    const createdJson = (await created.json()) as { status: string; data: { id: string } };
    assert.equal(createdJson.status, "ok");

    const indexResponse = await fetch(`${apiUrl}/projects/${createdJson.data.id}/index`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(indexResponse.ok, true);

    const plannerDataResponse = await fetch(`${apiUrl}/planner`, {
      headers: { accept: "application/json" },
    });
    assert.equal(plannerDataResponse.ok, true);
    const plannerData = (await plannerDataResponse.json()) as {
      status: string;
      data: { tasks: Array<{ title: string }>; projects: Array<{ id: string }> };
    };
    assert.equal(plannerData.status, "ok");
    assert.ok(plannerData.data.projects.length >= 1);
    assert.ok(plannerData.data.tasks.length >= 1);

    const reviewResponse = await fetch(`${apiUrl}/reviews`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        project: createdJson.data.id,
        title: "review detail smoke",
        plannedFiles: ["src/auth.ts"],
        editedFiles: ["src/auth.ts", "src/session.ts"],
        checks: ["typecheck"],
      }),
    });
    assert.equal(reviewResponse.ok, true);
    const reviewJson = (await reviewResponse.json()) as { status: string; data: { id: string } };
    assert.equal(reviewJson.status, "ok");

    const shellResponse = await fetch(`${webUrl}/planner`);
    assert.equal(shellResponse.ok, true);
    const shellHtml = await shellResponse.text();
    assert.ok(shellHtml.includes("client.js"));
    assert.ok(shellHtml.includes("Loading /planner..."));

    const projectResponse = await fetch(`${webUrl}/projects/${createdJson.data.id}`);
    assert.equal(projectResponse.ok, true);
    const projectHtml = await projectResponse.text();
    assert.ok(projectHtml.includes("client.js"));
    assert.ok(projectHtml.includes("Loading /projects/"));

    const reviewDetailResponse = await fetch(`${webUrl}/reviews/${reviewJson.data.id}`);
    assert.equal(reviewDetailResponse.ok, true);
    const reviewDetailHtml = await reviewDetailResponse.text();
    assert.ok(reviewDetailHtml.includes("client.js"));
    assert.ok(reviewDetailHtml.includes("Loading /reviews/"));
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
