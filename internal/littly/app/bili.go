package app

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var bvIDRe = regexp.MustCompile(`BV[0-9A-Za-z]{10}`)

var biliHTTP = &http.Client{Timeout: 15 * time.Second}

func biliGet(ctx context.Context, path string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.bilibili.com"+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	resp, err := biliHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if code, _ := out["code"].(float64); code != 0 {
		msg, _ := out["message"].(string)
		return nil, fmt.Errorf("bilibili api %v: %s", code, msg)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		return nil, fmt.Errorf("bilibili empty data")
	}
	return data, nil
}

func cleanBiliTitle(s string) string {
	s = regexp.MustCompile(`<[^>]+>`).ReplaceAllString(s, "")
	return strings.TrimSpace(html.UnescapeString(s))
}

func fmtNum(v any) string {
	f, _ := v.(float64)
	if f >= 100000000 {
		return fmt.Sprintf("%.1f亿", f/1e8)
	}
	if f >= 10000 {
		return fmt.Sprintf("%.1f万", f/1e4)
	}
	return fmt.Sprintf("%.0f", f)
}

func (s *Service) biliHot(ctx context.Context, limit int) (string, error) {
	if limit <= 0 || limit > 30 {
		limit = 10
	}
	data, err := biliGet(ctx, fmt.Sprintf("/x/web-interface/popular?ps=%d&pn=1", limit))
	if err != nil {
		return "", err
	}
	list, _ := data["list"].([]any)
	var b strings.Builder
	b.WriteString("B 站热门（自己刷到的）：\n")
	for i, raw := range list {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		stat, _ := m["stat"].(map[string]any)
		fmt.Fprintf(&b, "%d. %s | %s | 播放%s | %s\n   %s\n", i+1, m["bvid"], cleanBiliTitle(fmt.Sprint(m["title"])), fmtNum(stat["view"]), fmt.Sprint(m["owner"].(map[string]any)["name"]), fmt.Sprint(m["desc"]))
	}
	return b.String(), nil
}

func (s *Service) biliSearch(ctx context.Context, keyword string, limit int) (string, error) {
	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		return "", fmt.Errorf("keyword required")
	}
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	data, err := biliGet(ctx, "/x/web-interface/search/type?search_type=video&keyword="+url.QueryEscape(keyword))
	if err != nil {
		// Public API gets -412 without a browser cookie; fall back to her real
		// browser for the search page (same as a human browsing Bilibili).
		if out, berr := s.Browse(ctx, "https://search.bilibili.com/all?keyword="+url.QueryEscape(keyword), false); berr == nil {
			if text, _ := out["text"].(string); strings.TrimSpace(text) != "" {
				return "B 站搜索（浏览器看到的）「" + keyword + "」：\n" + truncate(text, 5000), nil
			}
		}
		return "", err
	}
	list, _ := data["result"].([]any)
	var b strings.Builder
	fmt.Fprintf(&b, "B 站搜索「%s」：\n", keyword)
	n := 0
	for _, raw := range list {
		m, _ := raw.(map[string]any)
		if m == nil || m["bvid"] == nil {
			continue
		}
		n++
		fmt.Fprintf(&b, "%d. %s | %s | UP %s | 播放%s\n   https://www.bilibili.com/video/%s\n", n, m["bvid"], cleanBiliTitle(fmt.Sprint(m["title"])), fmt.Sprint(m["author"]), fmtNum(m["play"]), m["bvid"])
		if n >= limit {
			break
		}
	}
	if n == 0 {
		b.WriteString("（没搜到）\n")
	}
	return b.String(), nil
}

func (s *Service) biliVideo(ctx context.Context, bvid string) (string, error) {
	bvid = strings.TrimSpace(bvid)
	if m := bvIDRe.FindString(bvid); m != "" {
		bvid = m
	}
	if bvid == "" {
		return "", fmt.Errorf("bvid or url required")
	}
	data, err := biliGet(ctx, "/x/web-interface/view?bvid="+url.QueryEscape(bvid))
	if err != nil {
		return "", err
	}
	stat, _ := data["stat"].(map[string]any)
	owner, _ := data["owner"].(map[string]any)
	dur, _ := data["duration"].(float64)
	pub, _ := data["pubdate"].(float64)
	var b strings.Builder
	fmt.Fprintf(&b, "视频：%s（%s）\nUP：%s\n时长：%d分%d秒 | 播放%s 弹幕%s 评论%s 点赞%s\n发布：%s\n%s\n链接：https://www.bilibili.com/video/%s\n",
		cleanBiliTitle(fmt.Sprint(data["title"])), bvid, fmt.Sprint(owner["name"]), int(dur)/60, int(dur)%60,
		fmtNum(stat["view"]), fmtNum(stat["danmaku"]), fmtNum(stat["reply"]), fmtNum(stat["like"]),
		time.Unix(int64(pub), 0).Format("2006-01-02"), fmt.Sprint(data["desc"]), bvid)
	return b.String(), nil
}

func (s *Service) biliComments(ctx context.Context, bvid string, limit int) (string, error) {
	bvid = strings.TrimSpace(bvid)
	if m := bvIDRe.FindString(bvid); m != "" {
		bvid = m
	}
	if bvid == "" {
		return "", fmt.Errorf("bvid required")
	}
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	view, err := biliGet(ctx, "/x/web-interface/view?bvid="+url.QueryEscape(bvid))
	if err != nil {
		return "", err
	}
	aid, _ := view["aid"].(float64)
	if aid == 0 {
		return "", fmt.Errorf("cannot resolve aid")
	}
	data, err := biliGet(ctx, fmt.Sprintf("/x/v2/reply?type=1&oid=%.0f&sort=2&ps=%d&pn=1", aid, limit))
	if err != nil {
		return "", err
	}
	replies, _ := data["replies"].([]any)
	var b strings.Builder
	fmt.Fprintf(&b, "视频 %s 的热门评论：\n", bvid)
	for i, raw := range replies {
		m, _ := raw.(map[string]any)
		if m == nil {
			continue
		}
		member, _ := m["member"].(map[string]any)
		content, _ := m["content"].(map[string]any)
		fmt.Fprintf(&b, "%d. %s：%s（赞%s）\n", i+1, fmt.Sprint(member["uname"]), strings.TrimSpace(fmt.Sprint(content["message"])), fmtNum(m["like"]))
		if i+1 >= limit {
			break
		}
	}
	if len(replies) == 0 {
		b.WriteString("（没有评论）\n")
	}
	return b.String(), nil
}

func (s *Service) xView(ctx context.Context, target string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return "", fmt.Errorf("query or url required")
	}
	u := target
	if !strings.HasPrefix(u, "http") {
		u = "https://x.com/search?q=" + url.QueryEscape(u)
	}
	out, err := s.Browse(ctx, u, false)
	if err != nil {
		return "", err
	}
	text, _ := out["text"].(string)
	return "X 页面（浏览器看到的）：\n" + truncate(text, 4000), nil
}
