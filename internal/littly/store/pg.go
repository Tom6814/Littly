package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenPostgres stores the whole single-person state as one JSONB row keyed by
// the person id. The Markdown vault remains the source of truth for memories;
// this row is the runtime/index state so the container can be recreated without
// losing her.
func OpenPostgres(ctx context.Context, dir string, pool *pgxpool.Pool, personID string) (*Store, error) {
	if pool == nil {
		return Open(dir)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS littly_state (
		person_id text PRIMARY KEY,
		data jsonb NOT NULL,
		updated_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return nil, fmt.Errorf("create littly_state: %w", err)
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
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := pool.Exec(c, `INSERT INTO littly_state (person_id, data, updated_at) VALUES ($1,$2,now())
			ON CONFLICT (person_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, personID, b)
		return err
	}
	return OpenWithHooks(dir, load, save)
}
