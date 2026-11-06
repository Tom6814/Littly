package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func loadLocation(name string) (*time.Location, error) {
	if name == "" {
		name = "UTC"
	}
	return time.LoadLocation(name)
}

func parseClock(s string) (int, error) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, fmt.Errorf("want HH:MM")
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, err
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, err
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, errors.New("out of range")
	}
	return h*60 + m, nil
}

// MinutesOfDay parses HH:MM into minutes.
func MinutesOfDay(s string) (int, error) { return parseClock(s) }

// Local returns the configured person's timezone.
func (c Config) Local() *time.Location {
	loc, err := time.LoadLocation(c.Person.Timezone)
	if err != nil {
		return time.Local
	}
	return loc
}

// InWindow reports whether t (in loc) is within [start,end), handling midnight wrap.
func InWindow(t time.Time, start, end string) bool {
	s, e := mustClock(start), mustClock(end)
	m := t.Hour()*60 + t.Minute()
	if s == e {
		return false
	}
	if s < e {
		return m >= s && m < e
	}
	return m >= s || m < e
}

func mustClock(s string) int {
	v, err := parseClock(s)
	if err != nil {
		return 0
	}
	return v
}
