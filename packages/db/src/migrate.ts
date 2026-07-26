import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

interface MigrationFile {
  version: string;
  path: string;
  sql: string;
}

const MIGRATIONS_DIR = "packages/db/migrations";

function resolveMigrationsDir(): string {
  // MCP clients launch the server with the user's project as cwd. Resolve
  // migrations from this source file so the database can initialize anywhere.
  return join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

export function listMigrations(): MigrationFile[] {
  const dir = resolveMigrationsDir();
  let entries: string[];
  try {
    entries = (readdirSync(dir) as string[]).filter((name) => name.endsWith(".sql")).sort();
  } catch {
    return [];
  }
  return entries.map((name) => {
    const version = name.replace(/\.sql$/, "");
    return { version, path: join(dir, name), sql: readFileSync(join(dir, name), "utf8") as string };
  });
}

export function runMigrations(db: DatabaseSync): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const knownRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: string;
  }>;
  const known = new Set(knownRows.map((row) => row.version));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of listMigrations()) {
    if (known.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    // Migrations must be idempotent (CREATE TABLE IF NOT EXISTS etc.) because we
    // cannot wrap statements like `PRAGMA journal_mode = WAL` in a transaction.
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      migration.version,
      new Date().toISOString()
    );
    applied.push(migration.version);
  }

  return { applied, skipped };
}
