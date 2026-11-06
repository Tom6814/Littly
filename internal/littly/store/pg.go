package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenPostgres stores the whole single-person state as one JSONB row keyed by
// the person id (the source of truth for runtime), and mirrors it into
// normalized littly_* tables so Memoh's Postgres is queryable.
func OpenPostgres(ctx context.Context, dir string, pool *pgxpool.Pool, personID string) (*Store, error) {
	if pool == nil {
		return Open(dir)
	}
	if err := ensureTables(ctx, pool); err != nil {
		return nil, err
	}
	load := func() ([]byte, error) {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var b []byte
		err := pool.QueryRow(c, `SELECT data FROM littly_state WHERE person_id=$1`, personID).Scan(&b)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return b, err
	}
	save := func(b []byte) error {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(c, `INSERT INTO littly_state (person_id, data, updated_at) VALUES ($1,$2,now())
			ON CONFLICT (person_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, personID, b); err != nil {
			return err
		}
		var st State
		if err := json.Unmarshal(b, &st); err != nil {
			return err
		}
		return syncDomain(c, pool, personID, st)
	}
	return OpenWithHooks(dir, load, save)
}

func ensureTables(ctx context.Context, pool *pgxpool.Pool) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS littly_state (person_id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS littly_people (id text PRIMARY KEY, person_id text NOT NULL, display_name text NOT NULL, tier text NOT NULL, relationship text NOT NULL, closeness int NOT NULL DEFAULT 0, important boolean NOT NULL DEFAULT false, brief text NOT NULL DEFAULT '', card_mode text NOT NULL DEFAULT 'full', interaction_count int NOT NULL DEFAULT 0, last_interaction_at timestamptz, archived_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS littly_memories (id text PRIMARY KEY, person_id text NOT NULL, domain text NOT NULL, kind text NOT NULL, title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', event_time timestamptz NOT NULL, record_time timestamptz NOT NULL, importance int NOT NULL DEFAULT 3, visibility text NOT NULL DEFAULT 'public', visibility_people_id text, source text NOT NULL DEFAULT '', vault_path text NOT NULL DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS littly_activities (id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, title text NOT NULL, status text NOT NULL, progress int NOT NULL DEFAULT 0, started_at timestamptz, ended_at timestamptz, summary text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS littly_artifacts (id text PRIMARY KEY, person_id text NOT NULL, activity_id text, kind text NOT NULL, title text NOT NULL DEFAULT '', path text NOT NULL DEFAULT '', bytes bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS littly_heartbeats (id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, due_at timestamptz NOT NULL, reason text NOT NULL DEFAULT '', status text NOT NULL, noop_count int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), fired_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS littly_heartbeat_runs (id text PRIMARY KEY, person_id text NOT NULL, heartbeat_id text, kind text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, outcome text NOT NULL DEFAULT '', notify boolean, summary text NOT NULL DEFAULT '', next_due_at timestamptz, next_reason text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS littly_reply_decisions (id text PRIMARY KEY, person_id text NOT NULL, people_id text, channel text NOT NULL DEFAULT '', action text NOT NULL, reason text NOT NULL DEFAULT '', decided_at timestamptz NOT NULL, sent_at timestamptz, outcome text NOT NULL DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS littly_outbox (id text PRIMARY KEY, person_id text NOT NULL, kind text NOT NULL, channel text NOT NULL DEFAULT '', people_id text, due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'queued', payload text NOT NULL DEFAULT '', attempts int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS littly_events (id text PRIMARY KEY, person_id text NOT NULL, at timestamptz NOT NULL, kind text NOT NULL, title text NOT NULL DEFAULT '', detail text NOT NULL DEFAULT '', people_id text, activity_id text)`,
		`CREATE TABLE IF NOT EXISTS littly_diaries (id text PRIMARY KEY, person_id text NOT NULL, day text NOT NULL, content text NOT NULL DEFAULT '', mood text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', at timestamptz NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS littly_dreams (id text PRIMARY KEY, person_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz, status text NOT NULL, summary text NOT NULL DEFAULT '')`,
	}
	for _, q := range stmts {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("ensure %s: %w", q[:40], err)
		}
	}
	return nil
}

