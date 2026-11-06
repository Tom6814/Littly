package native

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSystemSectionsIncludeLittlyPersona(t *testing.T) {
	dir := t.TempDir()
	cfg := `{"person":{"name":"小璃","self":"我是小璃。","style":"简短","boundaries":"不编造"}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	state := `{"memories":[{"title":"桥接测试记忆","body":"今天验证 prompt 注入","visibility":"public","event_time":"2026-11-07T01:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LITTLY_DATA_DIR", dir)
	sections := GenerateSystemSections(SystemPromptParams{})
	foundPersona, foundMemory := false, false
	for _, s := range sections {
		if s.ID == "system.littly_persona" {
			foundPersona = true
			if !strings.Contains(s.Text, "小璃") {
				t.Fatalf("persona section missing name: %q", s.Text)
			}
		}
		if s.ID == "system.littly_memory" {
			foundMemory = true
			if !strings.Contains(s.Text, "桥接测试记忆") {
				t.Fatalf("memory section missing memory: %q", s.Text)
			}
		}
	}
	if !foundPersona || !foundMemory {
		t.Fatalf("persona=%v memory=%v", foundPersona, foundMemory)
	}
}
