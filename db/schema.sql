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
  PRIMARY KEY (account_key, machine_id, incident_id),
  FOREIGN KEY (account_key, machine_id)
    REFERENCES smartenance_machines (account_key, machine_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS smartenance_incidents_id
  ON smartenance_incidents (account_key, incident_id);
