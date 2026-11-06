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
	t.Setenv("LITTLY_DATA_DIR", dir)
	sections := GenerateSystemSections(SystemPromptParams{})
	found := false
	for _, s := range sections {
		if s.ID == "system.littly_persona" {
			found = true
			if !strings.Contains(s.Text, "小璃") {
				t.Fatalf("persona section missing name: %q", s.Text)
			}
		}
	}
	if !found {
		t.Fatalf("system.littly_persona not injected")
	}
}
