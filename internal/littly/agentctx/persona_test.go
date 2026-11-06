package agentctx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemSectionReadsPersona(t *testing.T) {
	dir := t.TempDir()
	cfg := `{"person":{"name":"小璃","bio":"她有生活","self":"我是小璃。","style":"简短","boundaries":"不编造"}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LITTLY_DATA_DIR", dir)
	got := SystemSection()
	for _, want := range []string{"小璃", "不是 personal assistant", "我是小璃", "简短", "不编造"} {
		if !strings.Contains(got, want) {
			t.Fatalf("section missing %q:\n%s", want, got)
		}
	}
}

func TestSystemSectionMissingConfig(t *testing.T) {
	t.Setenv("LITTLY_DATA_DIR", t.TempDir())
	if got := SystemSection(); got != "" {
		t.Fatalf("expected empty section, got %q", got)
	}
}

func TestMemorySectionFiltersPrivate(t *testing.T) {
	dir := t.TempDir()
	state := `{"memories":[{"title":"公开的事","body":"今天写了笔记","visibility":"public","event_time":"2026-11-07T01:00:00Z"},{"title":"私密","body":"不想让人知道","visibility":"private","event_time":"2026-11-07T02:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LITTLY_DATA_DIR", dir)
	got := MemorySection(6)
	if !strings.Contains(got, "公开的事") || strings.Contains(got, "私密") {
		t.Fatalf("unexpected memory section:\n%s", got)
	}
}
