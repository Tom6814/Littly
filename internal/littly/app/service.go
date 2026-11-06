// Package app implements the Littly v2 layer on top of Memoh.
//
// It deliberately lives outside Memoh's core packages: Memoh provides the
// server, web shell, channels and workspace; this package provides *her*:
// one person, self-memory, people tiers/archive, personality-driven replies,
// heartbeat and a small life/activity loop.
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/felinics/memoh/internal/littly/config"
	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/memoryapi"
	"github.com/felinics/memoh/internal/littly/store"
)

type Service struct {
	log     *slog.Logger
	cfg     config.Config
	cfgPath string
	dataDir string
	st      *store.Store
	vault   *Vault
	llm     llm.Client

	mu           sync.Mutex
	fallbackAt   time.Time
	paused       bool
	running      bool
	stop         chan struct{}
	wg           sync.WaitGroup
	lastErr      string
	lastBeatAt   time.Time
	activityID   string
	usingPG      bool
	heartRunning bool
	snowluma     *SnowLumaClient
}

func DataDir() string {
	if v := os.Getenv("LITTLY_DATA_DIR"); v != "" {
		return v
	}
	return "/opt/memoh/data/littly"
}

type options struct {
	pool     *pgxpool.Pool
	personID string
}

// Option customizes the Littly service (tests omit it; the server injects the
// Memoh Postgres pool so state survives container recreation).
type Option func(*options)

func WithPool(pool *pgxpool.Pool) Option {
	return func(o *options) { o.pool = pool }
}

func New(log *slog.Logger, opts ...Option) (*Service, error) {
	o := options{personID: "owner"}
	for _, fn := range opts {
		fn(&o)
	}
	dataDir := DataDir()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	cfgPath := os.Getenv("LITTLY_CONFIG")
	if cfgPath == "" {
		cfgPath = filepath.Join(dataDir, "config.json")
	}
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		c := config.Default()
		c.Server.DataDir = dataDir
		c.Memory.VaultDir = filepath.Join(dataDir, "vault")
		c.Workbench.Dir = filepath.Join(dataDir, "workspace")
		c.Brain.APIKeyEnv = "LITTLY_API_KEY"
		b, _ := json.MarshalIndent(c, "", "  ")
		if err := os.WriteFile(cfgPath, b, 0o600); err != nil {
			return nil, err
		}
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	// Keep data inside the configured instance dir unless explicitly absolute.
	cfg.Server.DataDir = dataDir
	if cfg.Memory.VaultDir == "" {
		cfg.Memory.VaultDir = filepath.Join(dataDir, "vault")
	}
	if cfg.Workbench.Dir == "" {
		cfg.Workbench.Dir = filepath.Join(dataDir, "workspace")
	}
	var st *store.Store
	if o.pool != nil {
		st, err = store.OpenPostgres(context.Background(), dataDir, o.pool, o.personID)
	} else {
		st, err = store.Open(dataDir)
	}
	if err != nil {
		return nil, err
	}
	if _, err := st.EnsurePerson("owner", cfg.Person.Name, cfg.Person.Nickname, cfg.Person.Timezone); err != nil {
		return nil, err
	}
	vault, err := NewVault(cfg.Memory.VaultDir)
	if err != nil {
		return nil, err
	}
	if err := vault.EnsureSelf(cfg.Person.Self); err != nil {
		return nil, err
	}
	for _, sub := range []string{"home/notes", "home/docs", "home/projects", "home/reading", "home/drafts", "home/assets", "home/inbox", "home/journal", "skills", "scripts"} {
		_ = os.MkdirAll(filepath.Join(cfg.Workbench.Dir, sub), 0o755)
	}
	s := &Service{log: log, cfg: cfg, cfgPath: cfgPath, dataDir: dataDir, st: st, vault: vault, stop: make(chan struct{}), usingPG: o.pool != nil}
	if c, err := llm.NewDeepSeek(cfg.Brain); err != nil {
		s.lastErr = err.Error()
		s.log.Warn("littly: LLM not configured; running degraded", "err", err)
	} else {
		s.llm = c
	}
	s.fallbackAt = time.Now()
	return s, nil
}

func (s *Service) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()
	s.wg.Add(1)
	go s.loop()
	if s.cfg.Channels.SnowLuma.Enabled {
		memoryapi.Set(memoryBackend{s: s})
		s.startSnowLuma()
	}
}

