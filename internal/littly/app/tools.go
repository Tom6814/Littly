package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/store"
)

func schema(props map[string]any, required ...string) map[string]any {
	req := make([]any, 0, len(required))
	for _, r := range required {
		req = append(req, r)
	}
	return map[string]any{"type": "object", "properties": props, "required": req, "additionalProperties": false}
}

func pString(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func pInt(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func (s *Service) toolSpecs() []llm.Tool {
	t := func(name, desc string, params map[string]any) llm.Tool {
		return llm.Tool{Type: "function", Function: llm.FunctionDef{Name: name, Description: desc, Parameters: params}}
	}
	return []llm.Tool{
		t("memory_search", "在她自己的记忆里搜索", schema(map[string]any{"query": pString("关键词/问题"), "limit": pInt("最多几条")}, "query")),
		t("memory_write", "把一件事记进她的记忆", schema(map[string]any{
			"title": pString("不超过30字的标题"), "body": pString("1-3句正文"), "domain": pString("life|feelings|thoughts|plans|knowledge|routines"),
			"importance": pInt("1-5"), "visibility": pString("public|relationship|private"),
		}, "title", "body")),
		t("recall_person", "在人物/回收站里搜索某个人（名字、别名、事件）", schema(map[string]any{"query": pString("名字或事件关键词"), "limit": pInt("最多几个候选")}, "query")),
		t("restore_person", "确认身份后，把回收站里的人恢复到 acquaintance", schema(map[string]any{"people_id": pString("recall_person 返回的 id")}, "people_id")),
		t("heartbeat_after", "安排下一次心跳（例如继续写东西前定一个）", schema(map[string]any{"minutes": pInt("1-480 分钟"), "reason": pString("为什么要在那个时间醒（必填）")}, "minutes", "reason")),
		t("heartbeat_at", "安排某个时刻的心跳", schema(map[string]any{"time": pString("RFC3339 时间，例如 2026-11-07T07:30:00+08:00"), "reason": pString("为什么（必填）")}, "time", "reason")),
		t("heartbeat_respond", "每次心跳结束必须调用：结构化裁决", schema(map[string]any{
			"outcome": pString("living|progress|done|blocked|resting|needs_attention|noop"),
			"notify":  map[string]any{"type": "boolean", "description": "是否给主人发一条消息"},
			"summary": pString("这次心跳做了什么"),
			"next": map[string]any{"type": "object", "properties": map[string]any{"in_minutes": pInt("多久后"), "reason": pString("理由")}},
		}, "outcome", "summary")),
		t("file_list", "看工作台里的文件", schema(map[string]any{"path": pString("相对路径，默认 .")})),
		t("file_read", "读工作台文件", schema(map[string]any{"path": pString("相对路径")}, "path")),
		t("file_write", "写文件到工作台（她的产出）", schema(map[string]any{"path": pString("相对路径，例如 home/notes/x.md"), "content": pString("内容")}, "path", "content")),
		t("activity_start", "开始做一件自己的事", schema(map[string]any{"kind": pString("learn|research|organize|write|create|maintain|social|rest"), "title": pString("做什么"), "detail": pString("可选的计划")}, "kind", "title")),
		t("activity_finish", "结束当前活动", schema(map[string]any{"id": pString("活动 id（可空=当前）"), "summary": pString("结果"), "progress": pInt("0-100")})),
		t("web_fetch", "抓取一个网页（只读文本）", schema(map[string]any{"url": pString("https URL")}, "url")),
	}
}

func (s *Service) execTool(ctx context.Context, name, args, actorID, convID string) (string, error) {
	var in map[string]any
	if args != "" {
		if err := json.Unmarshal([]byte(args), &in); err != nil {
			return "", fmt.Errorf("bad tool arguments: %w", err)
		}
	}
	str := func(k string) string {
		if v, ok := in[k].(string); ok {
			return v
		}
		return ""
	}
	integer := func(k string) int {
		if v, ok := in[k].(float64); ok {
			return int(v)
		}
		return 0
	}
	switch name {
	case "memory_search":
		mems := s.retrieveMemories(str("query"), actorID, integer("limit"))
		type item struct {
			ID, Title, Body, Domain string
			Importance              int
		}
		var out []item
		for _, m := range mems {
			out = append(out, item{m.ID, m.Title, m.Body, m.Domain, m.Importance})
		}
		return jsonResult(out), nil
	case "memory_write":
		m, err := s.addMemory(store.Memory{
			Domain: str("domain"), Kind: "episodic", Title: str("title"), Body: str("body"),
			Importance: integer("importance"), Visibility: str("visibility"), Source: "conversation",
			PeopleIDs: []string{actorID}, EventTime: nowUTC(),
		})
		if err != nil {
			return "", err
		}
		return jsonResult(map[string]string{"id": m.ID, "path": m.VaultPath}), nil
	case "recall_person":
		return jsonResult(s.Recall(str("query"), integer("limit"))), nil
	case "restore_person":
		p, err := s.Restore(str("people_id"))
		if err != nil {
			return "", err
		}
		return jsonResult(map[string]any{"restored": true, "tier": p.Tier, "name": p.DisplayName}), nil
	case "heartbeat_after":
		reason := strings.TrimSpace(str("reason"))
		if len([]rune(reason)) < 5 {
			return "", fmt.Errorf("reason is required (>=5 chars)")
		}
		minutes := integer("minutes")
		if minutes < 1 || minutes > 480 {
			minutes = 20
		}
		if err := s.scheduleSelfHeartbeat(time.Duration(minutes)*time.Minute, reason); err != nil {
			return "", err
		}
		return jsonResult(map[string]any{"ok": true, "in_minutes": minutes, "reason": reason}), nil
	case "heartbeat_at":
		reason := strings.TrimSpace(str("reason"))
		if len([]rune(reason)) < 5 {
			return "", fmt.Errorf("reason is required (>=5 chars)")
		}
		t, err := time.Parse(time.RFC3339, str("time"))
		if err != nil {
			return "", fmt.Errorf("bad time: %w", err)
		}
		if time.Until(t) > 8*time.Hour || time.Until(t) <= 0 {
			return "", fmt.Errorf("heartbeat_at must be within 8 hours and in the future")
		}
		if err := s.scheduleSelfHeartbeatAt(t, reason); err != nil {
			return "", err
		}
		return jsonResult(map[string]any{"ok": true, "at": t.Format(time.RFC3339), "reason": reason}), nil
	case "heartbeat_respond":
		return "recorded", nil
	case "file_list":
		return s.toolFileList(str("path"))
	case "file_read":
		return s.toolFileRead(str("path"))
	case "file_write":
		return s.toolFileWrite(str("path"), str("content"))
	case "activity_start":
		return s.toolActivityStart(str("kind"), str("title"), str("detail"))
	case "activity_finish":
		return s.toolActivityFinish(str("id"), str("summary"), integer("progress"))
	case "web_fetch":
		return s.toolWebFetch(ctx, str("url"))
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
}

func (s *Service) workspacePath(rel string) (string, error) {
	root := s.cfg.Workbench.Dir
	if rel == "" {
		rel = "."
	}
	if filepath.IsAbs(rel) {
		return "", fmt.Errorf("absolute paths are not allowed")
	}
	if strings.Contains(rel, "..") || strings.ContainsRune(rel, 0) {
		return "", fmt.Errorf("path denied")
	}
	clean := path.Clean("/" + rel)
	if strings.Contains(clean, "..") {
		return "", fmt.Errorf("path denied")
	}
	full := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	relCheck, err := filepath.Rel(root, full)
	if err != nil || strings.HasPrefix(relCheck, "..") {
		return "", fmt.Errorf("path denied")
	}
	return full, nil
}

func (s *Service) toolFileList(rel string) (string, error) {
	full, err := s.workspacePath(rel)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		return "", err
	}
	type item struct {
		Name string `json:"name"`
		Dir  bool   `json:"dir"`
		Size int64  `json:"size,omitempty"`
	}
	var out []item
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		info, _ := e.Info()
		size := int64(0)
		if info != nil {
			size = info.Size()
		}
		out = append(out, item{e.Name(), e.IsDir(), size})
	}
	return jsonResult(out), nil
}

func (s *Service) toolFileRead(rel string) (string, error) {
	full, err := s.workspacePath(rel)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	if int64(len(b)) > s.cfg.Workbench.MaxFileBytes {
		b = b[:s.cfg.Workbench.MaxFileBytes]
	}
	return string(b), nil
}

func (s *Service) toolFileWrite(rel, content string) (string, error) {
	full, err := s.workspacePath(rel)
	if err != nil {
		return "", err
	}
	if int64(len(content)) > s.cfg.Workbench.MaxFileBytes {
		return "", fmt.Errorf("file too large")
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return "", err
	}
	relSlash := filepath.ToSlash(strings.TrimPrefix(full, s.cfg.Workbench.Dir+string(os.PathSeparator)))
	art := store.Artifact{ID: store.NewID("art"), Kind: "file", Title: filepath.Base(full), Path: relSlash, Mime: mimeOf(full), Bytes: int64(len(content)), CreatedAt: nowUTC()}
	_ = s.st.Mutate(func(st *store.State) error {
		if rt := st.Runtime.CurrentActivityID; rt != "" {
			art.ActivityID = rt
			for i := range st.Activities {
				if st.Activities[i].ID == rt {
					st.Activities[i].ArtifactIDs = append(st.Activities[i].ArtifactIDs, art.ID)
				}
			}
		}
		st.Artifacts = append(st.Artifacts, art)
		st.Events = append(st.Events, store.Event{ID: store.NewID("evt"), At: nowUTC(), Kind: "artifact", Title: "写了 " + art.Title, Detail: relSlash, ActivityID: art.ActivityID})
		return nil
	})
	return jsonResult(map[string]any{"path": relSlash, "bytes": len(content), "artifact_id": art.ID}), nil
}

func (s *Service) toolActivityStart(kind, title, detail string) (string, error) {
	if kind == "" {
		kind = "write"
	}
	if title == "" {
		return "", fmt.Errorf("title required")
	}
	now := nowUTC()
	a := store.Activity{ID: store.NewID("act"), Kind: kind, Title: title, Detail: detail, Status: "running", Progress: 5, StartedAt: &now, CreatedAt: now, UpdatedAt: now}
	err := s.st.Mutate(func(st *store.State) error {
		// pause any other running activity
		for i := range st.Activities {
			if st.Activities[i].Status == "running" {
				st.Activities[i].Status = "paused"
			}
		}
		st.Activities = append(st.Activities, a)
		st.Runtime.CurrentActivityID = a.ID
		st.Runtime.Attention = "正在" + title
		s.st.AppendEvent(st, "activity", "开始："+title, "", "", a.ID)
		return nil
	})
	if err != nil {
		return "", err
	}
	return jsonResult(map[string]string{"activity_id": a.ID}), nil
}

func (s *Service) toolActivityFinish(id, summary string, progress int) (string, error) {
	now := nowUTC()
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.Activities {
			a := &st.Activities[i]
			if (id != "" && a.ID == id) || (id == "" && a.ID == st.Runtime.CurrentActivityID) {
				a.Status = "done"
				a.Progress = 100
				if progress > 0 {
					a.Progress = progress
				}
				a.Summary = summary
				a.EndedAt = &now
				a.UpdatedAt = now
				if st.Runtime.CurrentActivityID == a.ID {
					st.Runtime.CurrentActivityID = ""
					st.Runtime.Attention = ""
				}
				s.st.AppendEvent(st, "activity", "完成："+a.Title, summary, "", a.ID)
				return nil
			}
		}
		return fmt.Errorf("activity not found")
	})
	if err != nil {
		return "", err
	}
	return jsonResult(map[string]string{"ok": "done"}), nil
}

func (s *Service) toolWebFetch(ctx context.Context, rawurl string) (string, error) {
	if !s.cfg.Workbench.AllowNetwork {
		return "", fmt.Errorf("network is disabled")
	}
	if !strings.HasPrefix(rawurl, "http://") && !strings.HasPrefix(rawurl, "https://") {
		return "", fmt.Errorf("only http(s) urls are allowed")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawurl, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200<<10))
	return fmt.Sprintf("status=%d content-type=%s\n<untrusted_external_data>\n%s\n</untrusted_external_data>", resp.StatusCode, resp.Header.Get("Content-Type"), string(b)), nil
}

func mimeOf(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".md":
		return "text/markdown"
	case ".json":
		return "application/json"
	case ".html":
		return "text/html"
	case ".css":
		return "text/css"
	case ".js":
		return "text/javascript"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	default:
		return "text/plain"
	}
}
