package app

import (
	"context"
	"fmt"

	"github.com/felinics/memoh/internal/littly/llm"
)

// runTools runs the model/tool loop and returns the final assistant text.
// capture can intercept a tool call (e.g. heartbeat_respond); returning true
// means "handled, do not execute".
func (s *Service) runTools(ctx context.Context, messages []llm.Message, tools []llm.Tool, actorID, convID string, capture func(name, args string) bool) (string, error) {
	client := s.LLM()
	if client == nil {
		return "", fmt.Errorf("no LLM configured")
	}
	maxRounds := s.cfg.Brain.MaxToolRounds
	if maxRounds <= 0 {
		maxRounds = 6
	}
	last := ""
	for round := 0; round < maxRounds; round++ {
		resp, err := client.Chat(ctx, llm.Request{Messages: messages, Tools: tools, Temperature: s.cfg.Brain.Temperature, MaxTokens: s.cfg.Brain.MaxTokens})
		if err != nil {
			return "", err
		}
		if resp.Content != "" {
			last = resp.Content
		}
		if len(resp.ToolCalls) == 0 {
			return resp.Content, nil
		}
		messages = append(messages, llm.Message{Role: llm.RoleAssistant, Content: resp.Content, ToolCalls: resp.ToolCalls})
		for _, call := range resp.ToolCalls {
			if capture != nil && capture(call.Function.Name, call.Function.Arguments) {
				messages = append(messages, llm.Message{Role: llm.RoleTool, ToolCallID: call.ID, Content: "recorded"})
				return last, nil
			}
			result, err := s.execTool(ctx, call.Function.Name, call.Function.Arguments, actorID, convID)
			if err != nil {
				result = "error: " + err.Error()
			}
			messages = append(messages, llm.Message{Role: llm.RoleTool, ToolCallID: call.ID, Content: result})
		}
	}
	if last != "" {
		return last, nil
	}
	return "", fmt.Errorf("tool loop exceeded without final content")
}

func (s *Service) chatHistory(peopleID string, limit int) []llm.Message {
	msgs := s.recentMessages(peopleID, limit)
	out := make([]llm.Message, 0, len(msgs))
	for _, m := range msgs {
		role := llm.RoleUser
		if m.Role == "assistant" {
			role = llm.RoleAssistant
		}
		out = append(out, llm.Message{Role: role, Content: m.Content})
	}
	return out
}
