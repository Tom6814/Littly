package app

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestBiliToolsLive(t *testing.T) {
	if os.Getenv("LITTLY_LIVE") != "1" {
		t.Skip("set LITTLY_LIVE=1 to run network test")
	}
	s := newTestService(t)
	hot, err := s.biliHot(context.Background(), 3)
	if err != nil {
		t.Fatalf("hot: %v", err)
	}
	if !strings.Contains(hot, "B 站热门") || !strings.Contains(hot, "BV") {
		t.Fatalf("unexpected hot: %s", hot)
	}
	_ = hot
}