func (s *Service) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	close(s.stop)
	s.mu.Unlock()
	s.stopSnowLuma()
	s.wg.Wait()
}

func (s *Service) Config() config.Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Service) Store() *store.Store { return s.st }
func (s *Service) Vault() *Vault       { return s.vault }
func (s *Service) Log() *slog.Logger   { return s.log }

func (s *Service) LLM() llm.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.llm
}

// SetLLM is used by tests and by settings updates.
func (s *Service) SetLLM(c llm.Client) {
	s.mu.Lock()
	s.llm = c
	s.mu.Unlock()
}

func (s *Service) UpdateConfig(fn func(*config.Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	fn(&next)
	next.Server.DataDir = s.dataDir
	if next.Memory.VaultDir == "" {
		next.Memory.VaultDir = filepath.Join(s.dataDir, "vault")
	}
	if next.Workbench.Dir == "" {
		next.Workbench.Dir = filepath.Join(s.dataDir, "workspace")
	}
	if err := next.Validate(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.cfgPath, b, 0o600); err != nil {
		return err
	}
	s.cfg = next
	if c, err := llm.NewDeepSeek(next.Brain); err == nil {
		s.llm = c
		s.lastErr = ""
	} else {
		s.lastErr = err.Error()
	}
	return nil
}

func (s *Service) Person() store.Person { return s.st.Person() }

func (s *Service) LocalNow() time.Time {
	p := s.Person()
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		loc = time.UTC
	}
	return time.Now().In(loc)
}

// PingModel performs one tiny completion so the settings page can verify the
// configured key/model without spending a full turn.
func (s *Service) PingModel(ctx context.Context) (map[string]any, error) {
	if s.LLM() == nil {
		return nil, fmt.Errorf("model not configured")
	}
	start := time.Now()
	res, err := s.LLM().Chat(ctx, llm.Request{Messages: []llm.Message{{Role: llm.RoleUser, Content: "只回复：ok"}}, Temperature: 0, MaxTokens: 8})
	if err != nil {
		return nil, err
	}
	reply := strings.TrimSpace(res.Content)
	if reply == "" {
		reply = "(empty)"
	}
	return map[string]any{"ok": true, "model": s.LLM().Model(), "reply": reply, "latency_ms": time.Since(start).Milliseconds()}, nil
}

func (s *Service) Health() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := "ok"
	if s.llm == nil {
		status = "degraded"
	}
	model := ""
	if s.llm != nil {
		model = s.llm.Model()
	}
	vaultTest := filepath.Join(s.cfg.Memory.VaultDir, ".healthcheck")
	vaultOK := os.WriteFile(vaultTest, []byte("ok"), 0o644) == nil
	_ = os.Remove(vaultTest)
	return map[string]any{
		"status": status, "model": model, "last_error": s.lastErr,
		"storage":           map[string]any{"postgres": s.usingPG, "vault": s.cfg.Memory.VaultDir, "vault_ok": vaultOK},
		"heartbeat_running": s.running, "heartbeat_paused": s.paused,
		"last_heartbeat": s.lastBeatAt, "fallback_at": s.fallbackAt,
		"snowluma": s.snowLumaStatusLocked(),
	}
}

func (s *Service) loop() {
	defer s.wg.Done()
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-tick.C:
			s.tickLifecycle()
			s.tickHeartbeat()
			s.tickLife(s.LocalNow())
			s.tickOutbox()
		}
	}
}

func (s *Service) tickLifecycle() {
	now := nowUTC()
	var changed bool
	_ = s.st.Mutate(func(st *store.State) error {
		// Auto-forget only acquaintances/strangers; protected people never expire.
		for i := range st.People {
			p := &st.People[i]
			if p.Relationship == "owner" || p.Important || p.Tier == "friend" || p.Tier == "intimate" || p.Tier == "archived" || p.Tier == "blocked" {
				continue
			}
			last := p.CreatedAt
			if p.LastInteractionAt != nil {
				last = *p.LastInteractionAt
			}
			limit := 90 * 24 * time.Hour
			if p.Tier == "acquaintance" {
				limit = 180 * 24 * time.Hour
			}
			if now.Sub(last) > limit {
				p.Tier = "archived"
				p.CardMode = "archived"
				p.ArchivedAt = ptr(now)
				p.ArchiveReason = "long_inactive"
				changed = true
			}
		}
		if changed {
			if err := s.vault.RebuildAcquaintances(st.People); err != nil {
				s.log.Warn("rebuild acquaintances", "err", err)
			}
		}
		return nil
	})
}

