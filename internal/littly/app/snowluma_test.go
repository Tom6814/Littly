package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/felinics/memoh/internal/littly/config"
	"github.com/felinics/memoh/internal/littly/llm"
)

type configPtr = config.Config

func contextOrBackground() context.Context { return context.Background() }

func TestSnowLumaPrivateMessageAndDedupe(t *testing.T) {
	var got []string
	var gotMu sync.Mutex
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		// login response
		_ = conn.WriteJSON(map[string]any{"echo": "login", "data": map[string]any{"user_id": 10000}})
		// the same message twice, then a different one
		for _, mid := range []int{1, 1, 2} {
			_ = conn.WriteJSON(map[string]any{
				"post_type": "message", "message_type": "private", "self_id": 10000,
				"user_id": 20001, "message_id": mid, "raw_message": "你好",
				"message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "你好"}}},
				"sender":  map[string]any{"nickname": "Ann"},
			})
			time.Sleep(80 * time.Millisecond)
		}
		for {
			_, b, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg map[string]any
			_ = json.Unmarshal(b, &msg)
			if msg["action"] == "send_private_msg" {
				params, _ := msg["params"].(map[string]any)
				text, _ := params["message"].(string)
				gotMu.Lock()
				got = append(got, text)
				n := len(got)
				gotMu.Unlock()
				if n >= 2 {
					return
				}
			}
		}
	}))
	defer srv.Close()

	s := newTestService(t)
	s.SetLLM(&fakeLLM{responses: nil})
	if err := s.UpdateConfig(func(c *configPtr) {
		c.Channels.SnowLuma.Enabled = true
		c.Channels.SnowLuma.WSURL = "ws" + strings.TrimPrefix(srv.URL, "http")
		c.Channels.SnowLuma.AccountRef = "10000"
		c.Channels.SnowLuma.OwnerExternalID = "20001"
	}); err != nil {
		t.Fatalf("config: %v", err)
	}
	s.startSnowLuma()
	defer s.stopSnowLuma()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		gotMu.Lock()
		n := len(got)
		gotMu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	gotMu.Lock()
	gotCopy := append([]string(nil), got...)
	gotMu.Unlock()
	if len(gotCopy) < 2 {
		t.Fatalf("expected 2 replies (dedupe one duplicate), got %d: %v", len(gotCopy), gotCopy)
	}
	if len(gotCopy) > 2 {
		t.Fatalf("dedupe failed, got %d", len(gotCopy))
	}
}

func TestExtractOneBotText(t *testing.T) {
	if text, at := extractOneBotText("hello", 1); text != "hello" || at {
		t.Fatalf("string: %q %v", text, at)
	}
	arr := []any{
		map[string]any{"type": "text", "data": map[string]any{"text": "hi "}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "42"}},
		map[string]any{"type": "image", "data": map[string]any{"file": "x"}},
	}
	text, at := extractOneBotText(arr, 42)
	if !at || !strings.Contains(text, "[图片]") || !strings.Contains(text, "hi") {
		t.Fatalf("array: %q %v", text, at)
	}
}

func TestReplyRulesPersonality(t *testing.T) {
	s := newTestService(t)
	if err := s.UpdateConfig(func(c *configPtr) {
		c.Person.Traits["social_energy"] = 20
		c.Person.Traits["patience"] = 20
	}); err != nil {
		t.Fatal(err)
	}
	p, _ := s.EnsureContact("snowluma", "30001", "Bob")
	d := s.DecideReply(contextOrBackground(), p, "在吗")
	if d.Action != "later" && d.Action != "no_reply" {
		t.Fatalf("expected a low-energy personality to defer/ignore, got %+v", d)
	}
}

func TestSnowLumaGroupAtOnly(t *testing.T) {
	var mu sync.Mutex
	var groups []string
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(map[string]any{"echo": "login", "data": map[string]any{"user_id": 10000}})
		// group message without @ must be ignored
		_ = conn.WriteJSON(map[string]any{
			"post_type": "message", "message_type": "group", "self_id": 10000, "user_id": 20002,
			"group_id": 30001, "message_id": 10,
			"message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "群里的普通消息"}}},
			"sender":  map[string]any{"nickname": "群友"},
		})
		// group message with @ must get a reply
		_ = conn.WriteJSON(map[string]any{
			"post_type": "message", "message_type": "group", "self_id": 10000, "user_id": 20002,
			"group_id": 30001, "message_id": 11,
			"message": []any{
				map[string]any{"type": "at", "data": map[string]any{"qq": "10000"}},
				map[string]any{"type": "text", "data": map[string]any{"text": " 小璃在吗"}},
			},
			"sender": map[string]any{"nickname": "群友"},
		})
		for {
			_, b, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg map[string]any
			_ = json.Unmarshal(b, &msg)
			if msg["action"] == "send_group_msg" {
				mu.Lock()
				groups = append(groups, string(b))
				n := len(groups)
				mu.Unlock()
				if n >= 1 {
					return
				}
			}
		}
	}))
	defer srv.Close()
	s := newTestService(t)
	s.SetLLM(&fakeLLM{responses: []llm.Response{{Content: "我在。"}}})
	if err := s.UpdateConfig(func(c *configPtr) {
		c.Channels.SnowLuma.Enabled = true
		c.Channels.SnowLuma.WSURL = "ws" + strings.TrimPrefix(srv.URL, "http")
		c.Channels.SnowLuma.AccountRef = "10000"
		c.Channels.SnowLuma.GroupAtOnly = true
	}); err != nil {
		t.Fatal(err)
	}
	s.startSnowLuma()
	defer s.stopSnowLuma()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(groups)
		mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(groups) != 1 {
		t.Fatalf("expected exactly one group reply, got %d", len(groups))
	}
	if !strings.Contains(groups[0], "send_group_msg") || !strings.Contains(groups[0], "30001") {
		t.Fatalf("unexpected group reply: %s", groups[0])
	}
}