func syncDomain(ctx context.Context, pool *pgxpool.Pool, personID string, st State) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tables := []string{"littly_people", "littly_memories", "littly_activities", "littly_artifacts", "littly_heartbeats", "littly_heartbeat_runs", "littly_reply_decisions", "littly_outbox", "littly_events", "littly_diaries", "littly_dreams"}
	for _, t := range tables {
		if _, err := tx.Exec(ctx, "DELETE FROM "+t+" WHERE person_id=$1", personID); err != nil {
			return err
		}
	}
	for _, p := range st.People {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_people (id,person_id,display_name,tier,relationship,closeness,important,brief,card_mode,interaction_count,last_interaction_at,archived_at,updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`, p.ID, personID, p.DisplayName, p.Tier, p.Relationship, p.Closeness, p.Important, p.Brief, p.CardMode, p.InteractionCount, p.LastInteractionAt, p.ArchivedAt); err != nil {
			return err
		}
	}
	for _, m := range st.Memories {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_memories (id,person_id,domain,kind,title,body,event_time,record_time,importance,visibility,visibility_people_id,source,vault_path)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, m.ID, personID, m.Domain, m.Kind, m.Title, m.Body, m.EventTime, m.RecordTime, m.Importance, m.Visibility, nullStr(m.VisibilityPeopleID), m.Source, m.VaultPath); err != nil {
			return err
		}
	}
	for _, a := range st.Activities {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_activities (id,person_id,kind,title,status,progress,started_at,ended_at,summary,updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`, a.ID, personID, a.Kind, a.Title, a.Status, a.Progress, a.StartedAt, a.EndedAt, a.Summary); err != nil {
			return err
		}
	}
	for _, a := range st.Artifacts {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_artifacts (id,person_id,activity_id,kind,title,path,bytes,created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, a.ID, personID, nullStr(a.ActivityID), a.Kind, a.Title, a.Path, a.Bytes, a.CreatedAt); err != nil {
			return err
		}
	}
	for _, h := range st.Heartbeats {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_heartbeats (id,person_id,kind,due_at,reason,status,noop_count,created_at,fired_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, h.ID, personID, h.Kind, h.DueAt, h.Reason, h.Status, h.NoopCount, h.CreatedAt, h.FiredAt); err != nil {
			return err
		}
	}
	for _, r := range st.HeartbeatRuns {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_heartbeat_runs (id,person_id,heartbeat_id,kind,started_at,ended_at,outcome,notify,summary,next_due_at,next_reason,error)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, r.ID, personID, nullStr(r.HeartbeatID), r.Kind, r.StartedAt, r.EndedAt, r.Outcome, r.Notify, r.Summary, r.NextDueAt, r.NextReason, r.Error); err != nil {
			return err
		}
	}
	for _, d := range st.ReplyDecisions {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_reply_decisions (id,person_id,people_id,channel,action,reason,decided_at,sent_at,outcome)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, d.ID, personID, nullStr(d.PeopleID), d.Channel, d.Action, d.Reason, d.DecidedAt, d.SentAt, d.Outcome); err != nil {
			return err
		}
	}
	for _, o := range st.Outbox {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_outbox (id,person_id,kind,channel,people_id,due_at,status,payload,attempts,created_at,updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`, o.ID, personID, o.Kind, o.Channel, nullStr(o.PeopleID), o.DueAt, o.Status, o.Payload, o.Attempts, o.CreatedAt); err != nil {
			return err
		}
	}
	for _, e := range st.Events {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_events (id,person_id,at,kind,title,detail,people_id,activity_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, e.ID, personID, e.At, e.Kind, e.Title, e.Detail, nullStr(e.PeopleID), nullStr(e.ActivityID)); err != nil {
			return err
		}
	}
	for _, d := range st.Diaries {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_diaries (id,person_id,day,content,mood,summary,at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`, d.ID, personID, d.Day, d.Content, d.Mood, d.Summary, d.At); err != nil {
			return err
		}
	}
	for _, d := range st.Dreams {
		if _, err := tx.Exec(ctx, `INSERT INTO littly_dreams (id,person_id,started_at,ended_at,status,summary)
			VALUES ($1,$2,$3,$4,$5,$6)`, d.ID, personID, d.StartedAt, d.EndedAt, d.Status, d.Summary); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
