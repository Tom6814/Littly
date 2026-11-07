package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/llm"
	"github.com/felinics/memoh/internal/littly/store"
)

type ChatResult struct {
	Reply       string     `json:"reply"`
	Replied     bool       `json:"replied"`
	Action      string     `json:"action"`
	Reason      string     `json:"reason"`
	ScheduledAt *time.Time `json:"scheduled_at,omitempty"`
}

func (s *Service) HandleChat(ctx context.Context, content string) (ChatResult, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return ChatResult{}, fmt.Errorf("empty message")
	}
	owner := s.Person()
	convID := "web:owner"
	now := nowUTC()
	_ = s.st.Mutate(func(st *store.State) error {
		st.Messages = append(st.Messages, store.Message{ID: store.NewID("msg"), ConversationID: convID, Channel: "web", PeopleID: owner.ID, Role: "user", Content: content, At: now, Direction: "inbound"})
		return nil
	})
	owner, _ = s.TouchInteraction(owner.ID)
	decision := s.DecideReply(ctx, owner, content)
	decisionID := store.NewID("rd")
	_ = s.st.Mutate(func(st *store.State) error {
		st.ReplyDecisions = append(st.ReplyDecisions, store.ReplyDecision{
			ID: decisionID, PeopleID: owner.ID, Channel: "web", InboundRef: "", ReceivedAt: now,
			Factors: map[string]any{"traits": s.cfg.Person.Traits, "action": decision.Action, "delay": decision.DelaySeconds},
			Action:  decision.Action, Reason: decision.Reason, DecidedAt: nowUTC(),
		})
		return nil
	})
	if decision.Action == "no_reply" {
		_ = s.st.Mutate(func(st *store.State) error {
			st.Runtime.Mood = clamp(st.Runtime.Mood-1, 0, 100)
			s.st.AppendEvent(st, "reply", "没有回消息", decision.Reason, owner.ID, "")
			return nil
		})
		return ChatResult{Replied: false, Action: decision.Action, Reason: decision.Reason}, nil
	}
	reply, err := s.generateReply(ctx, owner, content)
	if err != nil {
		return ChatResult{}, err
	}
	due := now
	var scheduled *time.Time
	if decision.Action == "later" || decision.Action == "explain_later" {
		d := decision.DelaySeconds
		if d <= 0 {
			d = 600
		}
		due = now.Add(time.Duration(d) * time.Second)
		scheduled = &due
	}
	if scheduled != nil {
		_ = s.st.Mutate(func(st *store.State) error {
			st.Outbox = append(st.Outbox, store.Outbox{ID: store.NewID("ob"), Kind: "reply", Channel: "web", PeopleID: owner.ID, ConversationRef: convID, DecisionID: decisionID, DueAt: due, Status: "queued", Payload: reply, RefType: "message", RefID: "", CreatedAt: now, UpdatedAt: now})
			s.st.AppendEvent(st, "reply", "稍后回复", decision.Reason, owner.ID, "")
			return nil
		})
		return ChatResult{Reply: "", Replied: false, Action: decision.Action, Reason: decision.Reason, ScheduledAt: scheduled}, nil
	}
	_ = s.st.Mutate(func(st *store.State) error {
		st.Messages = append(st.Messages, store.Message{ID: store.NewID("msg"), ConversationID: convID, Channel: "web", PeopleID: owner.ID, Role: "assistant", Content: reply, At: nowUTC(), Direction: "outbound"})
		st.Runtime.Mood = clamp(st.Runtime.Mood+3, 0, 100)
		st.Runtime.SocialNeed = clamp(st.Runtime.SocialNeed-10, 0, 100)
		st.Runtime.Energy = clamp(st.Runtime.Energy-1, 0, 100)
		for i := range st.ReplyDecisions {
			if st.ReplyDecisions[i].ID == decisionID {
				sent := nowUTC()
				st.ReplyDecisions[i].SentAt = &sent
				st.ReplyDecisions[i].Outcome = "sent"
			}
		}
		s.st.AppendEvent(st, "chat", "回复了消息", truncate(reply, 60), owner.ID, "")
		return nil
	})
	if len([]rune(content)) > 12 {
		vis := "relationship"
		_, _ = s.addMemory(store.Memory{Domain: "life", Kind: "episodic", Title: "他/她说：" + truncate(content, 24), Body: content, Importance: 2, Visibility: vis, VisibilityPeopleID: owner.ID, PeopleIDs: []string{owner.ID}, Source: "conversation", EventTime: now})
	}
	return ChatResult{Reply: reply, Replied: true, Action: decision.Action, Reason: decision.Reason}, nil
}

