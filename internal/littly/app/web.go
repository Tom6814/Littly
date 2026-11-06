package app

import (
	"embed"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/felinics/memoh/internal/littly/config"
	"github.com/felinics/memoh/internal/littly/store"
)

//go:embed web/*
var webFS embed.FS

// Handler mounts the Littly six-surface UI and API on the Memoh server.
// It is registered as a core server handler (server.Handler), not a separate
// service: one process, one person, one state.
type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func (h *Handler) Register(e *echo.Echo) {
	h.svc.Start()
	g := e.Group("/littly")
	g.GET("", func(c echo.Context) error { return c.Redirect(http.StatusFound, "/littly/") })
	g.GET("/", func(c echo.Context) error {
		b, err := webFS.ReadFile("web/index.html")
		if err != nil {
			return c.String(500, "ui missing")
		}
		return c.Blob(200, "text/html; charset=utf-8", b)
	})
	g.GET("/app.js", func(c echo.Context) error {
		b, _ := webFS.ReadFile("web/app.js")
		return c.Blob(200, "text/javascript; charset=utf-8", b)
	})
	g.GET("/style.css", func(c echo.Context) error {
		b, _ := webFS.ReadFile("web/style.css")
		return c.Blob(200, "text/css; charset=utf-8", b)
	})
	api := g.Group("/api")
	api.GET("/health", h.health)
	api.GET("/bootstrap", h.bootstrap)
	api.GET("/config", h.getConfig)
	api.PUT("/config", h.putConfig)
	api.GET("/today", h.today)
	api.GET("/messages", h.messages)
	api.POST("/chat", h.chat)
	api.GET("/memories", h.memories)
	api.GET("/people", h.people)
	api.GET("/people/:id", h.person)
	api.POST("/people/:id/important", h.personImportant)
	api.POST("/people/:id/archive", h.personArchive)
	api.GET("/archive", h.archive)
	api.POST("/archive/:id/restore", h.archiveRestore)
	api.GET("/activities", h.activities)
	api.POST("/activities/run", h.activityRun)
	api.GET("/artifacts", h.artifacts)
	api.GET("/files", h.files)
	api.GET("/files/content", h.fileContent)
	api.PUT("/files/content", h.fileWrite)
	api.GET("/events", h.events)
	api.GET("/heartbeat", h.heartbeatInfo)
	api.POST("/heartbeat", h.heartbeatControl)
	api.POST("/dream", h.dream)
	api.GET("/world", h.world)
}

func (h *Handler) health(c echo.Context) error {
	return c.JSON(200, h.svc.Health())
}

func (h *Handler) bootstrap(c echo.Context) error {
	cfg := h.svc.Config().Redacted()
	p := h.svc.Person()
	return c.JSON(200, map[string]any{
		"person": map[string]any{"id": p.ID, "name": p.DisplayName, "nickname": p.Nickname, "timezone": p.Timezone, "traits": cfg.Person.Traits, "self": cfg.Person.Self, "style": cfg.Person.Style, "boundaries": cfg.Person.Boundaries, "bio": cfg.Person.Bio},
		"model": map[string]any{"model": cfg.Brain.Model, "base_url": cfg.Brain.BaseURL, "temperature": cfg.Brain.Temperature},
		"heartbeat": map[string]any{"enabled": cfg.Heartbeat.Enabled, "day_minutes": cfg.Heartbeat.FallbackDayMinutes, "night_minutes": cfg.Heartbeat.FallbackNightMinutes, "day_start": cfg.Heartbeat.DayStart, "day_end": cfg.Heartbeat.DayEnd},
		"health": h.svc.Health(),
		"next_heartbeat": h.svc.nextHeartbeatInfo(),
		"channels": map[string]any{"snowluma": h.svc.snowLumaStatus()},
	})
}

func (h *Handler) getConfig(c echo.Context) error {
	cfg := h.svc.Config().Redacted()
	return c.JSON(200, map[string]any{"config": cfg, "path": cfg.Path()})
}

