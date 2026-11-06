// Package llm is a tiny OpenAI-compatible chat client (DeepSeek first).
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/config"
)

type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role       Role       `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type Tool struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

type FunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type Request struct {
	Messages    []Message
	Tools       []Tool
	Temperature float64
	MaxTokens   int
}

type Response struct {
	Content   string
	ToolCalls []ToolCall
	Usage     Usage
	Model     string
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type Client interface {
	Chat(ctx context.Context, req Request) (Response, error)
	Model() string
}

type DeepSeek struct {
	baseURL string
	model   string
	apiKey  string
	http    *http.Client
	temp    float64
	maxTok  int
}

func NewDeepSeek(cfg config.Brain) (*DeepSeek, error) {
	key := cfg.APIKey
	if key == "" && cfg.APIKeyEnv != "" {
		key = os.Getenv(cfg.APIKeyEnv)
	}
	if key == "" {
		key = os.Getenv("LITTLY_API_KEY")
	}
	if key == "" {
		key = os.Getenv("DEEPSEEK_API_KEY")
	}
	if key == "" {
		return nil, ErrMissingKey
	}
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.deepseek.com"
	}
	to := cfg.TimeoutSeconds
	if to <= 0 {
		to = 90
	}
	return &DeepSeek{
		baseURL: base, model: cfg.Model, apiKey: key, temp: cfg.Temperature,
		maxTok: cfg.MaxTokens, http: &http.Client{Timeout: time.Duration(to) * time.Second},
	}, nil
}

var ErrMissingKey = errors.New("missing LLM API key (set LITTLY_API_KEY or config brain.api_key)")

func (d *DeepSeek) Model() string { return d.model }

type chatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Tools       []Tool        `json:"tools,omitempty"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream"`
}

type chatResponse struct {
	ID      string `json:"id"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int         `json:"index"`
		Message chatMessage `json:"message"`
		Reason  string      `json:"finish_reason"`
	} `json:"choices"`
	Usage Usage `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

func (d *DeepSeek) Chat(ctx context.Context, req Request) (Response, error) {
	msgs := make([]chatMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		msgs = append(msgs, chatMessage{Role: string(m.Role), Content: m.Content, ToolCalls: m.ToolCalls, ToolCallID: m.ToolCallID, Name: m.Name})
	}
	temp := req.Temperature
	if temp == 0 {
		temp = d.temp
	}
	maxTok := req.MaxTokens
	if maxTok == 0 {
		maxTok = d.maxTok
	}
	body, err := json.Marshal(chatRequest{Model: d.model, Messages: msgs, Tools: req.Tools, Temperature: temp, MaxTokens: maxTok})
	if err != nil {
		return Response{}, err
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return Response{}, ctx.Err()
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			}
		}
		httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, d.baseURL+"/chat/completions", bytes.NewReader(body))
		if err != nil {
			return Response{}, err
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+d.apiKey)
		resp, err := d.http.Do(httpReq)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("llm http %d: %s", resp.StatusCode, truncate(string(raw), 400))
			continue
		}
		if resp.StatusCode >= 400 {
			return Response{}, fmt.Errorf("llm http %d: %s", resp.StatusCode, truncate(string(raw), 400))
		}
		var cr chatResponse
		if err := json.Unmarshal(raw, &cr); err != nil {
			return Response{}, fmt.Errorf("llm decode: %w", err)
		}
		if cr.Error != nil {
			return Response{}, fmt.Errorf("llm error: %s", cr.Error.Message)
		}
		if len(cr.Choices) == 0 {
			return Response{}, fmt.Errorf("llm returned no choices")
		}
		ch := cr.Choices[0]
		out := Response{Content: ch.Message.Content, ToolCalls: ch.Message.ToolCalls, Usage: cr.Usage, Model: cr.Model}
		// Some providers return tool calls as a string in content when tools are unsupported.
		if len(out.ToolCalls) == 0 && strings.Contains(out.Content, "\"tool_calls\"") {
			// leave content as-is; callers may parse JSON decisions
		}
		return out, nil
	}
	return Response{}, fmt.Errorf("llm failed: %w", lastErr)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ExtractJSON returns the first complete JSON object in s.
func ExtractJSON(s string) (string, bool) {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return "", false
	}
	depth := 0
	inStr := false
	esc := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}

// ParseJSONInto extracts and decodes the first JSON object.
func ParseJSONInto(s string, v any) error {
	js, ok := ExtractJSON(s)
	if !ok {
		return fmt.Errorf("no JSON object in model output")
	}
	return json.Unmarshal([]byte(js), v)
}
