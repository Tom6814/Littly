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

	"github.com/felinics/memoh/internal/littly/memoryapi"
	memprovider "github.com/felinics/memoh/internal/memory/adapters"
	"github.com/felinics/memoh/internal/mcp"
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
	return &Provider{Provider: inner, statePath: filepath.Join(littlyDir(), "state.json")}
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
	if b := p.backend(); b != nil {
		hits, err := b.Search(ctx, req.Query, 5)
		if err != nil {
			return nil, err
		}
		if len(hits) == 0 {
			return &memprovider.BeforeChatResult{RetrievalMode: "littly_backend"}, nil
		}
		var sb strings.Builder
		sb.WriteString("## 她自己的记忆\n")
		for _, h := range hits {
			sb.WriteString("- " + strings.ReplaceAll(h.Title+"："+h.Body, "\n", " ") + "\n")
		}
		return &memprovider.BeforeChatResult{ContextText: sb.String(), RetrievalMode: "littly_backend", ResultCount: len(hits)}, nil
	}
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
	if p.backend() != nil {
		return p.SearchBackend(ctx, req.Query, req.Limit)
	}
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


func (p *Provider) backend() memoryapi.Backend { return memoryapi.Get() }

func hitsToItems(hits []memoryapi.Hit) []memprovider.MemoryItem {
	out := make([]memprovider.MemoryItem, 0, len(hits))
	for _, h := range hits {
		text := h.Title
		if strings.TrimSpace(h.Body) != "" {
			text += "\n" + h.Body
		}
		out = append(out, memprovider.MemoryItem{
			ID:        h.ID,
			Memory:    text,
			CreatedAt: h.EventTime.Format(time.RFC3339),
			Score:     float64(h.Importance),
			Metadata:  map[string]any{"source": "littly_vault", "domain": h.Domain, "visibility": h.Visibility},
		})
	}
	return out
}

func (p *Provider) OnAfterChat(ctx context.Context, req memprovider.AfterChatRequest) error {
	if p.backend() != nil {
		// Littly's own chat pipeline owns memory formation; do not duplicate
		// writes into the upstream builtin store.
		return nil
	}
	return p.Provider.OnAfterChat(ctx, req)
}

func (p *Provider) Add(ctx context.Context, req memprovider.AddRequest) (memprovider.SearchResponse, error) {
	if b := p.backend(); b != nil {
		text := strings.TrimSpace(req.Message)
		if text == "" && len(req.Messages) > 0 {
			var parts []string
			for _, m := range req.Messages {
				if strings.TrimSpace(m.Content) != "" {
					parts = append(parts, m.Content)
				}
			}
			text = strings.Join(parts, "\n")
		}
		hit, err := b.Add(ctx, "", text)
		if err != nil {
			return memprovider.SearchResponse{}, err
		}
		return memprovider.SearchResponse{Results: hitsToItems([]memoryapi.Hit{hit}), RetrievalMode: "littly_backend"}, nil
	}
	return p.Provider.Add(ctx, req)
}

func (p *Provider) GetBackendSearch(ctx context.Context, query string, limit int) (memprovider.SearchResponse, bool) {
	b := p.backend()
	if b == nil {
		return memprovider.SearchResponse{}, false
	}
	hits, err := b.Search(ctx, query, limit)
	if err != nil {
		return memprovider.SearchResponse{}, false
	}
	return memprovider.SearchResponse{Results: hitsToItems(hits), RetrievalMode: "littly_backend"}, true
}

func (p *Provider) SearchBackend(ctx context.Context, query string, limit int) (memprovider.SearchResponse, error) {
	if b := p.backend(); b != nil {
		hits, err := b.Search(ctx, query, limit)
		if err != nil {
			return memprovider.SearchResponse{}, err
		}
		return memprovider.SearchResponse{Results: hitsToItems(hits), RetrievalMode: "littly_backend"}, nil
	}
	return p.Provider.Search(ctx, memprovider.SearchRequest{Query: query, Limit: limit})
}

func (p *Provider) GetAll(ctx context.Context, req memprovider.GetAllRequest) (memprovider.SearchResponse, error) {
	if b := p.backend(); b != nil {
		hits, err := b.List(ctx, req.Limit)
		if err != nil {
			return memprovider.SearchResponse{}, err
		}
		return memprovider.SearchResponse{Results: hitsToItems(hits), RetrievalMode: "littly_backend"}, nil
	}
	return p.Provider.GetAll(ctx, req)
}

