package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/felinics/memoh/internal/littly/config"
	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/store"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("LITTLY_DATA_DIR", dir)
	t.Setenv("LITTLY_CONFIG", "")
	t.Setenv("LITTLY_API_KEY", "")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s, err := New(log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

type fakeLLM struct {
	responses []llm.Response
	idx       int
}

func (f *fakeLLM) Chat(ctx context.Context, req llm.Request) (llm.Response, error) {
	if f.idx >= len(f.responses) {
		return llm.Response{Content: "嗯。"}, nil
	}
	r := f.responses[f.idx]
	f.idx++
	return r, nil
}
func (f *fakeLLM) Model() string { return "fake" }

func TestChatFallsBackWithoutLLM(t *testing.T) {
	s := newTestService(t)
	res, err := s.HandleChat(context.Background(), "你好")
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if !res.Replied || res.Reply == "" {
		t.Fatalf("expected fallback reply, got %+v", res)
	}
	msgs := s.recentMessages("owner", 10)
	if len(msgs) != 2 || msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("unexpected messages: %+v", msgs)
	}
}

func TestPeopleArchiveRecallRestore(t *testing.T) {
	s := newTestService(t)
	p, err := s.EnsureContact("snowluma", "10001", "Ann")
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	for i := 0; i < 3; i++ {
		p, err = s.TouchInteraction(p.ID)
		if err != nil {
			t.Fatalf("touch: %v", err)
		}
	}
	if p.Tier != TierAcquaintance {
		t.Fatalf("tier = %s, want acquaintance", p.Tier)
	}
	if err := s.Archive(p.ID, "test"); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got, _ := s.st.GetPerson(p.ID); got.Tier != TierArchived {
		t.Fatalf("tier after archive = %s", got.Tier)
	}
	cands := s.Recall("Ann", 5)
	if len(cands) == 0 || cands[0].PersonID != p.ID {
		t.Fatalf("recall missed archived person: %+v", cands)
	}
	restored, err := s.Restore(p.ID)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if restored.Tier != TierAcquaintance {
		t.Fatalf("restored tier = %s", restored.Tier)
	}
}

func TestMemoryVisibility(t *testing.T) {
	s := newTestService(t)
	p, _ := s.EnsureContact("web", "owner", "owner")
	public, err := s.addMemory(store.Memory{Domain: "life", Title: "公开经历", Body: "今天写了笔记", Visibility: "public", Importance: 3, EventTime: time.Now()})
	if err != nil {
		t.Fatalf("add public: %v", err)
	}
	priv, err := s.addMemory(store.Memory{Domain: "feelings", Title: "私密", Body: "不想让人知道", Visibility: "private", Importance: 5, EventTime: time.Now()})
	if err != nil {
		t.Fatalf("add private: %v", err)
	}
	got := s.retrieveMemories("笔记", p.ID, 10)
	foundPublic := false
	for _, m := range got {
		if m.ID == public.ID {
			foundPublic = true
		}
		if m.ID == priv.ID {
			t.Fatalf("private memory leaked into retrieval")
		}
	}
	if !foundPublic {
		t.Fatalf("public memory missing from retrieval: %+v", got)
	}
}

func TestHeartbeatStructuredVerdict(t *testing.T) {
	s := newTestService(t)
	var tc llm.ToolCall
	tc.ID = "1"
	tc.Type = "function"
	tc.Function.Name = "heartbeat_respond"
	tc.Function.Arguments = `{"outcome":"resting","notify":false,"summary":"发了会儿呆"}`
	s.SetLLM(&fakeLLM{responses: []llm.Response{{ToolCalls: []llm.ToolCall{tc}}}})
	s.runHeartbeat("fallback", "测试心跳")
	st := s.st.Snapshot()
	if len(st.HeartbeatRuns) != 1 {
		t.Fatalf("heartbeat runs = %d", len(st.HeartbeatRuns))
	}
	run := st.HeartbeatRuns[0]
	if run.Outcome != "resting" || run.Summary != "发了会儿呆" {
		t.Fatalf("unexpected run: %+v", run)
	}
	if st.Runtime.NoopStreak != 1 {
		t.Fatalf("noop streak = %d", st.Runtime.NoopStreak)
	}
}

func TestHeartbeatAfterRequiresReason(t *testing.T) {
	s := newTestService(t)
	_, err := s.execTool(context.Background(), "heartbeat_after", `{"minutes":20,"reason":""}`, "owner", "web:owner")
	if err == nil {
		t.Fatalf("expected reason validation error")
	}
	if _, err := s.execTool(context.Background(), "heartbeat_after", `{"minutes":20,"reason":"写完这段再醒"}`, "owner", "web:owner"); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	st := s.st.Snapshot()
	if len(st.Heartbeats) != 1 || st.Heartbeats[0].Status != "pending" {
		t.Fatalf("heartbeat not persisted: %+v", st.Heartbeats)
	}
}

