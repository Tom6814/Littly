// Package memoryapi defines the narrow interface Memoh's default memory
// provider uses to read/write Littly's own memory store. It exists as its own
// package so the provider adapter and the Littly app can share it without an
// import cycle.
package memoryapi

import (
	"context"
	"sync"
	"time"
)

type Hit struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Body       string    `json:"body"`
	Domain     string    `json:"domain"`
	Visibility string    `json:"visibility"`
	Importance int       `json:"importance"`
	EventTime  time.Time `json:"event_time"`
}

type Backend interface {
	Search(ctx context.Context, query string, limit int) ([]Hit, error)
	Add(ctx context.Context, title, body string) (Hit, error)
	Update(ctx context.Context, id, title, body string) (Hit, error)
	Delete(ctx context.Context, id string) error
	List(ctx context.Context, limit int) ([]Hit, error)
}

var (
	mu      sync.RWMutex
	backend Backend
)

func Set(b Backend) {
	mu.Lock()
	backend = b
	mu.Unlock()
}

func Get() Backend {
	mu.RLock()
	defer mu.RUnlock()
	return backend
}
