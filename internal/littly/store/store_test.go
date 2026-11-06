package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenMutatePersist(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := NewID("x")
	if len(id) < 8 || id == NewID("x") {
		t.Fatalf("id not unique: %q", id)
	}
	if err := s.Mutate(func(st *State) error {
		st.Meta["hello"] = "world"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// EnsurePerson is a service concern; the store itself only persists.
	_, _ = s.EnsurePerson("owner", "小璃", "Littly", "Asia/Shanghai")
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Snapshot().Meta["hello"] != "world" {
		t.Fatalf("persistence failed: %+v", s2.Snapshot().Meta)
	}
}

func TestSchemaAndRuntimeDefaults(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	st := s.Snapshot()
	if st.Schema != SchemaVersion {
		t.Fatalf("schema=%d", st.Schema)
	}
	if st.Runtime.Energy == 0 && st.Runtime.Mood == 0 && st.Runtime.Satiety == 0 {
		t.Fatalf("runtime defaults missing: %+v", st.Runtime)
	}
	if err := s.Mutate(func(st *State) error { st.Meta["touched"] = true; return nil }); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil || len(raw) == 0 {
		t.Fatalf("state file missing: %v", err)
	}
}
