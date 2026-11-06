package app

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/store"
)

type SnapshotInfo struct {
	ID      string    `json:"id"`
	Bytes   int64     `json:"bytes"`
	Created time.Time `json:"created_at"`
	Files   int       `json:"files"`
}

func (s *Service) snapshotDir() string { return filepath.Join(s.dataDir, "snapshots") }

// CreateSnapshot tars her workspace into data/snapshots and records an
// artifact. Snapshot files are never included in later snapshots.
func (s *Service) CreateSnapshot() (SnapshotInfo, error) {
	if err := os.MkdirAll(s.snapshotDir(), 0o755); err != nil {
		return SnapshotInfo{}, err
	}
	id := time.Now().Format("20060102-150405")
	name := "snapshot-" + id + ".tar.gz"
	full := filepath.Join(s.snapshotDir(), name)
	f, err := os.Create(full)
	if err != nil {
		return SnapshotInfo{}, err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	root := s.cfg.Workbench.Dir
	files := 0
	walkErr := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "home/snapshots") {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = rel
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			files++
			src, err := os.Open(p)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, src)
			_ = src.Close()
			return err
		}
		return nil
	})
	if walkErr != nil {
		_ = tw.Close()
		_ = gz.Close()
		_ = os.Remove(full)
		return SnapshotInfo{}, walkErr
	}
	if err := tw.Close(); err != nil {
		return SnapshotInfo{}, err
	}
	if err := gz.Close(); err != nil {
		return SnapshotInfo{}, err
	}
	if st, err := os.Stat(full); err == nil {
		_ = s.st.Mutate(func(state *store.State) error {
			state.Artifacts = append(state.Artifacts, store.Artifact{ID: store.NewID("art"), Kind: "snapshot", Title: "工作台快照 " + id, Path: full, Bytes: st.Size(), CreatedAt: nowUTC()})
			s.st.AppendEvent(state, "snapshot", "拍了一张快照", id, "", "")
			return nil
		})
		return SnapshotInfo{ID: name, Bytes: st.Size(), Created: st.ModTime(), Files: files}, nil
	}
	return SnapshotInfo{ID: name, Files: files}, nil
}

func (s *Service) ListSnapshots() ([]SnapshotInfo, error) {
	entries, err := os.ReadDir(s.snapshotDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []SnapshotInfo{}, nil
		}
		return nil, err
	}
	out := make([]SnapshotInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, SnapshotInfo{ID: e.Name(), Bytes: info.Size(), Created: info.ModTime(), Files: -1})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

// RestoreSnapshot extracts a snapshot back into the workspace with traversal
// guards. It overwrites files; callers should snapshot first if needed.
func (s *Service) RestoreSnapshot(id string) (int, error) {
	if strings.ContainsAny(id, `/\`) || !strings.HasSuffix(id, ".tar.gz") {
		return 0, fmt.Errorf("bad snapshot id")
	}
	f, err := os.Open(filepath.Join(s.snapshotDir(), id))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	root := s.cfg.Workbench.Dir
	if err := os.MkdirAll(root, 0o755); err != nil {
		return 0, err
	}
	n := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return n, err
		}
		clean := path.Clean("/" + hdr.Name)
		rel := strings.TrimPrefix(clean, "/")
		if rel == "" || strings.Contains(rel, "..") {
			continue
		}
		dst := filepath.Join(root, filepath.FromSlash(rel))
		if !strings.HasPrefix(dst, filepath.Clean(root)+string(os.PathSeparator)) {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return n, err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return n, err
			}
			out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return n, err
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return n, err
			}
			_ = out.Close()
			n++
		}
	}
	return n, nil
}