func TestFileToolsStayInWorkspace(t *testing.T) {
	s := newTestService(t)
	if _, err := s.execTool(context.Background(), "file_write", `{"path":"../escape.txt","content":"x"}`, "owner", ""); err == nil {
		t.Fatalf("expected path denial")
	}
	out, err := s.execTool(context.Background(), "file_write", `{"path":"home/notes/a.md","content":"hello"}`, "owner", "")
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if !strings.Contains(out, "artifact_id") {
		t.Fatalf("expected artifact: %s", out)
	}
	got, err := s.execTool(context.Background(), "file_read", `{"path":"home/notes/a.md"}`, "owner", "")
	if err != nil || got != "hello" {
		t.Fatalf("read = %q err=%v", got, err)
	}
}

func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LITTLY_DATA_DIR", dir)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s1, err := New(log)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s1.addMemory(store.Memory{Domain: "life", Title: "持久化", Body: "会留下", Visibility: "public", EventTime: time.Now()})
	s2, err := New(log)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if got := s2.st.Snapshot(); len(got.Memories) != 1 {
		t.Fatalf("memories after reopen = %d", len(got.Memories))
	}
}

func TestHTTPBootstrapAndChat(t *testing.T) {
	s := newTestService(t)
	s.SetLLM(&fakeLLM{responses: []llm.Response{{Content: "我在呢。"}}})
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/littly/api/bootstrap", nil)
	e.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("bootstrap status %d: %s", rec.Code, rec.Body.String())
	}
	var boot map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &boot); err != nil {
		t.Fatalf("bootstrap json: %v", err)
	}
	if boot["person"] == nil {
		t.Fatalf("missing person: %v", boot)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/littly/api/chat", strings.NewReader(`{"content":"在吗"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("chat status %d: %s", rec.Code, rec.Body.String())
	}
	var out ChatResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("chat json: %v", err)
	}
	if !out.Replied {
		t.Fatalf("chat did not reply: %+v", out)
	}
}

func TestSettingsUpdateReflectedInBootstrap(t *testing.T) {
	s := newTestService(t)
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/littly/api/config", strings.NewReader(`{"style":"新的说话方式"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("put config status %d: %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/littly/api/bootstrap", nil))
	var boot map[string]map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &boot); err != nil {
		t.Fatalf("bootstrap decode: %v", err)
	}
	if got, _ := boot["person"]["style"].(string); got != "新的说话方式" {
		t.Fatalf("style = %q", got)
	}
}

func TestRunSoloActivityLeavesArtifact(t *testing.T) {
	s := newTestService(t)
	a, err := s.RunSoloActivity(context.Background())
	if err != nil {
		t.Fatalf("activity: %v", err)
	}
	if a.Status != "done" || a.Title == "" {
		t.Fatalf("unexpected activity: %+v", a)
	}
	st := s.st.Snapshot()
	if len(st.Artifacts) == 0 {
		t.Fatalf("expected an artifact")
	}
	found := false
	for _, x := range st.Artifacts {
		if strings.Contains(x.Path, "home/notes/") {
			found = true
		}
	}
	if !found {
		t.Fatalf("artifact not under home/notes: %+v", st.Artifacts)
	}
}

func TestLifeTickDueRules(t *testing.T) {
	s := newTestService(t)
	loc := time.FixedZone("CST", 8*3600)
	noon := time.Date(2026, 11, 7, 12, 0, 0, 0, loc)
	if !s.autoActivityDue(noon) {
		t.Fatalf("expected a solo activity when no activity has run")
	}
	if s.autoActivityDue(time.Date(2026, 11, 7, 2, 0, 0, 0, loc)) {
		t.Fatalf("must not auto-run at night")
	}
	if _, err := s.RunSoloActivity(context.Background()); err != nil {
		t.Fatal(err)
	}
	_ = s.st.Mutate(func(st *store.State) error {
		for i := range st.Activities {
			st.Activities[i].CreatedAt = noon.Add(-time.Hour)
		}
		return nil
	})
	if s.autoActivityDue(noon) {
		t.Fatalf("must not auto-run again within 3h")
	}
	// Dream is only due in its configured hour, once per day.
	s.cfg.Memory.DreamHour = 3
	three := time.Date(2026, 11, 8, 3, 1, 0, 0, loc)
	if !s.dreamDue(three) {
		t.Fatalf("expected dream to be due at 03:01")
	}
	now := three.UTC()
	_ = s.st.Mutate(func(st *store.State) error {
		st.Dreams = append(st.Dreams, store.Dream{ID: "d1", StartedAt: now, Status: "ok"})
		return nil
	})
	if s.dreamDue(three) {
		t.Fatalf("dream must not run twice on the same local day")
	}
}

func TestTerminalToolGatedAndRuns(t *testing.T) {
	s := newTestService(t)
	if _, err := s.execTool(context.Background(), "terminal_exec", `{"command":"echo hi"}`, "owner", ""); err == nil {
		t.Fatalf("expected shell disabled error")
	}
	if err := s.UpdateConfig(func(c *config.Config) { c.Workbench.AllowShell = true }); err != nil {
		t.Fatal(err)
	}
	out, err := s.execTool(context.Background(), "terminal_exec", `{"command":"echo hello-terminal"}`, "owner", "")
	if err != nil {
		t.Fatalf("terminal: %v", err)
	}
	if !strings.Contains(out, "hello-terminal") {
		t.Fatalf("output = %q", out)
	}
}

