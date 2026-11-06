package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/felinics/memoh/internal/littly/config"
)

func TestChatParsesContentAndToolCalls(t *testing.T) {
	var gotAuth, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if m, ok := body["model"].(string); ok {
			gotModel = m
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "deepseek-flash",
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{
				"role": "assistant", "content": "hi",
				"tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "memory_search", "arguments": `{"query":"x"}`}}},
			}}},
			"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
		})
	}))
	defer srv.Close()
	cfg := config.Default().Brain
	cfg.BaseURL = srv.URL
	cfg.APIKey = "test-key"
	cfg.Model = "deepseek-flash"
	c, err := NewDeepSeek(cfg)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Chat(context.Background(), Request{Messages: []Message{{Role: RoleUser, Content: "hello"}}, MaxTokens: 16})
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer test-key" || gotModel != "deepseek-flash" {
		t.Fatalf("auth=%q model=%q", gotAuth, gotModel)
	}
	if res.Content != "hi" || len(res.ToolCalls) != 1 || res.ToolCalls[0].Function.Name != "memory_search" {
		t.Fatalf("response: %+v", res)
	}
	if res.Usage.TotalTokens != 3 {
		t.Fatalf("usage: %+v", res.Usage)
	}
}

func TestChatRetriesServerErrors(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			http.Error(w, "temporary", http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}}})
	}))
	defer srv.Close()
	cfg := config.Default().Brain
	cfg.BaseURL = srv.URL
	cfg.APIKey = "k"
	c, _ := NewDeepSeek(cfg)
	res, err := c.Chat(context.Background(), Request{Messages: []Message{{Role: RoleUser, Content: "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Content != "ok" || n < 2 {
		t.Fatalf("content=%q attempts=%d", res.Content, n)
	}
}

func TestNewDeepSeekMissingKey(t *testing.T) {
	os.Unsetenv("LITTLY_API_KEY")
	os.Unsetenv("DEEPSEEK_API_KEY")
	cfg := config.Default().Brain
	cfg.APIKey = ""
	cfg.APIKeyEnv = "NO_SUCH_KEY_ENV"
	if _, err := NewDeepSeek(cfg); err == nil {
		t.Fatalf("expected missing key error")
	}
}

func TestExtractJSON(t *testing.T) {
	cases := []string{
		`{"a":1}`,
		`prefix {"a":{"b":"}"}} suffix`,
		`{"a":"quote \" and }"}`,
	}
	for _, in := range cases {
		js, ok := ExtractJSON(in)
		if !ok {
			t.Fatalf("no JSON in %q", in)
		}
		var v map[string]any
		if err := json.Unmarshal([]byte(js), &v); err != nil {
			t.Fatalf("bad extracted JSON %q: %v", js, err)
		}
	}
	if _, ok := ExtractJSON(strings.Repeat("no json", 3)); ok {
		t.Fatalf("expected failure")
	}
}
