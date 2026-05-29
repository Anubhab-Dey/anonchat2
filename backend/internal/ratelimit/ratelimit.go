package ratelimit

import (
	"sync"
	"time"
)

type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	seen   time.Time
}

func New() *Limiter {
	return &Limiter{buckets: make(map[string]*bucket)}
}

func (l *Limiter) Allow(key string, cost float64) bool {
	if key == "" {
		key = "anonymous"
	}
	if cost <= 0 {
		cost = 1
	}

	const capacity = 40.0
	const refillPerSecond = 8.0

	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: capacity, seen: now}
		l.buckets[key] = b
	}

	elapsed := now.Sub(b.seen).Seconds()
	b.seen = now
	b.tokens += elapsed * refillPerSecond
	if b.tokens > capacity {
		b.tokens = capacity
	}
	if b.tokens < cost {
		return false
	}
	b.tokens -= cost
	return true
}