func TestPingModel(t *testing.T) {
	s := newTestService(t)
	s.SetLLM(&fakeLLM{responses: []llm.Response{{Content: " ok "}}})
	res, err := s.PingModel(context.Background())
	if err != nil {
		t.Fatalf("ping: %v", err)
	}
	if res["reply"] != "ok" || res["ok"] != true {
		t.Fatalf("unexpected ping result: %+v", res)
	}
}

func TestBrowserRejectsNonHTTP(t *testing.T) {
	s := newTestService(t)
	if _, err := s.Browse(context.Background(), "file:///etc/passwd", false); err == nil {
		t.Fatalf("expected non-http url rejection")
	}
}

func TestRawFileServesInsideWorkspace(t *testing.T) {
	s := newTestService(t)
	if _, err := s.toolFileWrite("home/notes/a.txt", "hello"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/littly/api/files/raw?path=home/notes/a.txt", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hello") {
		t.Fatalf("raw file = %d %q", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/littly/api/files/raw?path=../etc/passwd", nil))
	if rec.Code == 200 {
		t.Fatalf("traversal must not be served")
	}
}

func TestAPIEndToEnd(t *testing.T) {
	s := newTestService(t)
	s.SetLLM(&fakeLLM{responses: []llm.Response{{Content: "我在。"}}})
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()

	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		var r *http.Request
		if body == "" {
			r = httptest.NewRequest(method, path, nil)
		} else {
			r = httptest.NewRequest(method, path, strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, r)
		return rec
	}
	want := func(code int, rec *httptest.ResponseRecorder, what string) {
		t.Helper()
		if rec.Code != code {
			t.Fatalf("%s: status %d body=%s", what, rec.Code, rec.Body.String())
		}
	}

	want(200, do("GET", "/littly/api/bootstrap", ""), "bootstrap")
	want(200, do("GET", "/littly/api/health", ""), "health")
	want(200, do("POST", "/littly/api/chat", `{"content":"你好"}`), "chat")
	want(200, do("GET", "/littly/api/today", ""), "today")
	want(200, do("PUT", "/littly/api/config", `{"allow_shell":true,"name":"小璃"}`), "config")
	want(200, do("POST", "/littly/api/terminal", `{"command":"echo e2e-terminal"}`), "terminal")
	want(200, do("POST", "/littly/api/test-model", ""), "test-model")
	want(200, do("POST", "/littly/api/activities/run", ""), "activity")
	want(200, do("GET", "/littly/api/activities", ""), "activities")
	want(200, do("GET", "/littly/api/artifacts", ""), "artifacts")
	if _, err := s.EnsureContact("snowluma", "90001", "E2E"); err != nil {
		t.Fatal(err)
	}
	want(200, do("GET", "/littly/api/people", ""), "people")
	want(200, do("GET", "/littly/api/memories", ""), "memories")
	want(200, do("GET", "/littly/api/heartbeat", ""), "heartbeat")
	want(200, do("POST", "/littly/api/heartbeat", `{"action":"schedule","minutes":20,"reason":"回归测试里安排一次"}`), "heartbeat schedule")
	want(200, do("GET", "/littly/api/world", ""), "world")
	want(200, do("PUT", "/littly/api/files/content", `{"path":"home/e2e.md","content":"hello e2e"}`), "file write")
	want(200, do("GET", "/littly/api/files?path=home", ""), "file list")
	want(200, do("GET", "/littly/api/files/content?path=home/e2e.md", ""), "file content")
	want(200, do("GET", "/littly/api/files/raw?path=home/e2e.md", ""), "file raw")
	want(200, do("GET", "/littly/api/events", ""), "events")
	want(200, do("GET", "/littly/api/archive?q=E2E", ""), "archive")
}

func TestDiariesAPI(t *testing.T) {
	s := newTestService(t)
	_ = s.st.Mutate(func(st *store.State) error {
		st.Diaries = append(st.Diaries, store.Diary{ID: "d1", Day: "2026-11-07", Content: "今天写了心跳。", Mood: "平静", At: time.Now().UTC()})
		return nil
	})
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/littly/api/diaries", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "今天写了心跳") {
		t.Fatalf("diaries = %d %s", rec.Code, rec.Body.String())
	}
}

func TestCreatePersonAndMemoryAPIs(t *testing.T) {
	s := newTestService(t)
	h := NewHandler(s)
	e := echo.New()
	h.Register(e)
	defer s.Stop()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/littly/api/people", strings.NewReader(`{"name":"阿岚","channel":"manual"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("create person = %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/littly/api/memories", strings.NewReader(`{"title":"新记忆","body":"手动写的一条","domain":"life","importance":3,"visibility":"public"}`))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("create memory = %d %s", rec.Code, rec.Body.String())
	}
	st := s.st.Snapshot()
	if len(st.People) < 2 || len(st.Memories) < 1 {
		t.Fatalf("people=%d memories=%d", len(st.People), len(st.Memories))
	}
}
