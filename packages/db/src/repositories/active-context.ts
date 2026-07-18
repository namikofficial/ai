import type { DatabaseSync } from "node:sqlite";
import type { ActiveContext, DesktopObservation } from "../../../contracts/src/index.ts";
import { activeContextSchema, desktopObservationSchema } from "../../../contracts/src/index.ts";
import { now } from "./_shared.ts";

export function createActiveContextRepo(db: DatabaseSync) {
  return {
    recordObservation(value: unknown): DesktopObservation {
      const observation = desktopObservationSchema.parse(value);
      db.prepare(
        `INSERT INTO desktop_observations (id, observed_at, observation_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET observed_at = excluded.observed_at, observation_json = excluded.observation_json`
      ).run(observation.id, observation.observedAt, JSON.stringify(observation), now());
      return observation;
    },
    getLatestObservation(): DesktopObservation | null {
      const row = db
        .prepare("SELECT observation_json FROM desktop_observations ORDER BY observed_at DESC LIMIT 1")
        .get() as { observation_json: string } | undefined;
      return row ? desktopObservationSchema.parse(JSON.parse(row.observation_json)) : null;
    },
    saveContext(value: unknown, observationId: string): ActiveContext {
      const context = activeContextSchema.parse(value);
      db.prepare(
        `INSERT INTO active_context_state (singleton_id, context_json, observation_id, updated_at)
         VALUES ('active', ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET context_json = excluded.context_json,
           observation_id = excluded.observation_id, updated_at = excluded.updated_at`
      ).run(JSON.stringify(context), observationId, now());
      return context;
    },
    getContext(): ActiveContext | null {
      const row = db.prepare("SELECT context_json FROM active_context_state WHERE singleton_id = 'active'").get() as
        | { context_json: string }
        | undefined;
      return row ? activeContextSchema.parse(JSON.parse(row.context_json)) : null;
    },
  };
}

export type ActiveContextRepo = ReturnType<typeof createActiveContextRepo>;
