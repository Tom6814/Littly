package app

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/store"
)

const (
	TierStranger     = "stranger"
	TierAcquaintance = "acquaintance"
	TierFriend       = "friend"
	TierIntimate     = "intimate"
	TierArchived     = "archived"
	TierBlocked      = "blocked"
)

type RecallCandidate struct {
	PersonID string   `json:"people_id"`
	Name     string   `json:"name"`
	Tier     string   `json:"tier"`
	Channel  string   `json:"channel"`
	LastSeen string   `json:"last_seen"`
	Brief    string   `json:"brief"`
	Score    float64  `json:"score"`
	Memories []string `json:"memories"`
}

func protected(p store.Person) bool {
	return p.Relationship == "owner" || p.Important || p.Tier == TierFriend || p.Tier == TierIntimate
}

// EnsureContact maps a channel identity to one of her people. Unknown senders
// become strangers (identity row only); archived contacts are NOT auto-restored.
func (s *Service) EnsureContact(channel, externalID, displayName string) (store.Person, error) {
	channel = strings.TrimSpace(channel)
	externalID = strings.TrimSpace(externalID)
	if channel == "" {
		channel = "web"
	}
	if externalID == "" {
		externalID = "owner"
	}
	if p, ok := s.st.FindPersonByChannel(channel, externalID); ok {
		return p, nil
	}
	if channel == "web" && externalID == "owner" {
		return s.Person(), nil
	}
	if displayName == "" {
		displayName = externalID
	}
	now := nowUTC()
	p := store.Person{
		ID: store.NewID("p"), DisplayName: displayName, Nickname: "", Timezone: s.Person().Timezone,
		Channel: channel, ExternalID: externalID, Tier: TierStranger, Relationship: "stranger",
		Closeness: 10, Important: false, CardMode: "summary", CreatedAt: now, UpdatedAt: now,
	}
	err := s.st.Mutate(func(st *store.State) error {
		st.People = append(st.People, p)
		return nil
	})
	return p, err
}

func (s *Service) TouchInteraction(peopleID string) (store.Person, error) {
	now := nowUTC()
	var out store.Person
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.People {
			if st.People[i].ID != peopleID {
				continue
			}
			p := &st.People[i]
			p.InteractionCount++
			p.LastInteractionAt = &now
			p.UpdatedAt = now
			if p.Tier == TierStranger && p.InteractionCount >= 3 {
				p.Tier = TierAcquaintance
				p.Relationship = "acquaintance"
				p.Closeness = 25
				p.CardMode = "summary"
				if p.Brief == "" {
					p.Brief = "聊过几次，还在认识"
				}
			}
			if p.Tier == TierAcquaintance && p.InteractionCount >= 20 && now.Sub(p.CreatedAt) >= 14*24*time.Hour {
				p.Tier = TierFriend
				p.Relationship = "friend"
				p.Closeness = maxInt(p.Closeness, 55)
				p.CardMode = "full"
				p.CardPath = "people/" + p.ID + ".md"
			}
			if p.Important && p.Tier != TierIntimate && p.Tier != TierFriend {
				p.Tier = TierFriend
				p.CardMode = "full"
				p.CardPath = "people/" + p.ID + ".md"
			}
			out = *p
			break
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	if out.CardPath != "" {
		_, _ = s.vault.WritePersonCard(out, s.recentNotes(out.ID))
	}
	_ = s.rebuildAcquaintances()
	return out, nil
}

func (s *Service) rebuildAcquaintances() error {
	var people []store.Person
	_ = s.st.View(func(st *store.State) error { people = append(people, st.People...); return nil })
	return s.vault.RebuildAcquaintances(people)
}

func (s *Service) recentNotes(peopleID string) []string {
	var out []string
	_ = s.st.View(func(st *store.State) error {
		for i := len(st.Memories) - 1; i >= 0 && len(out) < 5; i-- {
			m := st.Memories[i]
			if contains(m.PeopleIDs, peopleID) {
				out = append(out, m.Title)
			}
		}
		return nil
	})
	return out
}

func (s *Service) SetImportant(peopleID string, important bool) error {
	now := nowUTC()
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.People {
			if st.People[i].ID != peopleID {
				continue
			}
			p := &st.People[i]
			p.Important = important
			p.UpdatedAt = now
			if important {
				p.Tier = TierFriend
				p.Relationship = "friend"
				p.CardMode = "full"
				p.CardPath = "people/" + p.ID + ".md"
			}
			return nil
		}
		return fmt.Errorf("person not found")
	})
	if err != nil {
		return err
	}
	if p, ok := s.st.GetPerson(peopleID); ok {
		_, _ = s.vault.WritePersonCard(p, s.recentNotes(peopleID))
	}
	return s.rebuildAcquaintances()
}