func (h *Handler) putConfig(c echo.Context) error {
	var body struct {
		Name          *string        `json:"name"`
		Nickname      *string        `json:"nickname"`
		Style         *string        `json:"style"`
		Self          *string        `json:"self"`
		Boundaries    *string        `json:"boundaries"`
		Traits        map[string]int `json:"traits"`
		Model         *string        `json:"model"`
		Temperature   *float64       `json:"temperature"`
		DayMinutes    *int           `json:"day_minutes"`
		NightMinutes  *int           `json:"night_minutes"`
		Enabled       *bool          `json:"heartbeat_enabled"`
		SLEnabled     *bool          `json:"snowluma_enabled"`
		SLWS          *string        `json:"snowluma_ws"`
		SLToken       *string        `json:"snowluma_token"`
		SLAccount     *string        `json:"snowluma_account"`
		SLOwner       *string        `json:"snowluma_owner"`
	}
	if err := c.Bind(&body); err != nil {
		return jsonErr(c, 400, "bad json", err)
	}
	err := h.svc.UpdateConfig(func(cfg *config.Config) {
		if body.Name != nil {
			cfg.Person.Name = *body.Name
		}
		if body.Nickname != nil {
			cfg.Person.Nickname = *body.Nickname
		}
		if body.Style != nil {
			cfg.Person.Style = *body.Style
		}
		if body.Self != nil {
			cfg.Person.Self = *body.Self
		}
		if body.Boundaries != nil {
			cfg.Person.Boundaries = *body.Boundaries
		}
		if body.Traits != nil {
			cfg.Person.Traits = body.Traits
		}
		if body.Model != nil {
			cfg.Brain.Model = *body.Model
		}
		if body.Temperature != nil {
			cfg.Brain.Temperature = *body.Temperature
		}
		if body.DayMinutes != nil {
			cfg.Heartbeat.FallbackDayMinutes = *body.DayMinutes
		}
		if body.NightMinutes != nil {
			cfg.Heartbeat.FallbackNightMinutes = *body.NightMinutes
		}
		if body.Enabled != nil {
			cfg.Heartbeat.Enabled = *body.Enabled
		}
		if body.SLEnabled != nil {
			cfg.Channels.SnowLuma.Enabled = *body.SLEnabled
		}
		if body.SLWS != nil {
			cfg.Channels.SnowLuma.WSURL = *body.SLWS
		}
		if body.SLToken != nil && *body.SLToken != "" && *body.SLToken != "***" {
			cfg.Channels.SnowLuma.Token = *body.SLToken
		}
		if body.SLAccount != nil {
			cfg.Channels.SnowLuma.AccountRef = *body.SLAccount
		}
		if body.SLOwner != nil {
			cfg.Channels.SnowLuma.OwnerExternalID = *body.SLOwner
		}
	})
	if err != nil {
		return jsonErr(c, 400, "invalid config", err)
	}
	h.svc.stopSnowLuma()
	if h.svc.Config().Channels.SnowLuma.Enabled {
		h.svc.startSnowLuma()
	}
	return c.JSON(200, map[string]any{"ok": true, "config": h.svc.Config().Redacted()})
}

func (h *Handler) today(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	p := h.svc.Person()
	var activities []store.Activity
	for i := len(st.Activities) - 1; i >= 0 && len(activities) < 8; i-- {
		activities = append(activities, st.Activities[i])
	}
	var events []store.Event
	for i := len(st.Events) - 1; i >= 0 && len(events) < 20; i-- {
		events = append(events, st.Events[i])
	}
	var runs []store.HeartbeatRun
	for i := len(st.HeartbeatRuns) - 1; i >= 0 && len(runs) < 5; i-- {
		runs = append(runs, st.HeartbeatRuns[i])
	}
	msgs := h.svc.recentMessages("owner", 12)
	return c.JSON(200, map[string]any{
		"person": p, "runtime": st.Runtime, "health": h.svc.Health(), "next_heartbeat": h.svc.nextHeartbeatInfo(),
		"activities": activities, "events": events, "heartbeat_runs": runs, "messages": msgs,
		"counts": map[string]int{"memories": len(st.Memories), "people": len(st.People), "artifacts": len(st.Artifacts)},
	})
}

func (h *Handler) messages(c echo.Context) error {
	limit := 50
	return c.JSON(200, map[string]any{"messages": h.svc.recentMessages("owner", limit)})
}

