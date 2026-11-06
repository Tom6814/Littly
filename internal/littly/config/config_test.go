package config

import (
	"strings"
	"testing"
)

func TestDefaultResolveAndValidate(t *testing.T) {
	c := Default()
	if err := c.Resolve(); err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if c.Workbench.AutoActivityMinutes != 180 {
		t.Fatalf("auto activity = %d", c.Workbench.AutoActivityMinutes)
	}
	if c.Memory.DreamHour != 3 {
		t.Fatalf("dream hour = %d", c.Memory.DreamHour)
	}
	if !strings.Contains(c.Redacted().Channels.SnowLuma.WSURL, "127.0.0.1") {
		t.Fatalf("default snowluma ws missing")
	}
}

func TestValidateRejectsBadTimezoneAndClock(t *testing.T) {
	c := Default()
	_ = c.Resolve()
	c.Person.Timezone = "Not/AZone"
	if err := c.Validate(); err == nil {
		t.Fatalf("expected timezone error")
	}
	c = Default()
	_ = c.Resolve()
	c.Heartbeat.DayStart = "25:99"
	if err := c.Validate(); err == nil {
		t.Fatalf("expected clock error")
	}
}

func TestRedactedHidesSecrets(t *testing.T) {
	c := Default()
	c.Brain.APIKey = "sk-secret"
	c.Channels.SnowLuma.Token = "token-secret"
	r := c.Redacted()
	if r.Brain.APIKey != "" || r.Channels.SnowLuma.Token != "***" {
		t.Fatalf("redaction failed: %+v", r)
	}
}
