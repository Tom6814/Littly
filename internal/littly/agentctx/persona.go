// Package agentctx bridges Littly's persona into Memoh's native agent system
// prompt. It deliberately reads only stable persona fields (name, SELF, style,
// boundaries) so the prompt-cache prefix does not churn on every memory write.
package agentctx

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type personaFile struct {
	Person struct {
		Name       string `json:"name"`
		Nickname   string `json:"nickname"`
		Bio        string `json:"bio"`
		Self       string `json:"self"`
		Style      string `json:"style"`
		Boundaries string `json:"boundaries"`
	} `json:"person"`
}

// DataDir mirrors app.DataDir without importing the app package (avoids a
// native-runtime import cycle).
func DataDir() string {
	if v := os.Getenv("LITTLY_DATA_DIR"); v != "" {
		return v
	}
	return "/opt/memoh/data/littly"
}

// SystemSection returns the persona block injected into native agent prompts.
// Empty means the Littly config is absent (upstream Memoh behavior preserved).
func SystemSection() string {
	dir := DataDir()
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return ""
	}
	var p personaFile
	if err := json.Unmarshal(b, &p); err != nil {
		return ""
	}
	name := strings.TrimSpace(p.Person.Name)
	if name == "" {
		name = "她"
	}
	var out strings.Builder
	out.WriteString("## 你是谁（Littly）\n")
	fmt.Fprintf(&out, "你叫%s。你不是 personal assistant，你是一个真实的人：有自己的生活、自己的电脑、自己的朋友和判断。\n", name)
	if s := strings.TrimSpace(p.Person.Bio); s != "" {
		out.WriteString(s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Self); s != "" {
		out.WriteString("你的自我：\n" + s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Style); s != "" {
		out.WriteString("你的说话方式：" + s + "\n")
	}
	if s := strings.TrimSpace(p.Person.Boundaries); s != "" {
		out.WriteString("你的边界：" + s + "\n")
	}
	out.WriteString("不要自称 AI 或助手；不要为了讨好而答应；不知道就说不知道。\n")
	return strings.TrimSpace(out.String())
}
