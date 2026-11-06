package memprovider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/felinics/memoh/internal/littly/memoryapi"
	memprovider "github.com/felinics/memoh/internal/memory/adapters"
)

func TestItemsFiltersPrivateAndSearches(t *testing.T) {
	dir := t.TempDir()
	state := `{"memories":[
		{"id":"m1","title":"公开记忆","body":"关于心跳","visibility":"public","importance":4,"event_time":"2026-11-07T01:00:00Z"},
		{"id":"m2","title":"私密记忆","body":"关于心跳","visibility":"private","importance":5,"event_time":"2026-11-07T02:00:00Z"}
	]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Provider{statePath: filepath.Join(dir, "state.json")}
	items := p.items("心跳", 5)
	if len(items) != 1 || items[0].ID != "littly:m1" {
		t.Fatalf("unexpected items: %+v", items)
	}
	if len(p.items("不存在", 5)) != 0 {
		t.Fatalf("query should not match")
	}
}

func TestWrapReturnsInnerWithoutState(t *testing.T) {
	t.Setenv("LITTLY_DATA_DIR", t.TempDir())
	var inner fakeProvider
	if Wrap(&inner) == nil {
		t.Fatalf("wrap returned nil")
	}
}

func TestOnBeforeChatMergesVaultContext(t *testing.T) {
	dir := t.TempDir()
	state := `{"memories":[{"id":"m1","title":"公开记忆","body":"关于心跳","visibility":"public","importance":4,"event_time":"2026-11-07T01:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Provider: &fakeProvider{}, statePath: filepath.Join(dir, "state.json")}
	res, err := p.OnBeforeChat(context.Background(), memprovider.BeforeChatRequest{Query: "心跳"})
	if err != nil {
		t.Fatal(err)
	}
	if res == nil || !strings.Contains(res.ContextText, "公开记忆") {
		t.Fatalf("vault context missing: %+v", res)
	}
	if res.ResultCount < 1 {
		t.Fatalf("result count = %d", res.ResultCount)
	}
}

type fakeBackend struct{ items []memoryapi.Hit }

func (f *fakeBackend) Search(ctx context.Context, query string, limit int) ([]memoryapi.Hit, error) {
	return f.items, nil
}
func (f *fakeBackend) Add(ctx context.Context, title, body string) (memoryapi.Hit, error) {
	h := memoryapi.Hit{ID: "littly:new", Title: title, Body: body}
	f.items = append(f.items, h)
	return h, nil
}
func (f *fakeBackend) Update(ctx context.Context, id, title, body string) (memoryapi.Hit, error) {
	return memoryapi.Hit{ID: id, Title: title, Body: body}, nil
}
func (f *fakeBackend) Delete(ctx context.Context, id string) error { return nil }
func (f *fakeBackend) List(ctx context.Context, limit int) ([]memoryapi.Hit, error) {
	return f.items, nil
}

func TestBackendReadWrite(t *testing.T) {
	fb := &fakeBackend{items: []memoryapi.Hit{{ID: "littly:m1", Title: "后端记忆", Body: "来自 state", Importance: 4}}}
	memoryapi.Set(fb)
	defer memoryapi.Set(nil)
	p := &Provider{Provider: &fakeProvider{}, statePath: filepath.Join(t.TempDir(), "missing.json")}
	res, err := p.Search(context.Background(), memprovider.SearchRequest{Query: "后端", Limit: 5})
	if err != nil || len(res.Results) != 1 || res.Results[0].Memory == "" {
		t.Fatalf("search=%+v err=%v", res, err)
	}
	added, err := p.Add(context.Background(), memprovider.AddRequest{Message: "新增记忆"})
	if err != nil || len(added.Results) != 1 {
		t.Fatalf("add=%+v err=%v", added, err)
	}
	before, err := p.OnBeforeChat(context.Background(), memprovider.BeforeChatRequest{Query: "后端"})
	if err != nil || before == nil || !strings.Contains(before.ContextText, "后端记忆") {
		t.Fatalf("before=%+v err=%v", before, err)
	}
}
