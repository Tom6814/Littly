package memprovider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