func (h *Handler) chat(c echo.Context) error {
	var body struct {
		Content string `json:"content"`
	}
	if err := c.Bind(&body); err != nil {
		return jsonErr(c, 400, "bad json", err)
	}
	res, err := h.svc.HandleChat(c.Request().Context(), body.Content)
	if err != nil {
		return jsonErr(c, 500, "chat failed", err)
	}
	return c.JSON(200, res)
}

func (h *Handler) memories(c echo.Context) error {
	q := c.QueryParam("q")
	domain := c.QueryParam("domain")
	viewer := "owner"
	st := h.svc.Store().Snapshot()
	out := make([]store.Memory, 0)
	for _, m := range st.Memories {
		if m.Visibility == "private" {
			continue
		}
		if m.Visibility == "relationship" && m.VisibilityPeopleID != viewer {
			continue
		}
		if domain != "" && m.Domain != domain {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(m.Title+" "+m.Body), strings.ToLower(q)) {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EventTime.After(out[j].EventTime) })
	if len(out) > 100 {
		out = out[:100]
	}
	return c.JSON(200, map[string]any{"memories": out})
}

func (h *Handler) people(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	includeArchived := c.QueryParam("archived") == "1"
	out := make([]map[string]any, 0)
	for _, p := range st.People {
		if p.Tier == "archived" && !includeArchived {
			continue
		}
		out = append(out, map[string]any{
			"id": p.ID, "name": p.DisplayName, "tier": p.Tier, "relationship": p.Relationship,
			"closeness": p.Closeness, "important": p.Important, "brief": p.Brief, "channel": p.Channel,
			"last": p.LastInteractionAt, "card_mode": p.CardMode, "interactions": p.InteractionCount,
			"archived_at": p.ArchivedAt,
		})
	}
	return c.JSON(200, map[string]any{"people": out})
}

func (h *Handler) person(c echo.Context) error {
	p, card := h.svc.PersonCard(c.Param("id"))
	if p.ID == "" {
		return c.JSON(404, map[string]string{"error": "not found"})
	}
	return c.JSON(200, map[string]any{"person": p, "card": card})
}

func (h *Handler) personImportant(c echo.Context) error {
	var body struct {
		Important bool `json:"important"`
	}
	_ = c.Bind(&body)
	if err := h.svc.SetImportant(c.Param("id"), body.Important); err != nil {
		return jsonErr(c, 400, "update failed", err)
	}
	return c.JSON(200, map[string]any{"ok": true})
}

func (h *Handler) personArchive(c echo.Context) error {
	if err := h.svc.Archive(c.Param("id"), "manual"); err != nil {
		return jsonErr(c, 400, "archive failed", err)
	}
	return c.JSON(200, map[string]any{"ok": true})
}

func (h *Handler) archive(c echo.Context) error {
	q := c.QueryParam("q")
	return c.JSON(200, map[string]any{"candidates": h.svc.Recall(q, 10)})
}

func (h *Handler) archiveRestore(c echo.Context) error {
	p, err := h.svc.Restore(c.Param("id"))
	if err != nil {
		return jsonErr(c, 400, "restore failed", err)
	}
	return c.JSON(200, map[string]any{"ok": true, "person": p})
}

func (h *Handler) activityRun(c echo.Context) error {
	a, err := h.svc.RunSoloActivity(c.Request().Context())
	if err != nil {
		return jsonErr(c, 500, "activity failed", err)
	}
	return c.JSON(200, map[string]any{"activity": a})
}

func (h *Handler) activities(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	return c.JSON(200, map[string]any{"activities": st.Activities})
}

func (h *Handler) artifacts(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	var out []store.Artifact
	for i := len(st.Artifacts) - 1; i >= 0 && len(out) < 100; i-- {
		out = append(out, st.Artifacts[i])
	}
	return c.JSON(200, map[string]any{"artifacts": out})
}

func (h *Handler) files(c echo.Context) error {
	rel := c.QueryParam("path")
	res, err := h.svc.toolFileList(rel)
	if err != nil {
		return jsonErr(c, 400, "list failed", err)
	}
	return c.Blob(200, "application/json", []byte(res))
}

func (h *Handler) fileContent(c echo.Context) error {
	rel := c.QueryParam("path")
	if rel == "" {
		return c.JSON(400, map[string]string{"error": "path required"})
	}
	res, err := h.svc.toolFileRead(rel)
	if err != nil {
		return jsonErr(c, 404, "read failed", err)
	}
	return c.JSON(200, map[string]any{"path": rel, "content": res})
}

