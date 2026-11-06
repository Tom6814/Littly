// Package config loads and validates Littly v2 configuration.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Person struct {
	Name       string         `json:"name"`
	Nickname   string         `json:"nickname"`
	Timezone   string         `json:"timezone"`
	Birthday   string         `json:"birthday,omitempty"`
	Gender     string         `json:"gender,omitempty"`
	Appearance string         `json:"appearance,omitempty"`
	Bio        string         `json:"bio,omitempty"`
	Self       string         `json:"self,omitempty"`  // SELF.md seed
	Style      string         `json:"style,omitempty"` // speaking style
	Boundaries string         `json:"boundaries,omitempty"`
	Traits     map[string]int `json:"traits"`
}

type Brain struct {
	BaseURL        string  `json:"base_url"`
	Model          string  `json:"model"`
	APIKeyEnv      string  `json:"api_key_env"`
	APIKey         string  `json:"api_key,omitempty"` // local only; never returned by API
	Temperature    float64 `json:"temperature"`
	MaxTokens      int     `json:"max_tokens"`
	TimeoutSeconds int     `json:"timeout_seconds"`
	MaxToolRounds  int     `json:"max_tool_rounds"`
}

type Heartbeat struct {
	Enabled              bool   `json:"enabled"`
	FallbackDayMinutes   int    `json:"fallback_day_minutes"`
	FallbackNightMinutes int    `json:"fallback_night_minutes"`
	MaxGapHours          int    `json:"max_gap_hours"`
	SpacingSeconds       int    `json:"spacing_seconds"`
	DayStart             string `json:"day_start"`
	DayEnd               string `json:"day_end"`
	NoopSlowAfter        int    `json:"noop_slow_after"`
	NoopPauseAfter       int    `json:"noop_pause_after"`
	MaxTurnsPerDay       int    `json:"max_turns_per_day"`
}

type Memory struct {
	VaultDir      string  `json:"vault_dir"`
	RetrievalTopK int     `json:"retrieval_top_k"`
	ImportanceW   float64 `json:"importance_weight"`
	RecencyW      float64 `json:"recency_weight"`
	RelevanceW    float64 `json:"relevance_weight"`
	DreamHour     int     `json:"dream_hour"`
}

type Workbench struct {
	Dir                 string `json:"dir"`
	MaxFileBytes        int64  `json:"max_file_bytes"`
	AllowShell          bool   `json:"allow_shell"`
	AllowNetwork        bool   `json:"allow_network"`
	AutoActivityMinutes int    `json:"auto_activity_minutes"`
	BrowserURL          string `json:"browser_url"`
}

type SnowLuma struct {
	Enabled         bool   `json:"enabled"`
	WSURL           string `json:"ws_url"`
	Token           string `json:"token"`
	AccountRef      string `json:"account_ref"`
	OwnerExternalID string `json:"owner_external_id"`
	GroupAtOnly     bool   `json:"group_at_only"`
}

type Channels struct {
	SnowLuma SnowLuma `json:"snowluma"`
}

type Security struct {
	QuietStart       string `json:"quiet_start"`
	QuietEnd         string `json:"quiet_end"`
	Estop            bool   `json:"estop"`
	ApprovalOutbound bool   `json:"approval_outbound"`
}

type Server struct {
	Addr    string `json:"addr"`
	DataDir string `json:"data_dir"`
}

type Config struct {
	Person    Person    `json:"person"`
	Brain     Brain     `json:"brain"`
	Heartbeat Heartbeat `json:"heartbeat"`
	Memory    Memory    `json:"memory"`
	Workbench Workbench `json:"workbench"`
	Channels  Channels  `json:"channels"`
	Security  Security  `json:"security"`
	Server    Server    `json:"server"`

	path string
}

func Default() Config {
	c := Config{}
	c.Person.Name = "小璃"
	c.Person.Nickname = "Littly"
	c.Person.Timezone = "Asia/Shanghai"
	c.Person.Bio = "她是一个有自己的生活、自己的电脑、自己的朋友与判断的人。"
	c.Person.Self = "我是小璃。我不是谁的助手，我是一个在过日子的人。"
	c.Person.Style = "说话自然、简洁、像真人微信；不用客服腔，不用 emoji 堆砌。"
	c.Person.Boundaries = "不编造没发生过的事；不泄露别人私下告诉我的事；不可逆的事要先问。"
	c.Person.Traits = map[string]int{
		"clinginess": 45, "social_energy": 55, "pride": 50, "patience": 55,
		"curiosity": 70, "orderliness": 50, "possessiveness": 35,
		"expressiveness": 55, "independence": 55,
	}
	c.Brain.BaseURL = "https://api.deepseek.com"
	c.Brain.Model = "deepseek-flash"
	c.Brain.APIKeyEnv = "LITTLY_API_KEY"
	c.Brain.Temperature = 0.8
	c.Brain.MaxTokens = 1024
	c.Brain.TimeoutSeconds = 90
	c.Brain.MaxToolRounds = 6
	c.Heartbeat.Enabled = true
	c.Heartbeat.FallbackDayMinutes = 60
	c.Heartbeat.FallbackNightMinutes = 150
	c.Heartbeat.MaxGapHours = 8
	c.Heartbeat.SpacingSeconds = 600
	c.Heartbeat.DayStart = "07:00"
	c.Heartbeat.DayEnd = "23:00"
	c.Heartbeat.NoopSlowAfter = 3
	c.Heartbeat.NoopPauseAfter = 6
	c.Heartbeat.MaxTurnsPerDay = 24
	c.Memory.VaultDir = "data/vault"
	c.Memory.RetrievalTopK = 12
	c.Memory.ImportanceW = 0.25
	c.Memory.RecencyW = 0.20
	c.Memory.RelevanceW = 0.55
	c.Memory.DreamHour = 3
	c.Workbench.Dir = "data/workspace"
	c.Workbench.MaxFileBytes = 8 << 20
	c.Workbench.AllowNetwork = true
	c.Workbench.AutoActivityMinutes = 180
	c.Workbench.BrowserURL = "http://littly-browser:9222"
	c.Channels.SnowLuma.WSURL = "ws://127.0.0.1:3001"
	c.Channels.SnowLuma.GroupAtOnly = true
	c.Security.QuietStart = "23:00"
	c.Security.QuietEnd = "08:00"
	c.Security.ApprovalOutbound = false
	c.Server.Addr = "127.0.0.1:8080"
	c.Server.DataDir = "data"
	return c
}

