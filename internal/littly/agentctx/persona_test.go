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