func (h *Handler) fileWrite(c echo.Context) error {
	var body struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := c.Bind(&body); err != nil {
		return jsonErr(c, 400, "bad json", err)
	}
	res, err := h.svc.toolFileWrite(body.Path, body.Content)
	if err != nil {
		return jsonErr(c, 400, "write failed", err)
	}
	return c.Blob(200, "application/json", []byte(res))
}

func (h *Handler) events(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	var out []store.Event
	for i := len(st.Events) - 1; i >= 0 && len(out) < 200; i-- {
		out = append(out, st.Events[i])
	}
	return c.JSON(200, map[string]any{"events": out})
}

func (h *Handler) heartbeatInfo(c echo.Context) error {
	st := h.svc.Store().Snapshot()
	var runs []store.HeartbeatRun
	for i := len(st.HeartbeatRuns) - 1; i >= 0 && len(runs) < 20; i-- {
		runs = append(runs, st.HeartbeatRuns[i])
	}
	var hbs []store.Heartbeat
	for i := len(st.Heartbeats) - 1; i >= 0 && len(hbs) < 20; i-- {
		hbs = append(hbs, st.Heartbeats[i])
	}
	return c.JSON(200, map[string]any{"next": h.svc.nextHeartbeatInfo(), "runs": runs, "heartbeats": hbs})
}

func (h *Handler) heartbeatControl(c echo.Context) error {
	var body struct {
		Action  string `json:"action"`
		Minutes int    `json:"minutes"`
		Reason  string `json:"reason"`
	}
	if err := c.Bind(&body); err != nil {
		return jsonErr(c, 400, "bad json", err)
	}
	switch body.Action {
	case "now":
		h.svc.runHeartbeat("manual", "手动心跳")
	case "pause":
		h.svc.mu.Lock()
		h.svc.paused = true
		h.svc.mu.Unlock()
	case "resume":
		h.svc.mu.Lock()
		h.svc.paused = false
		h.svc.fallbackAt = time.Now()
		h.svc.mu.Unlock()
		// Resuming is an explicit user action; clear the no-op streak so the
		// governor does not immediately re-pause the next fallback heartbeat.
		_ = h.svc.st.Mutate(func(st *store.State) error { st.Runtime.NoopStreak = 0; return nil })
	case "schedule":
		if err := h.svc.scheduleSelfHeartbeat(time.Duration(body.Minutes)*time.Minute, body.Reason); err != nil {
			return jsonErr(c, 400, "schedule failed", err)
		}
	default:
		return c.JSON(400, map[string]string{"error": "unknown action"})
	}
	return c.JSON(200, map[string]any{"ok": true, "next": h.svc.nextHeartbeatInfo()})
}

func (h *Handler) dream(c echo.Context) error {
	d, err := h.svc.RunDream(c.Request().Context())
	if err != nil {
		return jsonErr(c, 500, "dream failed", err)
	}
	return c.JSON(200, map[string]any{"dream": d})
}

func (h *Handler) world(c echo.Context) error {
	cfg := h.svc.Config().Redacted()
	return c.JSON(200, map[string]any{
		"channels": map[string]any{"snowluma": h.svc.snowLumaStatus()},
		"owner":    h.svc.Person(),
		"model":    cfg.Brain.Model,
		"dirs":     map[string]string{"vault": cfg.Memory.VaultDir, "workspace": cfg.Workbench.Dir},
	})
}

func jsonErr(c echo.Context, code int, msg string, err error) error {
	return c.JSON(code, map[string]any{"error": msg, "detail": err.Error()})
}


// BrokenHandler is registered when the Littly service cannot initialize. It
// keeps the server booting while making the failure visible instead of a 404.
type BrokenHandler struct{ Err error }

func NewBrokenHandler(err error) *BrokenHandler { return &BrokenHandler{Err: err} }

func (h *BrokenHandler) Register(e *echo.Echo) {
	e.GET("/littly/*", func(c echo.Context) error {
		return c.JSON(503, map[string]any{"error": "littly unavailable", "detail": h.Err.Error()})
	})
}
