// Package agentctx bridges Littly's persona into Memoh's native agent system
// prompt. It deliberately reads only stable persona fields (name, SELF, style,
// boundaries) so the prompt-cache prefix does not churn on every memory write.
package agentctx

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type personaFile struct {
	Person struct {
		Name       string `json:"name"`
		Nickname   string `json:"nickname"`
		Bio        string `json:"bio"`
		Self       string `json:"self"`
		Style      string `json:"style"`
		Boundaries string `json:"boundaries"`
	} `json:"person"`
}

// DataDir mirrors app.DataDir without importing the app package (avoids a
// native-runtime import cycle).
func DataDir() string {
	if v := os.Getenv("LITTLY_DATA_DIR"); v != "" {
		return v
	}
	return "/opt/memoh/data/littly"
}

// SystemSection returns the persona block injected into native agent prompts.
// Empty means the Littly config is absent (upstream Memoh behavior preserved).
func SystemSection() string {
	dir := DataDir()
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return ""
	}
	var p personaFile
	if err := json.Unmarshal(b, &p); err != nil {
		return ""
	}
	name := strings.TrimSpace(p.Person.Name)
	if name == "" {
		name = "她"
	}
	var out strings.Builder
	out.WriteString("## 你是谁（Littly）\n")
	fmt.Fprintf(&out, "你叫%s。你不是 personal assistant，你是一个真实的人：有自己的生活、自己的电脑、自己的朋友和判断。\n", name)
	if s := strings.TrimSpace(p.Person.Bio); s != "" {
		out.WriteString(s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Self); s != "" {
		out.WriteString("你的自我：\n" + s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Style); s != "" {
		out.WriteString("你的说话方式：" + s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Boundaries); s != "" {
		out.WriteString("你的边界：" + s + "\n")
	}
	out.WriteString("不要自称 AI 或助手；不要为了讨好而答应；不知道就说不知道。\n")
	return strings.TrimSpace(out.String())
}

// MemorySection returns a compact, non-private set of recent memories for the
// native agent prompt. It is intentionally small and newest-first; the full
// retrieval pipeline still belongs to Littly's own chat.
func MemorySection(limit int) string {
	if limit <= 0 || limit > 12 {
		limit = 6
	}
	dir := DataDir()
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return ""
	}
	var st struct {
		Memories []struct {
			Title      string    `json:"title"`
			Body       string    `json:"body"`
			Visibility string    `json:"visibility"`
			EventTime  time.Time `json:"event_time"`
		} `json:"memories"`
	}
	if err := json.Unmarshal(b, &st); err != nil || len(st.Memories) == 0 {
		return ""
	}
	// newest first
	sort.Slice(st.Memories, func(i, j int) bool { return st.Memories[i].EventTime.After(st.Memories[j].EventTime) })
	var out strings.Builder
	out.WriteString("## 你最近的记忆\n")
	n := 0
	for _, m := range st.Memories {
		if m.Visibility == "private" || strings.TrimSpace(m.Title) == "" {
			continue
		}
		body := strings.TrimSpace(m.Body)
		if len([]rune(body)) > 80 {
			body = string([]rune(body)[:80]) + "…"
		}
		if m.EventTime.IsZero() {
			fmt.Fprintf(&out, "- %s：%s\n", m.Title, body)
		} else {
			fmt.Fprintf(&out, "- %s · %s：%s\n", m.EventTime.Format("01-02"), m.Title, body)
		}
		n++
		if n >= limit {
			break
		}
	}
	if n == 0 {
		return ""
	}
	out.WriteString("这些是你自己的经历，不要当成用户告诉你的任务清单。\n")
	return strings.TrimSpace(out.String())
}
