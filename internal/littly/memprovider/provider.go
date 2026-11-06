// Package memprovider wraps Memoh's default memory provider with a read-only
// bridge to Littly's own memory index (state.json). It does not replace the
// upstream provider: every write/hook still delegates, and vault results are
// merged into search/before-chat context. This is the pragmatic M3 bridge until
// the full provider contract is implemented.
package memprovider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	memprovider "github.com/felinics/memoh/internal/memory/adapters"
)

type Provider struct {
	memprovider.Provider
	statePath string
}

// Wrap returns inner unchanged when Littly's data dir/state is absent.
func Wrap(inner memprovider.Provider) memprovider.Provider {
	if inner == nil {
		return inner
	}
	p := &Provider{Provider: inner, statePath: filepath.Join(littlyDir(), "state.json")}
	if _, err := os.Stat(p.statePath); err != nil {
		return inner
	}
	return p
}

func littlyDir() string {
	if v := os.Getenv("LITTLY_DATA_DIR"); v != "" {
		return v
	}
	return "/opt/memoh/data/littly"
}

type memoryRow struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	Domain     string    `json:"domain"`
	Visibility string    `json:"visibility"`
	Importance int       `json:"importance"`
	EventTime  time.Time `json:"event_time"`
}

func (p *Provider) items(query string, limit int) []memprovider.MemoryItem {
	if limit <= 0 || limit > 10 {
		limit = 5
	}
	b, err := os.ReadFile(p.statePath)
	if err != nil {
		return nil
	}
	var st struct {
		Memories []memoryRow `json:"memories"`
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	var rows []memoryRow
	for _, m := range st.Memories {
		if m.Visibility == "private" {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(m.Title+" "+m.Body), q) {
			continue
		}
		rows = append(rows, m)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].EventTime.Equal(rows[j].EventTime) {
			return rows[i].Importance > rows[j].Importance
		}
		return rows[i].EventTime.After(rows[j].EventTime)
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]memprovider.MemoryItem, 0, len(rows))
	for _, m := range rows {
		text := m.Title
		if strings.TrimSpace(m.Body) != "" {
			text += "\n" + m.Body
		}
		out = append(out, memprovider.MemoryItem{
			ID:        "littly:" + m.ID,
			Memory:    text,
			CreatedAt: m.EventTime.Format(time.RFC3339),
			Score:     float64(m.Importance),
			Metadata:  map[string]any{"source": "littly_vault", "domain": m.Domain, "visibility": m.Visibility},
		})
	}
	return out
}

func (p *Provider) OnBeforeChat(ctx context.Context, req memprovider.BeforeChatRequest) (*memprovider.BeforeChatResult, error) {
	res, err := p.Provider.OnBeforeChat(ctx, req)
	if err != nil {
		return res, err
	}
	items := p.items(req.Query, 5)
	if len(items) == 0 {
		return res, nil
	}
	var b strings.Builder
	b.WriteString("## 她自己的记忆\n")
	for _, it := range items {
		b.WriteString("- " + strings.ReplaceAll(it.Memory, "\n", "：") + "\n")
	}
	if res == nil {
		res = &memprovider.BeforeChatResult{}
	}
	if res.ContextText != "" {
		res.ContextText = b.String() + "\n" + res.ContextText
	} else {
		res.ContextText = b.String()
	}
	res.ResultCount += len(items)
	if res.RetrievalMode == "" {
		res.RetrievalMode = "littly_bridge"
	}
	return res, nil
}

func (p *Provider) Search(ctx context.Context, req memprovider.SearchRequest) (memprovider.SearchResponse, error) {
	res, err := p.Provider.Search(ctx, req)
	if err != nil {
		return res, err
	}
	items := p.items(req.Query, req.Limit)
	if len(items) == 0 {
		return res, nil
	}
	res.Results = append(res.Results, items...)
	if res.RetrievalMode == "" {
		res.RetrievalMode = "littly_bridge"
	}
	return res, nil
}
