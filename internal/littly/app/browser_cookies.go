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

type BrowserCookie struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Domain string `json:"domain"`
	Path   string `json:"path"`
	Secure bool   `json:"secure"`
}

// SetBrowserCookies writes login cookies into the persistent browser profile.
func (s *Service) SetBrowserCookies(ctx context.Context, cookies []BrowserCookie) (int, error) {
	base := strings.TrimRight(s.cfg.Workbench.BrowserURL, "/")
	if base == "" {
		return 0, fmt.Errorf("browser is not configured")
	}
	c, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, http.MethodPut, base+"/json/new?about:blank", nil)
	req.Host = "localhost"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("browser unavailable: %w", err)
	}
	defer resp.Body.Close()
	var target cdpTarget
	if err := json.NewDecoder(resp.Body).Decode(&target); err != nil {
		return 0, err
	}
	baseURL, _ := url.Parse(base)
	dialAddr := baseURL.Host
	if !strings.Contains(dialAddr, ":") {
		dialAddr += ":9222"
	}
	parts, _ := url.Parse(target.WebSocketDebuggerURL)
	wsURL := "ws://localhost:9223" + parts.Path
	dialer := websocket.Dialer{NetDialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", dialAddr)
	}}
	ws, _, err := dialer.DialContext(c, wsURL, nil)
	if err != nil {
		return 0, err
	}
	cdp := &cdpConn{conn: ws}
	defer ws.Close()
	defer func() {
		r, _ := http.NewRequest(http.MethodGet, base+"/json/close/"+target.ID, nil)
		r.Host = "localhost"
		_, _ = http.DefaultClient.Do(r)
	}()
	if _, err := cdp.call("Network.enable", nil); err != nil {
		return 0, err
	}
	n := 0
	for _, ck := range cookies {
		if strings.TrimSpace(ck.Name) == "" || ck.Domain == "" {
			continue
		}
		path := ck.Path
		if path == "" {
			path = "/"
		}
		params := map[string]any{"name": ck.Name, "value": ck.Value, "domain": ck.Domain, "path": path, "secure": ck.Secure}
		if _, err := cdp.call("Network.setCookie", params); err == nil {
			n++
		}
	}
	return n, nil
}

// ParseCookieHeader turns a browser cookie header into domain-scoped cookies.
func ParseCookieHeader(domain, header string) []BrowserCookie {
	out := make([]BrowserCookie, 0)
	for _, part := range strings.Split(header, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 || strings.TrimSpace(kv[0]) == "" {
			continue
		}
		out = append(out, BrowserCookie{Name: strings.TrimSpace(kv[0]), Value: strings.TrimSpace(kv[1]), Domain: domain, Path: "/", Secure: true})
	}
	return out
}
