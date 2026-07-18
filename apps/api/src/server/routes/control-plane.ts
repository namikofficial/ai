import type { Router } from "express";
import { resolveActiveContext, writeActiveContextCache } from "../../../../../packages/active-context/src/index.ts";
import type { createStore } from "../../../../../packages/db/src/store.ts";
import { diffProjectManifests, refreshRegistryCache } from "../../../../../packages/project-registry/src/index.ts";
import {
  buildProjectStatus,
  compactProjectStatus,
  writeProjectStatusCache,
} from "../../../../../packages/project-status/src/index.ts";
import type { EventEnvelope } from "../../../../../packages/shared/src/index.ts";
import { createEvent } from "../../../../../packages/shared/src/index.ts";
import { asyncRoute, readJsonBody } from "../http.ts";
import { json, sendJson } from "../response.ts";

type Store = ReturnType<typeof createStore>;

export function registerControlPlaneRoutes(
  router: Router,
  deps: { store: Store; publish: (event: EventEnvelope) => void; cachePath?: string }
) {
  const publish = (event: EventEnvelope): void => {
    deps.store.appendEvent(event);
    deps.publish(event);
  };

  router.get("/registry", (_req, res) => {
    sendJson(
      res,
      json("ok", {
        manifests: deps.store.projectRegistry.listManifests(),
        selection: deps.store.projectRegistry.getSelection(),
      })
    );
  });

  router.get("/registry/export", (_req, res) => {
    sendJson(
      res,
      json("ok", {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        manifests: deps.store.projectRegistry.listManifests(),
      })
    );
  });

  router.post(
    "/registry/cache/refresh",
    asyncRoute(async (_req, res) => {
      const cache = await refreshRegistryCache(deps.store.projectRegistry, deps.cachePath);
      sendJson(res, json("ok", cache));
    })
  );

  router.get("/projects/:projectId/manifest", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    sendJson(res, json("ok", deps.store.projectRegistry.getManifest(projectId)));
  });

  router.get("/projects/:projectId/manifest/proposals", (req, res) => {
    const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
    const status = String(req.query.status ?? "pending") as "pending" | "approved" | "rejected";
    sendJson(res, json("ok", deps.store.projectRegistry.listProposals(projectId, status)));
  });

  router.post(
    "/projects/:projectId/manifest/proposals",
    asyncRoute(async (req, res) => {
      const projectId = decodeURIComponent(String(req.params.projectId ?? ""));
      const body = (await readJsonBody(req)) as { manifest?: unknown; sourceRef?: string | null };
      if (!body.manifest) {
        sendJson(res, json("error", undefined, { message: "manifest is required" }), 400);
        return;
      }
      const proposal = deps.store.projectRegistry.proposeManifest(projectId, body.manifest, body.sourceRef ?? null);
      publish(createEvent("project.manifest_proposed", { proposalId: proposal.id }, { projectId, agent: "registry" }));
      sendJson(
        res,
        json("ok", {
          proposal,
          diff: diffProjectManifests(deps.store.projectRegistry.getManifest(projectId), proposal.manifest),
        }),
        201
      );
    })
  );

  router.post(
    "/registry/proposals/:proposalId/:resolution",
    asyncRoute(async (req, res) => {
      const proposalId = decodeURIComponent(String(req.params.proposalId ?? ""));
      const resolution = String(req.params.resolution ?? "");
      if (resolution !== "approve" && resolution !== "reject") {
        sendJson(res, json("error", undefined, { message: "resolution must be approve or reject" }), 400);
        return;
      }
      const proposal = deps.store.projectRegistry.resolveProposal(
        proposalId,
        resolution === "approve" ? "approved" : "rejected",
        "api"
      );
      if (resolution === "approve") await refreshRegistryCache(deps.store.projectRegistry, deps.cachePath);
      publish(
        createEvent(
          resolution === "approve" ? "project.manifest_approved" : "project.manifest_rejected",
          { proposalId },
          { projectId: proposal.projectId, agent: "registry" }
        )
      );
      sendJson(res, json("ok", proposal));
    })
  );

  router.get("/context/selection", (_req, res) => {
    sendJson(res, json("ok", deps.store.projectRegistry.getSelection()));
  });

  router.post(
    "/context/selection",
    asyncRoute(async (req, res) => {
      const body = (await readJsonBody(req)) as {
        projectId?: string;
        source?: string;
        pinScope?: "workspace" | "session" | "persistent" | null;
      };
      if (!body.projectId) {
        sendJson(res, json("error", undefined, { message: "projectId is required" }), 400);
        return;
      }
      const selection = deps.store.projectRegistry.selectProject(
        body.projectId,
        body.source ?? "api",
        body.pinScope ?? null,
        {
          workspaceId:
            body.pinScope === "workspace" ? deps.store.activeContext.getLatestObservation()?.workspaceId : null,
          sessionId:
            body.pinScope === "session" ? deps.store.activeContext.getLatestObservation()?.origin.instanceId : null,
        }
      );
      await refreshRegistryCache(deps.store.projectRegistry, deps.cachePath);
      publish(
        createEvent(
          body.pinScope ? "project.pinned" : "project.selected",
          { pinScope: body.pinScope ?? null },
          { projectId: body.projectId, agent: "registry" }
        )
      );
      sendJson(res, json("ok", selection));
    })
  );

  router.delete(
    "/context/selection",
    asyncRoute(async (req, res) => {
      const selection = deps.store.projectRegistry.clearSelection(String(req.query.source ?? "api"));
      await refreshRegistryCache(deps.store.projectRegistry, deps.cachePath);
      publish(createEvent("project.unpinned", {}, { agent: "registry" }));
      sendJson(res, json("ok", selection));
    })
  );

  router.post(
    "/desktop/observations",
    asyncRoute(async (req, res) => {
      const observation = deps.store.activeContext.recordObservation(await readJsonBody(req));
      const previous = deps.store.activeContext.getContext();
      const currentSelection = deps.store.projectRegistry.getSelection();
      const selectionExpired =
        (currentSelection?.pinScope === "workspace" && currentSelection.workspaceId !== observation.workspaceId) ||
        (currentSelection?.pinScope === "session" && currentSelection.sessionId !== observation.origin.instanceId);
      const selection = selectionExpired
        ? deps.store.projectRegistry.clearSelection("pin-boundary-changed")
        : currentSelection;
      if (selectionExpired) {
        await refreshRegistryCache(deps.store.projectRegistry, deps.cachePath);
        publish(
          createEvent(
            "project.unpinned",
            { reason: "pin-boundary-changed", pinScope: currentSelection?.pinScope ?? null },
            { projectId: currentSelection?.projectId ?? null, agent: "context" }
          )
        );
      }
      const context = resolveActiveContext({
        observation,
        manifests: deps.store.projectRegistry.listManifests(),
        selection,
        previous,
      });
      deps.store.activeContext.saveContext(context, observation.id);
      await writeActiveContextCache(context);
      publish(
        createEvent(
          "desktop.observed",
          { observationId: observation.id },
          { projectId: context.project?.id ?? null, agent: "desktop" }
        )
      );
      if (previous?.project?.id !== context.project?.id) {
        publish(
          createEvent(
            "active_context.changed",
            { source: context.source, confidence: context.confidence },
            { projectId: context.project?.id ?? null, agent: "context" }
          )
        );
      }
      if (context.confidence < 0.8) {
        publish(
          createEvent(
            "context.confidence_reduced",
            { confidence: context.confidence },
            { projectId: context.project?.id ?? null, agent: "context" }
          )
        );
      }
      sendJson(res, json("ok", context));
    })
  );

  router.get("/context/status", (_req, res) => {
    sendJson(res, json("ok", deps.store.activeContext.getContext()));
  });

  router.get(
    "/project-status",
    asyncRoute(async (req, res) => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      const status = await buildProjectStatus(deps.store, { projectId });
      await writeProjectStatusCache(status);
      sendJson(res, json("ok", status));
    })
  );

  router.get(
    "/project-status/compact",
    asyncRoute(async (req, res) => {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      const status = await buildProjectStatus(deps.store, { projectId });
      await writeProjectStatusCache(status);
      sendJson(res, json("ok", compactProjectStatus(status)));
    })
  );

  router.get("/context/explain", (_req, res) => {
    const context = deps.store.activeContext.getContext();
    sendJson(
      res,
      json("ok", {
        context,
        winningEvidence: context?.evidence ?? [],
        rejectedCandidates: context?.rejectedCandidates ?? [],
        confirmationRecommended: context?.confirmationRecommended ?? true,
      })
    );
  });
}
