// Package store owns durable state for a single Littly instance.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Store struct {
	mu   sync.Mutex
	dir  string
	path string
	data State
}

func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, fmt.Errorf("data dir is required")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, path: filepath.Join(dir, "state.json")}
	b, err := os.ReadFile(s.path)
	switch {
	case err == nil:
		if err := json.Unmarshal(b, &s.data); err != nil {
			return nil, fmt.Errorf("load state: %w", err)
		}
	case os.IsNotExist(err):
		s.data = State{Schema: SchemaVersion, Meta: map[string]any{}}
		s.data.Runtime = RuntimeState{Energy: 60, Mood: 60, SocialNeed: 40, Satiety: 60, LastTickAt: time.Now().UTC()}
	default:
		return nil, err
	}
	if s.data.Schema == 0 {
		s.data.Schema = SchemaVersion
	}
	return s, nil
}

func (s *Store) Dir() string { return s.dir }

func (s *Store) View(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn(&s.data)
}

func (s *Store) Mutate(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := fn(&s.data); err != nil {
		return err
	}
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(&s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// NewID returns a time-sortable id with a prefix.
func NewID(prefix string) string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + time.Now().UTC().Format("20060102150405") + "_" + hex.EncodeToString(b[:])
}

func (s *Store) Person() Person {
	var p Person
	_ = s.View(func(st *State) error {
		if st.Person != nil {
			p = *st.Person
		}
		return nil
	})
	return p
}

func (s *Store) EnsurePerson(id, name, nickname, tz string) (Person, error) {
	var out Person
	err := s.Mutate(func(st *State) error {
		if st.Person != nil {
			out = *st.Person
			return nil
		}
		now := time.Now().UTC()
		p := Person{
			ID: id, DisplayName: name, Nickname: nickname, Timezone: tz,
			Channel: "web", ExternalID: "owner", Tier: "intimate", Relationship: "owner",
			Closeness: 100, Important: true, Brief: "我自己", CardMode: "full",
			CreatedAt: now, UpdatedAt: now,
		}
		st.Person = &p
		st.People = append(st.People, p)
		out = p
		return nil
	})
	return out, err
}

func (s *Store) FindPersonByChannel(channel, externalID string) (Person, bool) {
	var out Person
	found := false
	_ = s.View(func(st *State) error {
		for _, p := range st.People {
			if p.Channel == channel && p.ExternalID == externalID {
				out, found = p, true
				return nil
			}
		}
		return nil
	})
	return out, found
}

func (s *Store) GetPerson(id string) (Person, bool) {
	var out Person
	found := false
	_ = s.View(func(st *State) error {
		for _, p := range st.People {
			if p.ID == id {
				out, found = p, true
				return nil
			}
		}
		return nil
	})
	return out, found
}

func (s *Store) UpdatePerson(id string, fn func(*Person)) error {
	return s.Mutate(func(st *State) error {
		for i := range st.People {
			if st.People[i].ID == id {
				fn(&st.People[i])
				st.People[i].UpdatedAt = time.Now().UTC()
				return nil
			}
		}
		return fmt.Errorf("person %s not found", id)
	})
}

func (s *Store) MessagesFor(peopleID string, limit int) []Message {
	var out []Message
	_ = s.View(func(st *State) error {
		for i := len(st.Messages) - 1; i >= 0; i-- {
			if st.Messages[i].PeopleID == peopleID {
				out = append(out, st.Messages[i])
				if limit > 0 && len(out) >= limit {
					break
				}
			}
		}
		return nil
	})
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func (s *Store) AppendEvent(st *State, kind, title, detail, peopleID, activityID string) {
	st.Events = append(st.Events, Event{
		ID: NewID("evt"), At: time.Now().UTC(), Kind: kind, Title: title,
		Detail: detail, PeopleID: peopleID, ActivityID: activityID,
	})
	if len(st.Events) > 2000 {
		st.Events = st.Events[len(st.Events)-2000:]
	}
}

func (s *Store) Snapshot() State {
	var out State
	_ = s.View(func(st *State) error {
		b, _ := json.Marshal(st)
		_ = json.Unmarshal(b, &out)
		return nil
	})
	return out
}

func SortedMemories(mem []Memory) []Memory {
	out := append([]Memory(nil), mem...)
	sort.Slice(out, func(i, j int) bool { return out[i].EventTime.After(out[j].EventTime) })
	return out
}
