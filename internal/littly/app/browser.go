package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/felinics/memoh/internal/littly/store"
)

type cdpConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
	id   int
}

type cdpTarget struct {
	ID                   string `json:"id"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// Browse opens a URL in her headless Chrome, returns page text and optionally
// saves a screenshot artifact under home/browser.
func (s *Service) Browse(ctx context.Context, rawURL string, screenshot bool) (map[string]any, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return nil, fmt.Errorf("url is required")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("only http(s) urls are allowed")
	}
	base := strings.TrimRight(s.cfg.Workbench.BrowserURL, "/")
	if base == "" {
		return nil, fmt.Errorf("browser is not configured")
	}
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodPut, base+"/json/new?"+url.QueryEscape(rawURL), nil)
	req.Host = "localhost"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("browser unavailable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("browser new target: HTTP %d", resp.StatusCode)
	}
	var target cdpTarget
	if err := json.NewDecoder(resp.Body).Decode(&target); err != nil {
		return nil, err
	}
	if target.WebSocketDebuggerURL == "" {
		return nil, fmt.Errorf("browser target missing ws url")
	}
	// Chrome rejects non-localhost Host headers. Keep the handshake Host as
	// localhost but dial the sidecar container through a custom net.Dialer.
	baseURL, _ := url.Parse(base)
	parts, err := url.Parse(target.WebSocketDebuggerURL)
	if err != nil {
		return nil, err
	}
	dialAddr := baseURL.Host
	if !strings.Contains(dialAddr, ":") {
		dialAddr += ":9222"
	}
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", dialAddr)
		},
	}
	wsURL := target.WebSocketDebuggerURL
	if parts.Path != "" {
		wsURL = "ws://localhost:9223" + parts.Path
		if parts.RawQuery != "" {
			wsURL += "?" + parts.RawQuery
		}
	}
	ws, resp, err := dialer.DialContext(c, wsURL, nil)
	if err != nil && resp != nil {
		return nil, fmt.Errorf("browser dial: %w (HTTP %d)", err, resp.StatusCode)
	}
	if err != nil {
		return nil, fmt.Errorf("browser dial: %w", err)
	}
	cdp := &cdpConn{conn: ws}
	defer ws.Close()
	defer func() {
		closeReq, _ := http.NewRequest(http.MethodGet, base+"/json/close/"+target.ID, nil)
		closeReq.Host = "localhost"
		_, _ = http.DefaultClient.Do(closeReq)
	}()
	if _, err := cdp.call("Page.enable", nil); err != nil {
		return nil, err
	}
	if _, err := cdp.call("Page.navigate", map[string]any{"url": rawURL}); err != nil {
		return nil, err
	}
	// Wait for load, bounded.
	for i := 0; i < 20; i++ {
		time.Sleep(200 * time.Millisecond)
		if i < 3 {
			continue
		}
		var ready map[string]any
		res, err := cdp.call("Runtime.evaluate", map[string]any{"expression": "document.readyState", "returnByValue": true})
		if err == nil && json.Unmarshal(res, &ready) == nil {
			break
		}
	}
	textRes, err := cdp.call("Runtime.evaluate", map[string]any{
		"expression":    "({title:document.title, text:document.body?document.body.innerText:''})",
		"returnByValue": true,
	})
	if err != nil {
		return nil, err
	}
	var ev struct {
		Result struct {
			Value struct {
				Title string `json:"title"`
				Text  string `json:"text"`
			} `json:"value"`
		} `json:"result"`
	}
	_ = json.Unmarshal(textRes, &ev)
	text := ev.Result.Value.Text
	if len([]rune(text)) > 20000 {
		text = string([]rune(text)[:20000]) + "…"
	}
	out := map[string]any{"url": rawURL, "title": ev.Result.Value.Title, "text": text}
	if screenshot {
		shot, err := cdp.call("Page.captureScreenshot", map[string]any{"format": "png"})
		if err != nil {
			return out, err
		}
		var img struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(shot, &img); err != nil || img.Data == "" {
			return out, fmt.Errorf("empty screenshot")
		}
		png, err := base64.StdEncoding.DecodeString(img.Data)
		if err != nil {
			return out, err
		}
		rel := path.Join("home", "browser", time.Now().Format("20060102-150405")+".png")
		clean := path.Clean("/" + rel)
		full := s.cfg.Workbench.Dir + clean
		if err := os.MkdirAll(path.Dir(full), 0o755); err != nil {
			return out, err
		}
		if err := os.WriteFile(full, png, 0o644); err != nil {
			return out, err
		}
		art := store.Artifact{ID: store.NewID("art"), Kind: "screenshot", Title: "网页截图：" + ev.Result.Value.Title, Path: rel, Bytes: int64(len(png)), CreatedAt: nowUTC()}
		_ = s.st.Mutate(func(st *store.State) error {
			st.Artifacts = append(st.Artifacts, art)
			s.st.AppendEvent(st, "browser", "截了一张网页", rawURL, "", "")
			return nil
		})
		out["screenshot"] = rel
		out["artifact_id"] = art.ID
	}
	return out, nil
}

func (c *cdpConn) call(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	id := c.id
	msg := map[string]any{"id": id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	if err := c.conn.WriteJSON(msg); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		_ = c.conn.SetReadDeadline(deadline)
		var raw json.RawMessage
		if err := c.conn.ReadJSON(&raw); err != nil {
			return nil, err
		}
		var env struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		if env.ID != id {
			continue // event
		}
		if env.Error != nil {
			return nil, fmt.Errorf("cdp: %s", env.Error.Message)
		}
		return env.Result, nil
	}
}

func (s *Service) BrowserStatus(ctx context.Context) map[string]any {
	base := strings.TrimRight(s.cfg.Workbench.BrowserURL, "/")
	out := map[string]any{"url": base, "ok": false}
	if base == "" {
		return out
	}
	c, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodGet, base+"/json/version", nil)
	req.Host = "localhost"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	out["ok"] = resp.StatusCode == 200
	out["version"] = string(b)
	return out
}