func (s *Service) tickHeartbeat() {
	s.mu.Lock()
	if !s.cfg.Heartbeat.Enabled || s.llm == nil {
		s.mu.Unlock()
		return
	}
	now := time.Now()
	dueSelf := s.earliestSelfHeartbeatLocked(now)
	dueFallback := s.fallbackAt
	// A self-scheduled heartbeat always runs, even when the fallback heartbeat
	// is paused by the no-op governor: it carries an explicit reason from her.
	if dueSelf != nil && dueSelf.DueAt.Before(dueFallback) {
		s.mu.Unlock()
		s.runHeartbeat("self", (*dueSelf).Reason)
		return
	}
	if s.paused {
		s.mu.Unlock()
		return
	}
	if now.Before(dueFallback) {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.runHeartbeat("fallback", "例行心跳（没有特别安排）")
}

func (s *Service) earliestSelfHeartbeatLocked(now time.Time) *store.Heartbeat {
	var out *store.Heartbeat
	_ = s.st.View(func(st *store.State) error {
		for i := range st.Heartbeats {
			h := &st.Heartbeats[i]
			if h.Status != "pending" || h.DueAt.After(now) {
				continue
			}
			if out == nil || h.DueAt.Before(out.DueAt) {
				out = h
			}
		}
		return nil
	})
	return out
}

func (s *Service) tickOutbox() {
	now := time.Now()
	var due []store.Outbox
	_ = s.st.View(func(st *store.State) error {
		for _, o := range st.Outbox {
			if o.Status == "queued" && !o.DueAt.After(now) {
				due = append(due, o)
			}
		}
		return nil
	})
	for _, o := range due {
		s.sendOutbox(o)
	}
}

func (s *Service) sendOutbox(o store.Outbox) {
	_ = s.st.Mutate(func(st *store.State) error {
		for i := range st.Outbox {
			if st.Outbox[i].ID == o.ID && st.Outbox[i].Status == "queued" {
				st.Outbox[i].Status = "sending"
			}
		}
		return nil
	})
	// Channel delivery is best-effort here; web messages are stored in history.
	now := nowUTC()
	_ = s.st.Mutate(func(st *store.State) error {
		msg := store.Message{ID: store.NewID("msg"), ConversationID: o.ConversationRef, Channel: o.Channel, PeopleID: o.PeopleID, Role: "assistant", Content: o.Payload, At: now, Direction: "outbound"}
		st.Messages = append(st.Messages, msg)
		for i := range st.Outbox {
			if st.Outbox[i].ID == o.ID {
				st.Outbox[i].Status = "sent"
				st.Outbox[i].SentAt = nil
				st.Outbox[i].UpdatedAt = now
			}
		}
		st.Events = append(st.Events, store.Event{ID: store.NewID("evt"), At: now, Kind: "outbox_sent", Title: "主动消息", Detail: truncate(o.Payload, 80), PeopleID: o.PeopleID})
		return nil
	})
	if s.cfg.Channels.SnowLuma.Enabled && o.Channel == "snowluma" {
		s.snowlumaSend(o.PeopleID, o.Payload)
	}
}

func (s *Service) addEvent(kind, title, detail, peopleID, activityID string) {
	_ = s.st.Mutate(func(st *store.State) error {
		s.st.AppendEvent(st, kind, title, detail, peopleID, activityID)
		return nil
	})
}

func ptr[T any](v T) *T { return &v }

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func (s *Service) promptContext() string {
	p := s.Person()
	parts := []string{
		"<identity>",
		fmt.Sprintf("你是%s（%s）。你不是任何人的助手，你是一个在过日子的人。", p.DisplayName, p.Nickname),
		"</identity>",
		"<self>",
		s.cfg.Person.Self,
		"</self>",
		"<style>",
		s.cfg.Person.Style,
		"</style>",
		"<boundaries>",
		s.cfg.Person.Boundaries,
		"</boundaries>",
	}
	return strings.Join(parts, "\n")
}

func (s *Service) refreshConfigFromEnv() {
	// LITTLY_API_KEY is resolved lazily by the llm package; nothing to do.
	_ = context.Background()
}
