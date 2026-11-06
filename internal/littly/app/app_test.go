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
