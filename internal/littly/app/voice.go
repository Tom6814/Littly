package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/store"
)

func voiceSecret() string {
	if v := os.Getenv("VOICE_TOKEN_SECRET"); v != "" {
		return v
	}
	return "littly-local-voice-secret"
}

// SignCallToken issues the short-lived HMAC token the browser passes to /call.
func (s *Service) SignCallToken() (string, int64) {
	payload := map[string]any{"botId": "owner", "sender": "owner", "exp": time.Now().Add(120 * time.Second).UnixMilli()}
	b, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, []byte(voiceSecret()))
	mac.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), 120000
}

// OnCallEnded stores a call card message, an event, and a transcript memory.
func (s *Service) OnCallEnded(ctx context.Context, durationSec int, lines []string) error {
	if durationSec < 0 {
		durationSec = 0
	}
	now := nowUTC()
	transcript := strings.Join(lines, "\n")
	content := fmt.Sprintf("[语音通话] 时长 %d 分 %d 秒", durationSec/60, durationSec%60)
	_ = s.st.Mutate(func(st *store.State) error {
		st.Messages = append(st.Messages, store.Message{ID: store.NewID("msg"), ConversationID: "web:owner", Channel: "web", PeopleID: "owner", Role: "assistant", Content: content, At: now, Direction: "outbound"})
		s.st.AppendEvent(st, "call", content, truncate(transcript, 300), "owner", "")
		return nil
	})
	if strings.TrimSpace(transcript) != "" {
		_, _ = s.addMemory(store.Memory{Domain: "life", Kind: "episodic", Title: "一次语音通话", Body: truncate(transcript, 1500), Importance: 3, Visibility: "relationship", VisibilityPeopleID: "owner", PeopleIDs: []string{"owner"}, Source: "voice_call", EventTime: now})
	}
	return nil
}
