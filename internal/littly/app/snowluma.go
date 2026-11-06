package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SnowLumaStatus is the minimal state exposed to the UI and health checks.
type SnowLumaStatus struct {
	Enabled   bool   `json:"enabled"`
	Connected bool   `json:"connected"`
	Account   string `json:"account"`
	WSURL     string `json:"ws_url"`
	SelfID    int64  `json:"self_id,omitempty"`
	LastError string `json:"last_error,omitempty"`
	LastEvent string `json:"last_event,omitempty"`
}

type SnowLumaClient struct {
	mu        sync.Mutex
	conn      *websocket.Conn
	writeMu   sync.Mutex
	status    SnowLumaStatus
	stop      chan struct{}
	seen      map[string]time.Time
	selfID    int64
	accountRef string
}

func (s *Service) startSnowLuma() {
	s.mu.Lock()
	cfg := s.cfg.Channels.SnowLuma
	if s.snowluma != nil || !cfg.Enabled {
		s.mu.Unlock()
		return
	}
	c := &SnowLumaClient{stop: make(chan struct{}), seen: map[string]time.Time{}, accountRef: cfg.AccountRef}
	c.status = SnowLumaStatus{Enabled: true, WSURL: cfg.WSURL, Account: cfg.AccountRef}
	s.snowluma = c
	s.mu.Unlock()
	go c.loop(s)
}

func (s *Service) stopSnowLuma() {
	s.mu.Lock()
	c := s.snowluma
	s.snowluma = nil
	s.mu.Unlock()
	if c != nil {
		close(c.stop)
		c.mu.Lock()
		if c.conn != nil {
			_ = c.conn.Close()
		}
		c.mu.Unlock()
	}
}

func (s *Service) snowLumaStatus() SnowLumaStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snowLumaStatusLocked()
}

func (s *Service) snowLumaStatusLocked() SnowLumaStatus {
	if s.snowluma == nil {
		return SnowLumaStatus{Enabled: s.cfg.Channels.SnowLuma.Enabled, WSURL: s.cfg.Channels.SnowLuma.WSURL, Account: s.cfg.Channels.SnowLuma.AccountRef}
	}
	s.snowluma.mu.Lock()
	defer s.snowluma.mu.Unlock()
	return s.snowluma.status
}

func (c *SnowLumaClient) loop(s *Service) {
	backoff := 5 * time.Second
	for {
		select {
		case <-c.stop:
			return
		default:
		}
		cfg := s.Config().Channels.SnowLuma
		u := cfg.WSURL
		if cfg.Token != "" {
			sep := "?"
			if strings.Contains(u, "?") {
				sep = "&"
			}
			u += sep + "access_token=" + url.QueryEscape(cfg.Token)
		}
		conn, _, err := websocket.DefaultDialer.Dial(u, nil)
		if err != nil {
			c.setStatus(false, err.Error())
			select {
			case <-c.stop:
				return
			case <-time.After(backoff):
			}
			if backoff < time.Minute {
				backoff *= 2
			}
			continue
		}
		c.mu.Lock()
		c.conn = conn
		c.mu.Unlock()
		c.setStatus(true, "")
		backoff = 5 * time.Second
		// Verify identity; the account must never silently switch.
		c.send(map[string]any{"action": "get_login_info", "params": map[string]any{}, "echo": "login"})
		for {
			var ev map[string]any
			if err := conn.ReadJSON(&ev); err != nil {
				break
			}
			c.handle(s, ev)
		}
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
		_ = conn.Close()
		c.setStatus(false, "disconnected")
		select {
		case <-c.stop:
			return
		case <-time.After(3 * time.Second):
		}
	}
}

func (c *SnowLumaClient) setStatus(connected bool, errText string) {
	c.mu.Lock()
	c.status.Connected = connected
	if errText != "" {
		c.status.LastError = errText
	}
	if connected {
		c.status.LastError = ""
	}
	if c.selfID != 0 {
		c.status.SelfID = c.selfID
	}
	c.mu.Unlock()
}

func (c *SnowLumaClient) send(v any) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	_ = conn.WriteJSON(v)
}

