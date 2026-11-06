package server

import "testing"

func TestShouldSkipJWTLittlyRoutes(t *testing.T) {
	for _, p := range []string{"/littly", "/littly/", "/littly/app.js", "/littly/style.css", "/littly/api/bootstrap", "/littly/api/chat"} {
		if !shouldSkipJWT(p) {
			t.Errorf("shouldSkipJWT(%q) = false, want true", p)
		}
	}
	if shouldSkipJWT("/bots") || shouldSkipJWT("/api/bots") {
		t.Errorf("bot management routes must stay authenticated")
	}
}
