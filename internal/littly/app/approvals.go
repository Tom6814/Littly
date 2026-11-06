package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/felinics/memoh/internal/littly/store"
)

// riskyCommand returns a reason when a shell command crosses a destructive
// boundary that must be approved by the owner. This is a brake, not a sandbox.
func riskyCommand(cmd string) (string, bool) {
	c := strings.ToLower(strings.TrimSpace(cmd))
	risks := []struct{ needle, reason string }{
		{"rm -rf", "递归删除文件"},
		{"mkfs", "格式化文件系统"}, {"dd if=", "块设备写入"}, {":(){", "fork 炸弹"},
		{"shutdown", "关机"}, {"reboot", "重启"}, {"poweroff", "关机"},
		{"chmod -r 777 /", "放宽根目录权限"}, {"> /dev/sd", "写块设备"},
		{"curl", "| sh"}, {"wget", "| sh"}, {"curl", "| bash"}, {"wget", "| bash"},
	}
	for _, r := range risks {
		if r.needle == "curl" || r.needle == "wget" {
			if strings.Contains(c, r.needle) && (strings.Contains(c, "|sh") || strings.Contains(c, "| sh") || strings.Contains(c, "|bash") || strings.Contains(c, "| bash")) {
				return "从网络下载并执行脚本", true
			}
			continue
		}
		if strings.Contains(c, r.needle) {
			return r.reason, true
		}
	}
	return "", false
}

func (s *Service) pendingApproval(cmd string) *store.Approval {
	var out *store.Approval
	_ = s.st.View(func(st *store.State) error {
		for i := len(st.Approvals) - 1; i >= 0; i-- {
			if st.Approvals[i].Status == "pending" && st.Approvals[i].Command == cmd {
				a := st.Approvals[i]
				out = &a
				return nil
			}
		}
		return nil
	})
	return out
}

func (s *Service) requestApproval(cmd, reason string) store.Approval {
	now := nowUTC()
	a := store.Approval{ID: store.NewID("apv"), Command: cmd, Reason: reason, Status: "pending", CreatedAt: now}
	_ = s.st.Mutate(func(st *store.State) error {
		st.Approvals = append(st.Approvals, a)
		s.st.AppendEvent(st, "approval", "等待你批准一个危险命令", reason+"："+truncate(cmd, 80), "", "")
		return nil
	})
	return a
}

func (s *Service) ListApprovals() []store.Approval {
	out := make([]store.Approval, 0)
	_ = s.st.View(func(st *store.State) error {
		for _, a := range st.Approvals {
			if a.Status == "pending" {
				out = append(out, a)
			}
		}
		return nil
	})
	return out
}

// ResolveApproval executes the stored command on approve (with the normal
// timeout), or marks it denied. It is the only path that bypasses the brake.
func (s *Service) ResolveApproval(ctx context.Context, id string, approve bool) (store.Approval, error) {
	var a store.Approval
	_ = s.st.View(func(st *store.State) error {
		for i := range st.Approvals {
			if st.Approvals[i].ID == id {
				a = st.Approvals[i]
			}
		}
		return nil
	})
	if a.ID == "" {
		return a, fmt.Errorf("approval not found")
	}
	if a.Status != "pending" {
		return a, fmt.Errorf("approval already resolved")
	}
	now := nowUTC()
	if !approve {
		a.Status = "denied"
		a.ResolvedAt = &now
		_ = s.saveApproval(a)
		return a, nil
	}
	out, err := s.executeTerminal(ctx, a.Command, 15)
	a.ResolvedAt = &now
	if err != nil {
		a.Status = "failed"
		a.Output = err.Error()
	} else {
		a.Status = "approved"
		a.Output = out
	}
	_ = s.saveApproval(a)
	return a, err
}

func (s *Service) saveApproval(a store.Approval) error {
	return s.st.Mutate(func(st *store.State) error {
		for i := range st.Approvals {
			if st.Approvals[i].ID == a.ID {
				st.Approvals[i] = a
			}
		}
		s.st.AppendEvent(st, "approval", "审批："+a.Status, truncate(a.Command, 80), "", "")
		return nil
	})
}

var _ = time.Now
