CREATE TABLE IF NOT EXISTS desktop_observations (
  id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_desktop_observations_observed_at
  ON desktop_observations (observed_at DESC);

CREATE TABLE IF NOT EXISTS active_context_state (
  singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'active'),
  context_json TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (observation_id) REFERENCES desktop_observations (id) ON DELETE CASCADE
);