// Archive moves a contact to the recycle bin. Memories stay; the card is moved
// to _history and the aggregate row disappears.
func (s *Service) Archive(peopleID, reason string) error {
	now := nowUTC()
	var p store.Person
	_ = s.st.View(func(st *store.State) error {
		for i := range st.People {
			if st.People[i].ID == peopleID {
				p = st.People[i]
			}
		}
		return nil
	})
	if p.ID == "" {
		return fmt.Errorf("person not found")
	}
	if p.Relationship == "owner" {
		return fmt.Errorf("owner cannot be archived")
	}
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.People {
			if st.People[i].ID == peopleID {
				st.People[i].Tier = TierArchived
				st.People[i].CardMode = "archived"
				st.People[i].ArchivedAt = &now
				st.People[i].ArchiveReason = reason
				st.People[i].UpdatedAt = now
				break
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	_ = s.rebuildAcquaintances()
	if p.CardPath != "" {
		_ = s.vaultMoveCardToHistory(p.ID)
	}
	return nil
}

func (s *Service) vaultMoveCardToHistory(peopleID string) error {
	from, err := s.vault.safePath("people/" + peopleID + ".md")
	if err != nil {
		return err
	}
	to, err := s.vault.safePath("_history/people/" + peopleID + "/" + time.Now().UTC().Format("2006-01-02") + ".md")
	if err != nil {
		return err
	}
	_ = ensureDir(to)
	return moveFile(from, to)
}

// Restore brings an archived person back. It is always an explicit action.
func (s *Service) Restore(peopleID string) (store.Person, error) {
	now := nowUTC()
	var out store.Person
	err := s.st.Mutate(func(st *store.State) error {
		for i := range st.People {
			if st.People[i].ID != peopleID {
				continue
			}
			p := &st.People[i]
			if p.Tier != TierArchived {
				return fmt.Errorf("person is not archived")
			}
			p.Tier = TierAcquaintance
			p.Relationship = "acquaintance"
			p.CardMode = "summary"
			p.RestoredAt = &now
			p.RestoreCount++
			p.ArchivedAt = nil
			p.ArchiveReason = ""
			p.UpdatedAt = now
			out = *p
			return nil
		}
		return fmt.Errorf("person not found")
	})
	if err != nil {
		return out, err
	}
	_ = s.rebuildAcquaintances()
	_, _ = s.addMemory(store.Memory{
		Domain: "life", Kind: "episodic", Title: "想起了 " + out.DisplayName,
		Body: "我在回收站里找到了 " + out.DisplayName + "。", EventTime: now, RecordTime: now,
		Importance: 3, Visibility: "public", PeopleIDs: []string{out.ID}, Source: "recycle_bin",
	})
	return out, nil
}

// Recall searches the recycle bin (and active people) by name/alias/brief and
// memory snippets. It never auto-restores.
func (s *Service) Recall(query string, limit int) []RecallCandidate {
	if limit <= 0 {
		limit = 5
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	tokens := tokenize(q)
	var out []RecallCandidate
	_ = s.st.View(func(st *store.State) error {
		for _, p := range st.People {
			hay := strings.ToLower(p.DisplayName + " " + strings.Join(p.Aliases, " ") + " " + p.Brief + " " + p.Notes)
			score := 0.0
			if strings.Contains(hay, q) {
				score += 3
			}
			for _, t := range tokens {
				if strings.Contains(hay, t) {
					score += 0.5
				}
			}
			var memTitles []string
			for i := len(st.Memories) - 1; i >= 0 && len(memTitles) < 3; i-- {
				m := st.Memories[i]
				if contains(m.PeopleIDs, p.ID) && (strings.Contains(strings.ToLower(m.Title+m.Body), q) || score > 0) {
					if strings.Contains(strings.ToLower(m.Title+m.Body), q) {
						score += 0.8
					}
					memTitles = append(memTitles, m.Title)
				}
			}
			if score <= 0 {
				continue
			}
			last := ""
			if p.LastInteractionAt != nil {
				last = p.LastInteractionAt.Format("2006-01-02")
			}
			out = append(out, RecallCandidate{PersonID: p.ID, Name: p.DisplayName, Tier: p.Tier, Channel: p.Channel, LastSeen: last, Brief: p.Brief, Score: score, Memories: memTitles})
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *Service) PersonCard(peopleID string) (store.Person, string) {
	p, ok := s.st.GetPerson(peopleID)
	if !ok {
		return p, ""
	}
	path, err := s.vault.safePath("people/" + p.ID + ".md")
	if err != nil {
		return p, ""
	}
	b, err := readFile(path)
	if err != nil {
		return p, ""
	}
	return p, string(b)
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
