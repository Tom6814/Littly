-- Littly v2 normalized domain tables (single person, mirror of runtime state).
CREATE TABLE IF NOT EXISTS littly_people (
  id text PRIMARY KEY, person_id text NOT NULL, display_name text NOT NULL,
  tier text NOT NULL, relationship text NOT NULL, closeness int NOT NULL DEFAULT 0,
  important boolean NOT NULL DEFAULT false, brief text NOT NULL DEFAULT '',
  card_mode text NOT NULL DEFAULT 'full', interaction_count int NOT NULL DEFAULT 0,
  last_interaction_at timestamptz, archived_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_littly_people_person ON littly_people(person_id, tier);

CREATE TABLE IF NOT EXISTS littly_memories (
  id text PRIMARY KEY, person_id text NOT NULL, domain text NOT NULL, kind text NOT NULL,
  title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  event_time timestamptz NOT NULL, record_time timestamptz NOT NULL,
  importance int NOT NULL DEFAULT 3, visibility text NOT NULL DEFAULT 'public',
  visibility_people_id text, source text NOT NULL DEFAULT '', vault_path text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_littly_memories_person ON littly_memories(person_id, event_time DESC);

CREATE TABLE IF NOT EXISTS littly_activities (
  id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, title text NOT NULL,
  status text NOT NULL, progress int NOT NULL DEFAULT 0, started_at timestamptz,
  ended_at timestamptz, summary text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS littly_artifacts (
  id text PRIMARY KEY, person_id text NOT NULL, activity_id text, kind text NOT NULL,
  title text NOT NULL DEFAULT '', path text NOT NULL DEFAULT '', bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS littly_heartbeats (
  id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, due_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '', status text NOT NULL, noop_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), fired_at timestamptz
);
CREATE INDEX IF NOT EXISTS ix_littly_heartbeats_due ON littly_heartbeats(person_id, status, due_at);

CREATE TABLE IF NOT EXISTS littly_heartbeat_runs (
  id text PRIMARY KEY, person_id text NOT NULL, heartbeat_id text, kind text NOT NULL,
  started_at timestamptz NOT NULL, ended_at timestamptz, outcome text NOT NULL DEFAULT '',
  notify boolean, summary text NOT NULL DEFAULT '', next_due_at timestamptz,
  next_reason text NOT NULL DEFAULT '', error text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS littly_reply_decisions (
  id text PRIMARY KEY, person_id text NOT NULL, people_id text, channel text NOT NULL DEFAULT '',
  action text NOT NULL, reason text NOT NULL DEFAULT '', decided_at timestamptz NOT NULL,
  sent_at timestamptz, outcome text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS littly_outbox (
  id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, channel text NOT NULL DEFAULT '',
  people_id text, due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'queued',
  payload text NOT NULL DEFAULT '', attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS littly_events (
  id text PRIMARY KEY, person_id text NOT NULL, at timestamptz NOT NULL, kind text NOT NULL,
  title text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '', people_id text, activity_id text
);

CREATE TABLE IF NOT EXISTS littly_diaries (
  id text PRIMARY KEY, person_id text NOT NULL, day text NOT NULL, content text NOT NULL DEFAULT '',
  mood text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS littly_dreams (
  id text PRIMARY KEY, person_id text NOT NULL, started_at timestamptz NOT NULL,
  ended_at timestamptz, status text NOT NULL, summary text NOT NULL DEFAULT ''
);