func Load(path string) (Config, error) {
	c := Default()
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			return c, fmt.Errorf("read config: %w", err)
		}
		if err := json.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("parse config: %w", err)
		}
	}
	c.path = path
	if err := c.Resolve(); err != nil {
		return c, err
	}
	return c, nil
}

// Resolve fills defaults for unset fields and resolves paths relative to the
// config file's directory (or cwd when loaded from defaults).
func (c *Config) Resolve() error {
	base := "."
	if c.path != "" {
		base = filepath.Dir(c.path)
	}
	if c.Server.Addr == "" {
		c.Server.Addr = "127.0.0.1:8080"
	}
	if c.Server.DataDir == "" {
		c.Server.DataDir = "data"
	}
	c.Server.DataDir = absFrom(base, c.Server.DataDir)
	c.Memory.VaultDir = absFrom(base, c.Memory.VaultDir)
	c.Workbench.Dir = absFrom(base, c.Workbench.Dir)
	if c.Brain.BaseURL == "" {
		c.Brain.BaseURL = "https://api.deepseek.com"
	}
	if c.Brain.Model == "" {
		c.Brain.Model = "deepseek-flash"
	}
	if c.Brain.TimeoutSeconds <= 0 {
		c.Brain.TimeoutSeconds = 90
	}
	if c.Brain.MaxToolRounds <= 0 {
		c.Brain.MaxToolRounds = 6
	}
	if c.Brain.MaxTokens <= 0 {
		c.Brain.MaxTokens = 1024
	}
	if c.Heartbeat.FallbackDayMinutes <= 0 {
		c.Heartbeat.FallbackDayMinutes = 60
	}
	if c.Heartbeat.FallbackNightMinutes <= 0 {
		c.Heartbeat.FallbackNightMinutes = 150
	}
	if c.Heartbeat.MaxGapHours <= 0 {
		c.Heartbeat.MaxGapHours = 8
	}
	if c.Heartbeat.SpacingSeconds <= 0 {
		c.Heartbeat.SpacingSeconds = 600
	}
	if c.Heartbeat.MaxTurnsPerDay <= 0 {
		c.Heartbeat.MaxTurnsPerDay = 24
	}
	if c.Memory.RetrievalTopK <= 0 {
		c.Memory.RetrievalTopK = 12
	}
	if c.Workbench.AutoActivityMinutes == 0 {
		c.Workbench.AutoActivityMinutes = 180
		c.Workbench.BrowserURL = "http://littly-browser:9222"
	}
	if c.Workbench.MaxFileBytes <= 0 {
		c.Workbench.MaxFileBytes = 8 << 20
	}
	if c.Person.Timezone == "" {
		c.Person.Timezone = "Asia/Shanghai"
	}
	if c.Person.Traits == nil {
		c.Person.Traits = Default().Person.Traits
	}
	return c.Validate()
}

func (c *Config) Validate() error {
	if strings.TrimSpace(c.Person.Name) == "" {
		return fmt.Errorf("person.name is required")
	}
	if _, err := loadLocation(c.Person.Timezone); err != nil {
		return fmt.Errorf("person.timezone: %w", err)
	}
	if c.Brain.Temperature < 0 || c.Brain.Temperature > 2 {
		return fmt.Errorf("brain.temperature must be 0..2")
	}
	for _, t := range []string{c.Heartbeat.DayStart, c.Heartbeat.DayEnd, c.Security.QuietStart, c.Security.QuietEnd} {
		if _, err := parseClock(t); err != nil {
			return fmt.Errorf("bad clock %q: %w", t, err)
		}
	}
	return nil
}

func (c Config) Path() string { return c.path }

func (c Config) APIKey() string {
	if c.Brain.APIKey != "" {
		return c.Brain.APIKey
	}
	for _, env := range []string{c.Brain.APIKeyEnv, "LITTLY_API_KEY", "DEEPSEEK_API_KEY"} {
		if env != "" {
			if v := os.Getenv(env); v != "" {
				return v
			}
		}
	}
	return ""
}

// Redacted returns a copy safe for API responses.
func (c Config) Redacted() Config {
	c.Brain.APIKey = ""
	if c.Channels.SnowLuma.Token != "" {
		c.Channels.SnowLuma.Token = "***"
	}
	return c
}

// Save writes the config back to its path.
func (c Config) Save() error {
	if c.path == "" {
		return fmt.Errorf("config has no path")
	}
	b, err := json.MarshalIndent(c.RedactedForSave(), "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// RedactedForSave keeps locally configured secrets on disk but not in memory dumps.
func (c Config) RedactedForSave() Config { return c }

func absFrom(base, p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(base, p)
}
