package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/channel"
	"github.com/felinics/memoh/internal/littly/config"
	"github.com/felinics/memoh/internal/channel/adapters/discord"
	"github.com/felinics/memoh/internal/channel/adapters/feishu"
	slackadapter "github.com/felinics/memoh/internal/channel/adapters/slack"
	"github.com/felinics/memoh/internal/channel/adapters/telegram"
	"github.com/felinics/memoh/internal/channel/adapters/weixin"
)

type ChannelStatus struct {
	Type      string `json:"type"`
	Enabled   bool   `json:"enabled"`
	Connected bool   `json:"connected"`
	SelfID    string `json:"self_id,omitempty"`
	LastError string `json:"last_error,omitempty"`
	LastEvent string `json:"last_event,omitempty"`
}

type channelRuntime struct {
	typ     string
	adapter channel.Adapter
	sender  channel.Sender
	cfg     channel.ChannelConfig
	conn    channel.Connection
	status  ChannelStatus
}

var supportedChannelTypes = []string{"feishu", "weixin", "telegram", "discord", "slack"}

func newChannelAdapter(typ string, log interface{ Error(string, ...any) }) (channel.Adapter, channel.Sender, error) {
	switch typ {
	case "feishu":
		a := feishu.NewFeishuAdapter(nil)
		return a, a, nil
	case "weixin":
		a := weixin.NewWeixinAdapter(nil)
		return a, a, nil
	case "telegram":
		a := telegram.NewTelegramAdapter(nil)
		return a, a, nil
	case "discord":
		a := discord.NewDiscordAdapter(nil)
		return a, a, nil
	case "slack":
		a := slackadapter.NewSlackAdapter(nil)
		return a, a, nil
	default:
		return nil, nil, fmt.Errorf("unsupported channel %q", typ)
	}
}

// startChannels rewires all configured external channels from her config.
func (s *Service) startChannels() {
	s.mu.Lock()
	if len(s.channels) > 0 {
		for _, rt := range s.channels {
			if rt.conn != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = rt.conn.Stop(ctx)
				cancel()
			}
		}
	}
	s.channels = map[string]*channelRuntime{}
	types := append([]string(nil), supportedChannelTypes...)
	s.mu.Unlock()

	for _, typ := range types {
		conf, ok := s.cfg.Channels.Connections[typ]
		if !ok || !conf.Enabled {
			continue
		}
		adapter, sender, err := newChannelAdapter(typ, nil)
		rt := &channelRuntime{typ: typ, adapter: adapter, sender: sender}
		if err != nil {
			rt.status = ChannelStatus{Type: typ, Enabled: true, LastError: err.Error()}
			s.mu.Lock(); s.channels[typ] = rt; s.mu.Unlock()
			continue
		}
		rt.cfg = channel.ChannelConfig{ID: "owner-" + typ, TeamID: "owner", BotID: "owner", ChannelType: channel.ChannelType(typ), Credentials: conf.Credentials}
		receiver, ok := adapter.(channel.Receiver)
		if !ok {
			rt.status = ChannelStatus{Type: typ, Enabled: true, LastError: "adapter does not support receiving"}
			s.mu.Lock(); s.channels[typ] = rt; s.mu.Unlock()
			continue
		}
		conn, err := receiver.Connect(context.Background(), rt.cfg, s.onChannelInbound(typ))
		if err != nil {
			rt.status = ChannelStatus{Type: typ, Enabled: true, LastError: err.Error()}
		} else {
			rt.conn = conn
			rt.status = ChannelStatus{Type: typ, Enabled: true, Connected: true}
			s.log.Info("littly: channel started", "type", typ)
		}
		s.mu.Lock(); s.channels[typ] = rt; s.mu.Unlock()
	}
}

func (s *Service) onChannelInbound(typ string) channel.InboundHandler {
	return func(ctx context.Context, cfg channel.ChannelConfig, msg channel.InboundMessage) error {
		text := strings.TrimSpace(msg.Message.PlainText())
		if text == "" {
			return nil
		}
		ext := strings.TrimSpace(msg.Sender.SubjectID)
		if ext == "" {
			ext = strings.TrimSpace(msg.Sender.DisplayName)
		}
		p, err := s.EnsureContact(typ, ext, msg.Sender.DisplayName)
		if err != nil {
			return err
		}
		reply, err := s.HandleChannelChat(ctx, p, typ+":"+ext, typ, text)
		if err != nil || !reply.Replied || strings.TrimSpace(reply.Reply) == "" {
			return err
		}
		s.mu.Lock()
		rt := s.channels[typ]
		s.mu.Unlock()
		if rt == nil || rt.sender == nil {
			return nil
		}
		out := channel.PreparedOutboundMessage{Target: msg.ReplyTarget, Message: channel.PreparedMessage{Message: channel.Message{Text: reply.Reply, Format: channel.MessageFormatPlain}}}
		if err := rt.sender.Send(ctx, rt.cfg, out); err != nil {
			return err
		}
		s.mu.Lock()
		if rt.status.LastEvent == "" || time.Since(parseLoose(rt.status.LastEvent)) > time.Second {
			rt.status.LastEvent = time.Now().Format(time.RFC3339)
		}
		s.mu.Unlock()
		return nil
	}
}

func parseLoose(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func (s *Service) stopChannels() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rt := range s.channels {
		if rt.conn != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = rt.conn.Stop(ctx)
			cancel()
		}
	}
	s.channels = map[string]*channelRuntime{}
}

func (s *Service) channelStatuses() []ChannelStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ChannelStatus, 0, len(supportedChannelTypes))
	for _, typ := range supportedChannelTypes {
		if rt, ok := s.channels[typ]; ok {
			st := rt.status
			if rt.conn != nil {
				st.Connected = rt.conn.Running()
			}
			out = append(out, st)
		} else {
			conf := s.cfg.Channels.Connections[typ]
			out = append(out, ChannelStatus{Type: typ, Enabled: conf.Enabled})
		}
	}
	return out
}

func (s *Service) updateChannelConfig(typ string, enabled bool, credentials map[string]any) error {
	found := false
	for _, t := range supportedChannelTypes {
		if t == typ { found = true; break }
	}
	if !found {
		return fmt.Errorf("unsupported channel %q", typ)
	}
	err := s.UpdateConfig(func(c *config.Config) {
		if c.Channels.Connections == nil { c.Channels.Connections = map[string]config.ChannelConnection{} }
		prev := c.Channels.Connections[typ]
		creds := map[string]any{}
		for k, v := range prev.Credentials { creds[k] = v }
		for k, v := range credentials {
			if sv, ok := v.(string); ok && sv == "***" { continue }
			creds[k] = v
		}
		c.Channels.Connections[typ] = config.ChannelConnection{Enabled: enabled, Credentials: creds}
	})
	if err != nil { return err }
	s.startChannels()
	return nil
}
