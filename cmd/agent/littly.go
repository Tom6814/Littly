package main

import (
	"log/slog"

	"github.com/felinics/memoh/internal/littly/app"
	"github.com/felinics/memoh/internal/server"
)

// provideLittlyHandler mounts the Littly v2 core UI/API on the server.
// It is a core handler (same process, same data volume), not a separate service.
func provideLittlyHandler(log *slog.Logger) server.Handler {
	svc, err := app.New(log)
	if err != nil {
		log.Error("littly: init failed; serving degraded panel", "err", err)
		return app.NewBrokenHandler(err)
	}
	return app.NewHandler(svc)
}
