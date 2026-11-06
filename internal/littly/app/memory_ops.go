package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/store"
)

func (s *Service) addMemory(m store.Memory) (store.Memory, error) {
	now := nowUTC()
	if m.ID == "" {
		m.ID = store.NewID("mem")
	}
	if m.RecordTime.IsZero() {
		m.RecordTime = now
	}
	if m.EventTime.IsZero() {
		m.EventTime = now
	}
	if m.Importance < 1 || m.Importance > 5 {
		m.Importance = 3
	}
	if m.Visibility == "" {
		m.Visibility = "public"
	}
	if m.Domain == "" {
		m.Domain = "life"
	}
	if m.Kind == "" {
		m.Kind = "episodic"
	}
	if m.Source == "" {
		m.Source = "conversation"
	}
	path, err := s.vault.WriteMemory(m)
	if err != nil {
		return m, err
	}
	m.VaultPath = path
	err = s.st.Mutate(func(st *store.State) error {
		st.Memories = append(st.Memories, m)
		s.st.AppendEvent(st, "memory", "记住："+m.Title, "", "", "")
		return nil
	})
	return m, err
}

func (s *Service) addDiary(content, mood, summary string) (store.Diary, error) {
	now := nowUTC()
	d := store.Diary{ID: store.NewID("diary"), Day: s.LocalNow().Format("2006-01-02"), Content: content, Mood: mood, Summary: summary, At: now}
	err := s.st.Mutate(func(st *store.State) error {
		st.Diaries = append(st.Diaries, d)
		s.st.AppendEvent(st, "diary", "写了一篇日记", truncate(summary, 60), "", "")
		return nil
	})
	return d, err
}

// RunDream is a manual/nightly consolidation. Without an LLM it degrades to a
// deterministic diary entry so the feature is still testable.
func (s *Service) RunDream(ctx context.Context) (store.Dream, error) {
	d := store.Dream{ID: store.NewID("dream"), StartedAt: nowUTC(), Status: "running", Stats: map[string]any{}}
	_ = s.st.Mutate(func(st *store.State) error { st.Dreams = append(st.Dreams, d); return nil })
	msgs := s.recentMessages("", 30)
	var extracted int
	if s.llm != nil && len(msgs) > 0 {
		var transcript strings.Builder
		for _, m := range msgs {
			fmt.Fprintf(&transcript, "%s: %s\n", m.Role, truncate(m.Content, 300))
		}
		system := `你在替她整理今天。只输出 JSON：{"memories":[{"domain":"life|feelings|thoughts|plans|knowledge","kind":"episodic|semantic|social|reflection","title":"不超过30字","body":"1-3句","importance":1-5,"visibility":"public|relationship|private"}],"diary":"第一人称日记，2-4句","mood":"一个词"}`
		raw, err := s.llm.Chat(ctx, llm.Request{Messages: []llm.Message{{Role: llm.RoleSystem, Content: system}, {Role: llm.RoleUser, Content: transcript.String()}}, Temperature: 0.4, MaxTokens: 900})
		if err == nil {
			var out struct {
				Memories []struct {
					Domain, Kind, Title, Body, Visibility string
					Importance                         int
				} `json:"memories"`
				Diary string `json:"diary"`
				Mood  string `json:"mood"`
			}
			if e := llm.ParseJSONInto(raw.Content, &out); e == nil {
				for _, m := range out.Memories {
					vis := m.Visibility
					if vis == "" {
						vis = "private"
					}
					_, _ = s.addMemory(store.Memory{Domain: m.Domain, Kind: m.Kind, Title: m.Title, Body: m.Body, Importance: m.Importance, Visibility: vis, Source: "dream", EventTime: nowUTC()})
					extracted++
				}
				if out.Diary != "" {
					_, _ = s.addDiary(out.Diary, out.Mood, out.Diary)
				}
			}
		}
	}
	if extracted == 0 {
		_, _ = s.addDiary("今天没什么特别的事，但我还在过自己的日子。", "平静", "平淡的一天")
	}
	ended := nowUTC()
	d.EndedAt = &ended
	d.Status = "ok"
	d.Summary = fmt.Sprintf("整理出 %d 条记忆，写了一篇日记", extracted)
	d.Stats["extracted"] = extracted
	_ = s.st.Mutate(func(st *store.State) error {
		for i := range st.Dreams {
			if st.Dreams[i].ID == d.ID {
				st.Dreams[i] = d
			}
		}
		return nil
	})
	return d, nil
}

func (s *Service) recentMessages(peopleID string, limit int) []store.Message {
	var out []store.Message
	_ = s.st.View(func(st *store.State) error {
		for i := len(st.Messages) - 1; i >= 0; i-- {
			m := st.Messages[i]
			if peopleID != "" && m.PeopleID != peopleID {
				continue
			}
			if m.Role != "user" && m.Role != "assistant" {
				continue
			}
			out = append(out, m)
			if len(out) >= limit {
				break
			}
		}
		return nil
	})
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func jsonResult(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
