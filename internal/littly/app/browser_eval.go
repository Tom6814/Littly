package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// BrowserEval opens a URL in her persistent headless browser and evaluates a
// script in the page context. This runs with her own login cookies, so the AI
// can read/post/update her own accounts without asking the user.
func (s *Service) BrowserEval(ctx context.Context, rawURL, script string, screenshot bool) (map[string]any, error) {
	rawURL = strings.TrimSpace(rawURL)
	script = strings.TrimSpace(script)
	if rawURL == "" || script == "" {
		return nil, fmt.Errorf("url and script are required")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("only http(s) urls are allowed")
	}
	base := strings.TrimRight(s.cfg.Workbench.BrowserURL, "/")
	if base == "" {
		return nil, fmt.Errorf("browser is not configured")
	}
	c, cancel := context.WithTimeout(ctx, 45*time.Second)
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
	baseURL, _ := url.Parse(base)
	dialAddr := baseURL.Host
	if !strings.Contains(dialAddr, ":") {
		dialAddr += ":9222"
	}
	parts, _ := url.Parse(target.WebSocketDebuggerURL)
	wsURL := "ws://localhost:9223" + parts.Path
	if parts != nil && parts.RawQuery != "" {
		wsURL += "?" + parts.RawQuery
	}
	dialer := websocket.Dialer{NetDialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", dialAddr)
	}}
	ws, _, err := dialer.DialContext(c, wsURL, nil)
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
	// Give SPAs time to boot and restore cookies.
	time.Sleep(2500 * time.Millisecond)
	wrapped := "(async () => { " + script + " })()"
	res, err := cdp.call("Runtime.evaluate", map[string]any{"expression": wrapped, "awaitPromise": true, "returnByValue": true})
	if err != nil {
		return nil, err
	}
	var ev struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	_ = json.Unmarshal(res, &ev)
	if ev.ExceptionDetails != nil {
		return nil, fmt.Errorf("script error: %s", ev.ExceptionDetails.Text)
	}
	out := map[string]any{"url": rawURL, "result": ev.Result.Value}
	title, _ := cdp.call("Runtime.evaluate", map[string]any{"expression": "document.title", "returnByValue": true})
	out["title_raw"] = string(title)
	if screenshot {
		shot, err := cdp.call("Page.captureScreenshot", map[string]any{"format": "png"})
		if err == nil {
			var img struct{ Data string `json:"data"` }
			if json.Unmarshal(shot, &img) == nil && img.Data != "" {
				out["screenshot_base64_len"] = len(img.Data)
			}
		}
	}
	return out, nil
}
