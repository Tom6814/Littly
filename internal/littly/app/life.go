package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/store"
)

type soloPlan struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Note  string `json:"note"`
}

// RunSoloActivity gives her an empty block of her own time. With an LLM she
// chooses a small activity and writes a first-person note; without one the
// engine falls back to a deterministic tidy-up note. Always leaves an activity
// row and an artifact under home/notes.
func (s *Service) RunSoloActivity(ctx context.Context) (store.Activity, error) {
	if cur := s.currentRunningActivity(); cur != nil {
		return *cur, nil
	}
	plan := s.planSolo(ctx)
	now := nowUTC()
	a := store.Activity{ID: store.NewID("act"), Kind: plan.Kind, Title: plan.Title, Detail: "她自己的时间", Status: "running", Progress: 10, StartedAt: &now, CreatedAt: now, UpdatedAt: now}
	if err := s.st.Mutate(func(st *store.State) error {
		st.Activities = append(st.Activities, a)
		st.Runtime.CurrentActivityID = a.ID
		st.Runtime.Attention = "正在" + plan.Title
		s.st.AppendEvent(st, "activity", "开始："+plan.Title, "", "", a.ID)
		return nil
	}); err != nil {
		return a, err
	}
	path := filepath.Join("home", "notes", time.Now().Format("20060102-150405")+"-"+slug(plan.Title)+".md")
	content := "# " + plan.Title + "\n\n" + strings.TrimSpace(plan.Note) + "\n"
	if _, err := s.toolFileWrite(path, content); err != nil {
		_ = s.finishActivity(a.ID, "写笔记失败："+err.Error(), 100)
		return a, err
	}
	_ = s.finishActivity(a.ID, plan.Note, 100)
	_, _ = s.addMemory(store.Memory{
		Domain: "life", Kind: "episodic", Title: plan.Title, Body: truncate(plan.Note, 400),
		Importance: 2, Visibility: "public", Source: "activity", EventTime: now,
	})
	st := s.st.Snapshot()
	for _, x := range st.Activities {
		if x.ID == a.ID {
			return x, nil
		}
	}
	return a, nil
}

func (s *Service) currentRunningActivity() *store.Activity {
	var out *store.Activity
	_ = s.st.View(func(st *store.State) error {
		for i := range st.Activities {
			if st.Activities[i].Status == "running" || st.Activities[i].Status == "paused" {
				out = &st.Activities[i]
				return nil
			}
		}
		return nil
	})
	return out
}

func (s *Service) finishActivity(id, summary string, progress int) error {
	now := nowUTC()
	return s.st.Mutate(func(st *store.State) error {
		for i := range st.Activities {
			a := &st.Activities[i]
			if a.ID != id {
				continue
			}
			a.Status = "done"
			a.Progress = progress
			a.Summary = truncate(summary, 400)
			a.EndedAt = &now
			a.UpdatedAt = now
			if st.Runtime.CurrentActivityID == id {
				st.Runtime.CurrentActivityID = ""
				st.Runtime.Attention = ""
			}
			s.st.AppendEvent(st, "activity", "完成："+a.Title, truncate(summary, 80), "", id)
			return nil
		}
		return fmt.Errorf("activity not found")
	})
}

func (s *Service) planSolo(ctx context.Context) soloPlan {
	if s.LLM() != nil {
		system := `你在过自己的时间，不是回复谁。决定做一件小事，并写一段第一人称的小笔记。
只输出 JSON：{"kind":"write|learn|research|organize|create|maintain","title":"不超过20字","note":"3-6句，第一人称，像日记/笔记"}`
		user := "最近的记忆：" + s.recentMemoryTitles(8) + "\n状态：" + s.stateText()
		raw, err := s.LLM().Chat(ctx, llm.Request{Messages: []llm.Message{{Role: llm.RoleSystem, Content: system}, {Role: llm.RoleUser, Content: user}}, Temperature: 0.8, MaxTokens: 500})
		if err == nil {
			var p soloPlan
			if llm.ParseJSONInto(raw.Content, &p) == nil && p.Title != "" && p.Note != "" {
				if p.Kind == "" {
					p.Kind = "write"
				}
				return p
			}
		}
	}
	titles := s.recentMemoryTitles(3)
	note := "今天没什么人找我，我翻了翻自己的记忆。"
	if titles != "" {
		note += "最近记着：" + titles + "。"
	}
	note += "\n把这些先收一收，等想清楚了再接着写。"
	return soloPlan{Kind: "write", Title: "整理最近的想法", Note: note}
}

func (s *Service) recentMemoryTitles(n int) string {
	st := s.st.Snapshot()
	var out []string
	for i := len(st.Memories) - 1; i >= 0 && len(out) < n; i-- {
		if st.Memories[i].Visibility == "private" {
			continue
		}
		out = append(out, st.Memories[i].Title)
	}
	return strings.Join(out, "；")
}

func slug(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > 16 {
		r = r[:16]
	}
	out := make([]rune, 0, len(r))
	for _, c := range r {
		if c == ' ' || c == '/' || c == '\\' || c == ':' {
			continue
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return "note"
	}
	return string(out)
}

var _ = json.Marshal
var _ = os.Getenv
