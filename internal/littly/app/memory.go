package app

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/felinics/memoh/internal/littly/store"
)

// Vault is the Markdown source of truth for her memory. The JSON store keeps a
// searchable index; every write here is atomic and path-jailed.
type Vault struct{ dir string }

func NewVault(dir string) (*Vault, error) {
	if dir == "" {
		return nil, fmt.Errorf("vault dir required")
	}
	for _, sub := range []string{"", "people", "domains/life", "domains/feelings", "domains/thoughts", "domains/plans", "domains/knowledge", "domains/routines", "threads", "diary", "_staging", "_history"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	return &Vault{dir: dir}, nil
}

func (v *Vault) Dir() string { return v.dir }

func (v *Vault) safePath(rel string) (string, error) {
	clean := filepath.Clean("/" + rel)
	if strings.Contains(clean, "..") {
		return "", fmt.Errorf("path denied")
	}
	return filepath.Join(v.dir, clean), nil
}

func (v *Vault) write(rel, content string) (string, error) {
	p, err := v.safePath(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		return "", err
	}
	return p, nil
}

func (v *Vault) MemoryPath(m store.Memory) string {
	return filepath.Join("domains", m.Domain, m.ID+".md")
}

func (v *Vault) WriteMemory(m store.Memory) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "---\nid: %s\ndomain: %s\nkind: %s\ntitle: %s\nevent_time: %s\nrecord_time: %s\nimportance: %d\nvisibility: %s\n", m.ID, m.Domain, m.Kind, quoteYAML(m.Title), m.EventTime.Format(time.RFC3339), m.RecordTime.Format(time.RFC3339), m.Importance, m.Visibility)
	if m.VisibilityPeopleID != "" {
		fmt.Fprintf(&b, "visibility_people: %s\n", m.VisibilityPeopleID)
	}
	if m.Emotion != "" {
		fmt.Fprintf(&b, "emotion: %s\n", quoteYAML(m.Emotion))
	}
	if len(m.PeopleIDs) > 0 {
		fmt.Fprintf(&b, "people: [%s]\n", strings.Join(m.PeopleIDs, ", "))
	}
	fmt.Fprintf(&b, "source: %s\n---\n\n", m.Source)
	b.WriteString(m.Body)
	b.WriteString("\n")
	return v.write(v.MemoryPath(m), b.String())
}

func (v *Vault) EnsureSelf(text string) error {
	p, err := v.safePath("SELF.md")
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(p); statErr == nil {
		return nil
	}
	_, err = v.write("SELF.md", "# SELF\n\n"+text+"\n")
	return err
}

func (v *Vault) WritePersonCard(p store.Person, notes []string) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "---\nid: %s\ndisplay_name: %s\nrelationship: %s\ntier: %s\ncloseness: %d\nimportant: %t\nupdated_at: %s\n---\n\n", p.ID, quoteYAML(p.DisplayName), p.Relationship, p.Tier, p.Closeness, p.Important, time.Now().UTC().Format(time.RFC3339))
	b.WriteString("## 她是谁\n\n")
	if p.Brief != "" {
		b.WriteString(p.Brief + "\n\n")
	} else {
		b.WriteString("（还不太了解）\n\n")
	}
	b.WriteString("## 我们的关系\n\n")
	fmt.Fprintf(&b, "- 关系：%s\n- 亲密度：%d\n- 重要：%t\n\n", p.Relationship, p.Closeness, p.Important)
	b.WriteString("## 边界与雷区\n\n")
	if p.Boundaries != "" {
		b.WriteString(p.Boundaries + "\n\n")
	} else {
		b.WriteString("（暂无）\n\n")
	}
	b.WriteString("## 最近变化\n\n")
	if len(notes) == 0 {
		b.WriteString("（暂无）\n")
	}
	for _, n := range notes {
		b.WriteString("- " + n + "\n")
	}
	return v.write(filepath.Join("people", p.ID+".md"), b.String())
}

// RebuildAcquaintances regenerates people/acquaintances.md from the index.
func (v *Vault) RebuildAcquaintances(people []store.Person) error {
	var rows []store.Person
	for _, p := range people {
		if p.Tier == "acquaintance" {
			rows = append(rows, p)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].DisplayName < rows[j].DisplayName })
	var b strings.Builder
	b.WriteString("# 泛泛之交\n\n> 一行一人，由 Dream 维护；90 天无互动会淡出。\n\n")
	for _, p := range rows {
		last := "—"
		if p.LastInteractionAt != nil {
			last = p.LastInteractionAt.Format("2006-01-02")
		}
		fmt.Fprintf(&b, "- %s（%s）· 最后 %s · %s\n", p.DisplayName, p.Channel, last, p.Brief)
	}
	_, err := v.write("people/acquaintances.md", b.String())
	return err
}

func quoteYAML(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, ":#\n\"") {
		return fmt.Sprintf("%q", s)
	}
	return s
}

func nowUTC() time.Time { return time.Now().UTC() }

// tokenize is a deliberately small relevance tokenizer: CJK bigrams plus
// latin words. It is enough for a single-user vault.
func tokenize(s string) []string {
	s = strings.ToLower(s)
	var out []string
	var word []rune
	flush := func() {
		if len(word) > 0 {
			out = append(out, string(word))
			word = word[:0]
		}
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if r > unicode.MaxASCII {
				flush()
				out = append(out, string(r))
			} else {
				word = append(word, r)
			}
		} else {
			flush()
		}
	}
	flush()
	// CJK bigrams over adjacent CJK runes.
	runes := []rune(s)
	for i := 0; i+1 < len(runes); i++ {
		if runes[i] > unicode.MaxASCII && runes[i+1] > unicode.MaxASCII {
			out = append(out, string(runes[i:i+2]))
		}
	}
	return out
}
