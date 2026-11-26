CREATE SEQUENCE IF NOT EXISTS smartenance_snapshot_revision;

CREATE TABLE IF NOT EXISTS smartenance_machines (
  account_key text NOT NULL,
  machine_id uuid NOT NULL,
  machine jsonb NOT NULL,
  revision bigint NOT NULL,
  incident_count integer NOT NULL CHECK (incident_count >= 0),
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_key, machine_id)
);

CREATE TABLE IF NOT EXISTS smartenance_incidents (
  account_key text NOT NULL,
  machine_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  incident jsonb NOT NULL,
  row_hash text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_key, machine_id, incident_id),
  FOREIGN KEY (account_key, machine_id)
    REFERENCES smartenance_machines (account_key, machine_id) ON DELETE CASCADE
);

ALTER TABLE smartenance_incidents
  ADD COLUMN IF NOT EXISTS row_hash text NOT NULL DEFAULT '';
ALTER TABLE smartenance_incidents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS smartenance_incidents_id
  ON smartenance_incidents (account_key, incident_id);

CREATE TABLE IF NOT EXISTS smartenance_sync_runs (
  id bigserial PRIMARY KEY,
  trigger_source text NOT NULL CHECK (trigger_source IN ('scheduled', 'manual')),
  account_key text,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  machines_total integer NOT NULL DEFAULT 0,
  machines_synced integer NOT NULL DEFAULT 0,
  incidents_total integer NOT NULL DEFAULT 0,
  incidents_inserted integer NOT NULL DEFAULT 0,
  incidents_updated integer NOT NULL DEFAULT 0,
  incidents_unchanged integer NOT NULL DEFAULT 0,
  incidents_deleted integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS smartenance_sync_runs_source_started_at
  ON smartenance_sync_runs (trigger_source, started_at DESC);

CREATE TABLE IF NOT EXISTS hermes_agent_config (
  id integer PRIMARY KEY CHECK (id = 1),
  provider text NOT NULL DEFAULT 'custom',
  api_format text NOT NULL DEFAULT 'openai' CHECK (api_format IN ('openai', 'anthropic')),
  base_url text NOT NULL DEFAULT '',
  api_key text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  smartenance_account_key text NOT NULL DEFAULT 'auto',
  temperature double precision NOT NULL DEFAULT 0.2,
  max_tool_steps integer NOT NULL DEFAULT 8,
  system_prompt text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
