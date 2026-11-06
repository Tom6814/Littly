package app

import (
	"os"
	"path/filepath"
)

func ensureDir(p string) error { return os.MkdirAll(filepath.Dir(p), 0o755) }

func readFile(p string) ([]byte, error) { return os.ReadFile(p) }

func moveFile(from, to string) error { return os.Rename(from, to) }