func (c *SnowLumaClient) handle(s *Service, ev map[string]any) {
	if ev["post_type"] == "meta_event" || ev["post_type"] == "notice" {
		return
	}
	if ev["post_type"] == "message_sent" {
		return
	}
	// login response
	if data, ok := ev["data"].(map[string]any); ok && ev["echo"] == "login" {
		if uid, ok := asInt64(data["user_id"]); ok {
			c.mu.Lock()
			c.selfID = uid
			c.mu.Unlock()
			c.setStatus(true, "")
			if c.accountRef != "" && c.accountRef != strconv.FormatInt(uid, 10) {
				s.log.Warn("littly: snowluma account mismatch", "want", c.accountRef, "got", uid)
				c.setStatus(false, "account_mismatch")
			}
		}
		return
	}
	if ev["post_type"] != "message" {
		return
	}
	msgType, _ := ev["message_type"].(string)
	if msgType != "private" && msgType != "group" {
		return
	}
	selfID, _ := asInt64(ev["self_id"])
	userID, ok := asInt64(ev["user_id"])
	if !ok || userID == 0 || userID == selfID {
		return
	}
	groupID, _ := asInt64(ev["group_id"])
	msgID := fmt.Sprintf("%v", ev["message_id"])
	key := fmt.Sprintf("%s:%s:%s", msgType, strconv.FormatInt(groupID, 10), msgID)
	if !c.firstSeen(key) {
		return
	}
	text, atBot := extractOneBotText(ev["message"], selfID)
	if msgType == "group" && s.Config().Channels.SnowLuma.GroupAtOnly && !atBot {
		return
	}
	if strings.TrimSpace(text) == "" {
		return
	}
	channel := "snowluma"
	ext := strconv.FormatInt(userID, 10)
	if msgType == "group" {
		ext = fmt.Sprintf("group:%d:user:%d", groupID, userID)
	}
	nick := ""
	if sender, ok := ev["sender"].(map[string]any); ok {
		nick, _ = sender["nickname"].(string)
	}
	person, err := s.EnsureContact(channel, ext, nick)
	if err != nil {
		s.log.Warn("littly: snowluma ensure contact", "err", err)
		return
	}
	c.mu.Lock()
	c.status.LastEvent = time.Now().Format(time.RFC3339)
	c.mu.Unlock()
	go func() {
		reply, err := s.HandleChat(context.Background(), text)
		if err != nil || !reply.Replied || strings.TrimSpace(reply.Reply) == "" {
			return
		}
		c.sendOneBotReply(msgType, userID, groupID, reply.Reply)
		_ = person
	}()
}

func (c *SnowLumaClient) firstSeen(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, t := range c.seen {
		if now.Sub(t) > time.Hour {
			delete(c.seen, k)
		}
	}
	if _, ok := c.seen[key]; ok {
		return false
	}
	c.seen[key] = now
	return true
}

func (c *SnowLumaClient) sendOneBotReply(msgType string, userID, groupID int64, text string) {
	if msgType == "group" {
		msg := []map[string]any{{"type": "at", "data": map[string]any{"qq": strconv.FormatInt(userID, 10)}}, {"type": "text", "data": map[string]any{"text": " " + text}}}
		c.send(map[string]any{"action": "send_group_msg", "params": map[string]any{"group_id": groupID, "message": msg}})
		return
	}
	c.send(map[string]any{"action": "send_private_msg", "params": map[string]any{"user_id": userID, "message": text}})
}

func (s *Service) snowlumaSend(peopleID, content string) {
	s.mu.Lock()
	c := s.snowluma
	cfg := s.cfg.Channels.SnowLuma
	s.mu.Unlock()
	if c == nil || !cfg.Enabled {
		return
	}
	if cfg.OwnerExternalID != "" {
		if uid, err := strconv.ParseInt(cfg.OwnerExternalID, 10, 64); err == nil {
			c.sendOneBotReply("private", uid, 0, content)
		}
	}
}

func asInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case int64:
		return x, true
	case int:
		return int64(x), true
	case string:
		n, err := strconv.ParseInt(x, 10, 64)
		return n, err == nil
	case json.Number:
		n, err := x.Int64()
		return n, err == nil
	default:
		return 0, false
	}
}

func extractOneBotText(message any, selfID int64) (text string, atBot bool) {
	switch m := message.(type) {
	case string:
		text = m
		if selfID != 0 && strings.Contains(m, fmt.Sprintf("[CQ:at,qq=%d]", selfID)) {
			atBot = true
		}
		return text, atBot
	case []any:
		var b strings.Builder
		for _, seg := range m {
			sm, ok := seg.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := sm["type"].(string)
			data, _ := sm["data"].(map[string]any)
			switch typ {
			case "text":
				if s, ok := data["text"].(string); ok {
					b.WriteString(s)
				}
			case "at":
				if q, ok := asInt64(data["qq"]); ok && q == selfID {
					atBot = true
				}
			case "image":
				b.WriteString("[图片]")
			}
		}
		return b.String(), atBot
	}
	return "", false
}
