package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

func jsQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func (s *Service) xPost(ctx context.Context, text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text required")
	}
	script := `
	const ta = document.querySelector('[data-testid="tweetTextarea_0"]') || document.querySelector('[contenteditable="true"]');
	if (!ta) return { ok:false, error:'没有找到发帖框（可能未登录 X 或页面未加载）' };
	ta.focus();
	document.execCommand('insertText', false, ` + jsQuote(text) + `);
	await new Promise(r=>setTimeout(r,600));
	const btn = [...document.querySelectorAll('[data-testid="tweetButtonInline"],[data-testid="tweetButton"]')].find(b=>!b.disabled);
	if (!btn) return { ok:false, error:'没有找到发送按钮' };
	btn.click();
	await new Promise(r=>setTimeout(r,2500));
	return { ok:true, url: location.href };
	`
	out, err := s.BrowserEval(ctx, "https://x.com/compose/post", script, false)
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func biliScriptOnVideo(bvid, body string) string {
	return `
	const csrf = (document.cookie.match(/(?:^|; )bili_jct=([^;]+)/)||[])[1] || '';
	if (!csrf) return { ok:false, error:'未登录 B 站（缺少 bili_jct cookie）' };
	` + body
}

func (s *Service) biliAccount(ctx context.Context) (string, error) {
	script := `
	const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials:'include' });
	const d = await r.json();
	if (!d || d.code !== 0 || !d.data || !d.data.isLogin) return { ok:false, error:'B 站未登录', code:d && d.code };
	return { ok:true, uname:d.data.uname, mid:d.data.mid, sign:d.data.sign, level:d.data.level_info && d.data.level_info.current_level, coins:d.data.coins, vip:d.data.vipStatus===1 };
	`
	out, err := s.BrowserEval(ctx, "https://www.bilibili.com", script, false)
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func (s *Service) biliComment(ctx context.Context, bvid, text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("text required")
	}
	script := biliScriptOnVideo(bvid, `
	const r = await fetch('https://api.bilibili.com/x/v2/reply/add', { method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ oid:String(window.__aid||0), type:'1', message:`+jsQuote(text)+`, csrf }) });
	const d = await r.json();
	return { ok:d.code===0, code:d.code, message:d.message };
	`)
	// resolve aid from page first
	view, err := s.biliVideo(ctx, bvid)
	aid := ""
	if err == nil {
		_ = view
	}
	// fetch aid without browser via public API
	data, e := biliGet(ctx, "/x/web-interface/view?bvid="+bvid)
	if e == nil {
		if v, ok := data["aid"].(float64); ok { aid = fmt.Sprintf("%.0f", v) }
	}
	if aid == "" { return "", fmt.Errorf("cannot resolve aid") }
	script = strings.Replace(script, "String(window.__aid||0)", jsQuote(aid), 1)
	out, err := s.BrowserEval(ctx, "https://www.bilibili.com/video/"+bvid, script, false)
	if err != nil { return "", err }
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func (s *Service) biliLike(ctx context.Context, bvid string, like bool) (string, error) {
	l := "0"; if like { l = "1" }
	script := biliScriptOnVideo(bvid, `
	const r = await fetch('https://api.bilibili.com/x/web-interface/archive/like', { method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ bvid:`+jsQuote(bvid)+`, like:'`+l+`', csrf }) });
	const d = await r.json();
	return { ok:d.code===0, code:d.code, message:d.message };
	`)
	out, err := s.BrowserEval(ctx, "https://www.bilibili.com/video/"+bvid, script, false)
	if err != nil { return "", err }
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func (s *Service) biliProfile(ctx context.Context, uname, sign string) (string, error) {
	script := `
	const csrf = (document.cookie.match(/(?:^|; )bili_jct=([^;]+)/)||[])[1] || '';
	if (!csrf) return { ok:false, error:'未登录 B 站' };
	const body = new URLSearchParams({ csrf });
	if (` + jsQuote(uname) + `) body.set('uname', ` + jsQuote(uname) + `);
	if (` + jsQuote(sign) + `) body.set('usersign', ` + jsQuote(sign) + `);
	const r = await fetch('https://api.bilibili.com/x/member/web/update', { method:'POST', credentials:'include', body });
	const d = await r.json();
	return { ok:d.code===0, code:d.code, message:d.message };
	`
	out, err := s.BrowserEval(ctx, "https://member.bilibili.com/platform/home", script, false)
	if err != nil { return "", err }
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func (s *Service) biliPost(ctx context.Context, text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" { return "", fmt.Errorf("text required") }
	script := `
	const csrf = (document.cookie.match(/(?:^|; )bili_jct=([^;]+)/)||[])[1] || '';
	if (!csrf) return { ok:false, error:'未登录 B 站' };
	const dynReq = { content: { contents: [{ raw_text: ` + jsQuote(text) + `, type: 1, biz_id: '' }] }, scene: 1, attach_card: null, upload_id: '', meta: { app_meta: { from: 'web' } } };
	const r = await fetch('https://api.bilibili.com/x/dynamic/feed/create/dyn?platform=web&csrf=' + encodeURIComponent(csrf), { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dyn_req: dynReq }) });
	const d = await r.json();
	return { ok:d.code===0, code:d.code, message:d.message, data:d.data };
	`
	out, err := s.BrowserEval(ctx, "https://t.bilibili.com", script, false)
	if err != nil { return "", err }
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}

func (s *Service) xProfile(ctx context.Context, name, bio string) (string, error) {
	if strings.TrimSpace(name) == "" && strings.TrimSpace(bio) == "" {
		return "", fmt.Errorf("name or bio required")
	}
	script := `
	const setVal = (el, val) => {
	  if (!el || !val) return false;
	  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
	  setter ? setter.call(el, val) : (el.value = val);
	  el.dispatchEvent(new Event('input', { bubbles: true }));
	  el.dispatchEvent(new Event('change', { bubbles: true }));
	  return true;
	};
	const name = document.querySelector('input[name="displayName"]') || document.querySelector('input[autocomplete="name"]');
	const bio = document.querySelector('textarea[name="description"]') || document.querySelector('textarea');
	if (!name && !bio) return { ok:false, error:'没有找到资料编辑表单（可能未登录 X）' };
	setVal(name, ` + jsQuote(name) + `);
	setVal(bio, ` + jsQuote(bio) + `);
	await new Promise(r=>setTimeout(r,600));
	const btn = [...document.querySelectorAll('[data-testid="Profile_Save_Button"],button')].find(b=>/save|保存/i.test(b.textContent||''));
	if (!btn) return { ok:false, error:'没有找到保存按钮' };
	btn.click();
	await new Promise(r=>setTimeout(r,2000));
	return { ok:true, url: location.href };
	`
	out, err := s.BrowserEval(ctx, "https://x.com/settings/profile", script, false)
	if err != nil {
		return "", err
	}
	b, _ := json.Marshal(out["result"])
	return string(b), nil
}