func (s *Service) generateReply(ctx context.Context, owner store.Person, content string) (string, error) {
	if s.LLM() == nil {
		return s.fallbackReply(content), nil
	}
	memories := s.retrieveMemories(content, owner.ID, s.cfg.Memory.RetrievalTopK)
	system := s.SystemPrompt(owner.ID, memories)
	history := s.chatHistory(owner.ID, 16)
	history = append(history, llm.Message{Role: llm.RoleUser, Content: content})
	text, err := s.runTools(ctx, append([]llm.Message{{Role: llm.RoleSystem, Content: system}}, history...), s.toolSpecs(), owner.ID, "web:owner", nil)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(text) == "" {
		return s.fallbackReply(content), nil
	}
	return strings.TrimSpace(text), nil
}

func (s *Service) fallbackReply(content string) string {
	if strings.Contains(content, "在吗") {
		return "在。"
	}
	if strings.Contains(content, "你好") || strings.Contains(content, "hi") {
		return "你好呀。"
	}
	return "嗯，我在想事情。"
}

// HandleChannelChat answers an inbound external-channel message as a specific
// person. Replies are returned synchronously (channel adapters send them), so
// delayed web outbox semantics are not used here.
func (s *Service) HandleChannelChat(ctx context.Context, p store.Person, convID, channelType, content string) (ChatResult, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return ChatResult{}, fmt.Errorf("empty message")
	}
	now := nowUTC()
	_ = s.st.Mutate(func(st *store.State) error {
		st.Messages = append(st.Messages, store.Message{ID: store.NewID("msg"), ConversationID: convID, Channel: channelType, PeopleID: p.ID, Role: "user", Content: content, At: now, Direction: "inbound"})
		return nil
	})
	p, _ = s.TouchInteraction(p.ID)
	decision := s.DecideReply(ctx, p, content)
	_ = s.st.Mutate(func(st *store.State) error {
		st.ReplyDecisions = append(st.ReplyDecisions, store.ReplyDecision{ID: store.NewID("rd"), PeopleID: p.ID, Channel: channelType, ReceivedAt: now, Action: decision.Action, Reason: decision.Reason, DecidedAt: nowUTC(), Factors: map[string]any{"channel": channelType}})
		return nil
	})
	if decision.Action == "no_reply" {
		_ = s.st.Mutate(func(st *store.State) error {
			s.st.AppendEvent(st, "reply", "没有回消息", decision.Reason, p.ID, "")
			return nil
		})
		return ChatResult{Replied: false, Action: decision.Action, Reason: decision.Reason}, nil
	}
	reply, err := s.generateReplyFor(ctx, p, convID, content)
	if err != nil {
		return ChatResult{}, err
	}
	_ = s.st.Mutate(func(st *store.State) error {
		st.Messages = append(st.Messages, store.Message{ID: store.NewID("msg"), ConversationID: convID, Channel: channelType, PeopleID: p.ID, Role: "assistant", Content: reply, At: nowUTC(), Direction: "outbound"})
		st.Runtime.SocialNeed = clamp(st.Runtime.SocialNeed-5, 0, 100)
		s.st.AppendEvent(st, "chat", "在 "+channelType+" 回复了消息", truncate(reply, 60), p.ID, "")
		return nil
	})
	if len([]rune(content)) > 12 {
		_, _ = s.addMemory(store.Memory{Domain: "life", Kind: "episodic", Title: p.DisplayName + "说：" + truncate(content, 24), Body: content, Importance: 2, Visibility: "relationship", VisibilityPeopleID: p.ID, PeopleIDs: []string{p.ID}, Source: channelType, EventTime: now})
	}
	return ChatResult{Reply: reply, Replied: true, Action: decision.Action, Reason: decision.Reason}, nil
}

func (s *Service) generateReplyFor(ctx context.Context, p store.Person, convID, content string) (string, error) {
	if s.LLM() == nil {
		return s.fallbackReply(content), nil
	}
	memories := s.retrieveMemories(content, p.ID, s.cfg.Memory.RetrievalTopK)
	system := s.SystemPrompt(p.ID, memories)
	history := s.chatHistory(p.ID, 16)
	history = append(history, llm.Message{Role: llm.RoleUser, Content: content})
	text, err := s.runTools(ctx, append([]llm.Message{{Role: llm.RoleSystem, Content: system}}, history...), s.toolSpecs(), p.ID, convID, nil)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(text) == "" {
		return s.fallbackReply(content), nil
	}
	return strings.TrimSpace(text), nil
}