func (p *Provider) Update(ctx context.Context, req memprovider.UpdateRequest) (memprovider.MemoryItem, error) {
	if b := p.backend(); b != nil {
		title, body := splitTitleBody(req.Memory)
		hit, err := b.Update(ctx, req.MemoryID, title, body)
		if err != nil {
			return memprovider.MemoryItem{}, err
		}
		return hitsToItems([]memoryapi.Hit{hit})[0], nil
	}
	return p.Provider.Update(ctx, req)
}

func (p *Provider) Delete(ctx context.Context, botID, memoryID string) (memprovider.DeleteResponse, error) {
	if b := p.backend(); b != nil {
		if err := b.Delete(ctx, memoryID); err != nil {
			return memprovider.DeleteResponse{}, err
		}
		return memprovider.DeleteResponse{Message: "deleted"}, nil
	}
	return p.Provider.Delete(ctx, botID, memoryID)
}

func (p *Provider) DeleteBatch(ctx context.Context, botID string, memoryIDs []string) (memprovider.DeleteResponse, error) {
	if b := p.backend(); b != nil {
		for _, id := range memoryIDs {
			_ = b.Delete(ctx, id)
		}
		return memprovider.DeleteResponse{Message: "deleted"}, nil
	}
	return p.Provider.DeleteBatch(ctx, botID, memoryIDs)
}

func (p *Provider) DeleteAll(ctx context.Context, req memprovider.DeleteAllRequest) (memprovider.DeleteResponse, error) {
	if b := p.backend(); b != nil {
		hits, _ := b.List(ctx, 10000)
		for _, h := range hits {
			_ = b.Delete(ctx, h.ID)
		}
		return memprovider.DeleteResponse{Message: "deleted all"}, nil
	}
	return p.Provider.DeleteAll(ctx, req)
}

func (p *Provider) Compact(ctx context.Context, filters map[string]any, ratio float64, decayDays int) (memprovider.CompactResult, error) {
	if b := p.backend(); b != nil {
		hits, _ := b.List(ctx, 10000)
		return memprovider.CompactResult{BeforeCount: len(hits), AfterCount: len(hits), Ratio: 1}, nil
	}
	return p.Provider.Compact(ctx, filters, ratio, decayDays)
}

func (p *Provider) Usage(ctx context.Context, filters map[string]any) (memprovider.UsageResponse, error) {
	if b := p.backend(); b != nil {
		hits, _ := b.List(ctx, 10000)
		var bytes int64
		for _, h := range hits {
			bytes += int64(len(h.Title) + len(h.Body))
		}
		return memprovider.UsageResponse{Count: len(hits), TotalTextBytes: bytes}, nil
	}
	return p.Provider.Usage(ctx, filters)
}

func (p *Provider) CallTool(ctx context.Context, session mcp.ToolSessionContext, toolName string, arguments map[string]any) (map[string]any, error) {
	b := p.backend()
	if b == nil {
		return p.Provider.CallTool(ctx, session, toolName, arguments)
	}
	str := func(k string) string { if v, ok := arguments[k].(string); ok { return v }; return "" }
	switch toolName {
	case memprovider.ToolSearchMemory:
		hits, err := b.Search(ctx, str("query"), 8)
		if err != nil { return nil, err }
		return map[string]any{"results": hitsToItems(hits)}, nil
	case memprovider.ToolCreateMemory:
		title, body := splitTitleBody(strings.TrimSpace(str("memory") + "\n" + str("text")))
		h, err := b.Add(ctx, title, body)
		if err != nil { return nil, err }
		return map[string]any{"id": h.ID, "memory": h.Title}, nil
	case memprovider.ToolUpdateMemory:
		title, body := splitTitleBody(str("memory"))
		h, err := b.Update(ctx, str("memory_id"), title, body)
		if err != nil { return nil, err }
		return map[string]any{"id": h.ID}, nil
	case memprovider.ToolDeleteMemory:
		if err := b.Delete(ctx, str("memory_id")); err != nil { return nil, err }
		return map[string]any{"deleted": true}, nil
	}
	return p.Provider.CallTool(ctx, session, toolName, arguments)
}

func splitTitleBody(s string) (string, string) {
	s = strings.TrimSpace(s)
	if s == "" { return "", "" }
	lines := strings.SplitN(s, "\n", 2)
	title := strings.TrimSpace(lines[0])
	if len([]rune(title)) > 40 { title = string([]rune(title)[:40]) }
	body := s
	return title, body
}
