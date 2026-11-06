package main

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/felinics/memoh/internal/littly/app"
	"github.com/felinics/memoh/internal/server"
)

// provideLittlyHandler mounts the Littly v2 core UI/API on the server.
// It is a core handler (same process, same Postgres pool, same data volume),
// not a separate service.
func provideLittlyHandler(log *slog.Logger, pool *pgxpool.Pool) server.Handler {
	svc, err := app.New(log, app.WithPool(pool))
	if err != nil {
		log.Error("littly: init failed; serving degraded panel", "err", err)
		return app.NewBrokenHandler(err)
	}
	return app.NewHandler(svc)
}
