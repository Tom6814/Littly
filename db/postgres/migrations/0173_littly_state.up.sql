-- Littly v2: single-person runtime/index state (JSONB). Markdown vault remains
-- the source of truth for memories; this row makes container recreation safe.
CREATE TABLE IF NOT EXISTS littly_state (
    person_id  text PRIMARY KEY,
    data       jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
