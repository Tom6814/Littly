package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/memoryapi"
	"github.com/felinics/memoh/internal/littly/store"
)

// Memory* methods implement memoryapi.Backend so Memoh's default memory
// provider can read/write the same memories the UI and her chat use.
func (s *Service) MemorySearch(ctx context.Context, query string, limit int) ([]memoryapi.Hit, error) {
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	mems := s.retrieveMemories(query, "owner", limit)
	return toHits(mems), nil
}

func (s *Service) MemoryAdd(ctx context.Context, title, body string) (memoryapi.Hit, error) {
	title = strings.TrimSpace(title)
	body = strings.TrimSpace(body)
	if title == "" {
		title = truncate(body, 30)
	}
	if body == "" {
		return memoryapi.Hit{}, fmt.Errorf("empty memory")
	}
	m, err := s.addMemory(store.Memory{Domain: "knowledge", Kind: "episodic", Title: title, Body: body, Importance: 3, Visibility: "public", Source: "memoh_agent", EventTime: nowUTC()})
	if err != nil {
		return memoryapi.Hit{}, err
	}
	return toHit(m), nil
}

func (s *Service) MemoryUpdate(ctx context.Context, id, title, body string) (memoryapi.Hit, error) {
	id = strings.TrimPrefix(id, "littly:")
	var out store.Memory
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.Memories {
			m := &st.Memories[i]
			if m.ID != id {
				continue
			}
			if strings.TrimSpace(title) != "" {
				m.Title = title
			}
			if strings.TrimSpace(body) != "" {
				m.Body = body
			}
			m.RecordTime = nowUTC()
			out = *m
			return nil
		}
		return fmt.Errorf("memory not found")
	})
	if err != nil {
		return memoryapi.Hit{}, err
	}
	_, _ = s.vault.WriteMemory(out)
	return toHit(out), nil
}

func (s *Service) MemoryDelete(ctx context.Context, id string) error {
	id = strings.TrimPrefix(id, "littly:")
	var vaultPath string
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.Memories {
			if st.Memories[i].ID == id {
				vaultPath = st.Memories[i].VaultPath
				st.Memories = append(st.Memories[:i], st.Memories[i+1:]...)
				s.st.AppendEvent(st, "memory", "忘记一条记忆", id, "", "")
				return nil
			}
		}
		return fmt.Errorf("memory not found")
	})
	if err != nil {
		return err
	}
	if vaultPath != "" {
		_ = os.Remove(filepath.Join(s.vault.Dir(), filepath.FromSlash(vaultPath)))
	}
	return nil
}

func (s *Service) MemoryList(ctx context.Context, limit int) ([]memoryapi.Hit, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	st := s.st.Snapshot()
	out := make([]store.Memory, 0, len(st.Memories))
	for _, m := range st.Memories {
		if m.Visibility == "private" {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EventTime.After(out[j].EventTime) })
	if len(out) > limit {
		out = out[:limit]
	}
	return toHits(out), nil
}

func toHits(ms []store.Memory) []memoryapi.Hit {
	out := make([]memoryapi.Hit, 0, len(ms))
	for _, m := range ms {
		out = append(out, toHit(m))
	}
	return out
}

func toHit(m store.Memory) memoryapi.Hit {
	return memoryapi.Hit{ID: "littly:" + m.ID, Title: m.Title, Body: m.Body, Domain: m.Domain, Visibility: m.Visibility, Importance: m.Importance, EventTime: m.EventTime}
}

// TouchMemoryTime keeps the import used when builds trim methods.
var _ = time.Now

type memoryBackend struct{ s *Service }

func (b memoryBackend) Search(ctx context.Context, query string, limit int) ([]memoryapi.Hit, error) {
	return b.s.MemorySearch(ctx, query, limit)
}
func (b memoryBackend) Add(ctx context.Context, title, body string) (memoryapi.Hit, error) {
	return b.s.MemoryAdd(ctx, title, body)
}
func (b memoryBackend) Update(ctx context.Context, id, title, body string) (memoryapi.Hit, error) {
	return b.s.MemoryUpdate(ctx, id, title, body)
}
func (b memoryBackend) Delete(ctx context.Context, id string) error {
	return b.s.MemoryDelete(ctx, id)
}
func (b memoryBackend) List(ctx context.Context, limit int) ([]memoryapi.Hit, error) {
	return b.s.MemoryList(ctx, limit)
}
