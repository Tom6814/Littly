/* Littly v2 UI: six surfaces, no build step. */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const S = { boot: null, today: null, world: null, view: "today", memQ: "", memTab: "memories", filesPath: "", file: null, poll: null };

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(t) { if (!t) return "—"; const d = new Date(t); return isNaN(d) ? "—" : d.toLocaleString("zh-CN", { hour12: false }); }
function fmtShort(t) { if (!t) return "—"; const d = new Date(t); return isNaN(d) ? "—" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = "list-item";
  el.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:99;max-width:360px;" + (bad ? "border-color:var(--danger)" : "");
  el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4200);
}
async function api(path, opts = {}) {
  const r = await fetch("/littly/api" + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + r.status));
  return data;
}
function go(view) { location.hash = "#/" + view; }
function setTitle(title, sub = "") { $("#page-title").textContent = title; $("#page-sub").textContent = sub; }
function pills() {
  const rt = S.today?.runtime || {};
  $("#state-pills").innerHTML = [
    ["精力", rt.energy], ["心情", rt.mood], ["社交", rt.social_need], ["饱腹", rt.satiety],
  ].map(([k, v]) => `<span class="pill">${k} <b>${v ?? "—"}</b></span>`).join("") +
    `<span class="pill">下次心跳 <b>${esc(S.today?.next_heartbeat?.next_in || "—")}</b></span>`;
}

async function loadBoot() { S.boot = await api("/bootstrap"); }
async function loadToday() { S.today = await api("/today"); }
async function loadWorld() { S.world = await api("/world"); }

function navActive(view) { $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view)); }

function render() {
  const view = (location.hash.replace(/^#\//, "") || "today").split("?")[0];
  S.view = view; navActive(view);
  const fn = { today: renderToday, her: renderHer, memory: renderMemory, workbench: renderWorkbench, world: renderWorld, settings: renderSettings }[view] || renderToday;
  fn().catch((e) => { $("#view").innerHTML = `<div class="card col-12"><div class="empty">加载失败：${esc(e.message)}</div></div>`; toast(e.message, true); });
  schedulePoll(view);
}
function schedulePoll(view) {
  if (S.poll) clearInterval(S.poll);
  if (["today", "world", "settings"].includes(view)) {
    S.poll = setInterval(async () => { try { await loadToday(); if (view === "today") renderToday(); if (view === "world") renderWorld(); if (view === "settings") updateHealth(); } catch {} }, 8000);
  }
}

async function renderToday() {
  await loadToday();
  const t = S.today, rt = t.runtime, hb = t.next_heartbeat || {};
  const health = t.health || S.boot?.health || {};
  setTitle("今天", `${esc(S.boot?.person?.name)} · ${esc(S.boot?.person?.timezone)} · ${esc(S.boot?.model?.model)}`);
  pills();
  const running = (t.activities || []).filter((a) => a.status === "running" || a.status === "paused");
  const run = running[0];
  const msgs = (t.messages || []).map((m) => `
    <div class="bubble ${m.role === "user" ? "user" : "assistant"}">
      ${esc(m.content)}<div class="meta">${fmtShort(m.at)} · ${m.role === "user" ? "你" : "她"}</div>
    </div>`).join("") || `<div class="empty">还没有对话。说点什么，或者先看着她自己过。</div>`;
  const events = (t.events || []).slice(0, 14).map((e) => `<div class="tl"><time>${fmtShort(e.at)}</time><div>${esc(e.title)}${e.detail ? `<div class="muted tiny">${esc(e.detail)}</div>` : ""}</div></div>`).join("") || `<div class="empty">还没有事件</div>`;
  const runs = (t.heartbeat_runs || []).map((r) => `<div class="list-item"><div class="t">${esc(r.outcome)} · ${esc(r.kind)}</div><div class="m">${esc(r.summary || "")} · ${fmtShort(r.started_at)}</div></div>`).join("") || `<div class="empty">还没有心跳</div>`;
  $("#view").innerHTML = `
    <section class="card col-4"><h3>她的状态</h3>
      <div class="row between"><div><h2>${esc(rt.attention || "没什么特别的事")}</h2>
      <div class="muted tiny">精力 ${rt.energy} · 心情 ${rt.mood} · 社交 ${rt.social_need} · 饱腹 ${rt.satiety}</div></div>
      <span class="badge ${health.status === "ok" ? "ok" : "warn"}">${esc(health.status || "unknown")}</span></div>
      <div class="row" style="margin-top:10px"><button class="ghost" onclick="act('heartbeat','now')">现在心跳</button>
      <button class="ghost" onclick="act('heartbeat','pause')">暂停</button><button class="ghost" onclick="act('heartbeat','resume')">恢复</button></div>
    </section>
    <section class="card col-4"><h3>心跳</h3><div class="kv">
      <div>下次</div><div>${hb.next_at ? fmt(hb.next_at) : "—"}</div>
      <div>还有</div><div>${esc(hb.next_in || "—")}</div>
      <div>理由</div><div>${esc(hb.self?.reason || "（例行）")}</div></div>
      <div class="row" style="margin-top:10px"><button class="ghost" onclick="act('dream')">整理今天（Dream）</button></div>
    </section>
    <section class="card col-4"><h3>她正在做</h3>${run ? `<h2>${esc(run.title)}</h2><div class="muted tiny">${esc(run.kind)} · ${run.progress || 0}% · ${esc(run.status)}</div>` : `<div class="empty">现在没在做事</div>`}
      <div class="row" style="margin-top:10px"><button class="ghost" onclick="runActivity()">让她自己做点事</button></div>
      <div class="muted tiny" style="margin-top:8px">活动也会在她自己的时间里发生；你也可以在下方跟她聊。</div></section>
    <section class="card col-8"><h3>和她说话</h3><div class="chat">
      <div class="msgs" id="msgs">${msgs}</div>
      <div class="composer"><input id="chat-input" placeholder="说点什么…（Enter 发送）" /><button class="primary" onclick="sendChat()">发送</button></div>
    </div></section>
    <section class="card col-4"><h3>最近事件</h3><div class="timeline">${events}</div></section>
    <section class="card col-6"><h3>待你批准</h3><div class="list">${(t.approvals || []).map((a) => `<div class="list-item"><div class="t">${esc(a.reason)}</div><div class="m mono">${esc(a.command)}</div><div class="row" style="margin-top:6px"><button class="ghost" onclick="resolveApproval('${a.id}',true)">批准执行</button><button class="ghost danger" onclick="resolveApproval('${a.id}',false)">拒绝</button></div></div>`).join("") || `<div class="empty">没有待批准的危险操作</div>`}</div></section>
    <section class="card col-6"><h3>最近心跳</h3><div class="list">${runs}</div></section>
    <section class="card col-6"><h3>她的活动</h3><div class="list">${(t.activities || []).slice(0, 8).map((a) => `<div class="list-item"><div class="t">${esc(a.title)}<span class="badge" style="margin-left:6px">${esc(a.status)}</span></div><div class="m">${esc(a.kind)} · ${a.progress || 0}% · ${fmtShort(a.created_at)}</div></div>`).join("") || `<div class="empty">还没有活动</div>`}</div></section>`;
  $("#chat-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  const box = $("#msgs"); if (box) box.scrollTop = box.scrollHeight;
}
async function sendChat() {
  const input = $("#chat-input"); const content = input.value.trim(); if (!content) return;
  input.value = "";
  try {
    const r = await api("/chat", { method: "POST", body: JSON.stringify({ content }) });
    if (r.replied) toast("她回了");
    else toast(r.reason || "她这次没回");
    await renderToday();
  } catch (e) { toast(e.message, true); }
}
async function resolveApproval(id, approve) {
  try { await api(`/approvals/${id}/${approve ? "approve" : "deny"}`, { method: "POST" }); toast(approve ? "已批准并执行" : "已拒绝"); await renderToday(); }
  catch (e) { toast(e.message, true); }
}
async function runActivity() {
  try { const r = await api("/activities/run", { method: "POST" }); toast("她开始做：" + (r.activity?.title || "事情")); await renderToday(); }
  catch (e) { toast(e.message, true); }
}
async function act(kind, action) {
  try {
    if (kind === "dream") await api("/dream", { method: "POST" });
    else await api("/heartbeat", { method: "POST", body: JSON.stringify({ action }) });
    toast("已执行"); await renderToday();
  } catch (e) { toast(e.message, true); }
}

async function renderHer() {
  if (!S.boot) await loadBoot();
  const p = S.boot.person, traits = p.traits || {};
  setTitle("她", "人设、性格与边界 —— 这是种子，不是模板");
  const prefs = ["clinginess", "social_energy", "pride", "patience", "curiosity", "orderliness", "possessiveness", "expressiveness", "independence"];
  const labels = { clinginess: "粘人", social_energy: "社交能量", pride: "自尊", patience: "耐心", curiosity: "好奇", orderliness: "秩序", possessiveness: "占有欲", expressiveness: "表达欲", independence: "独立" };
  $("#view").innerHTML = `
    <section class="card col-6"><h3>基本</h3>
      <label>名字</label><input id="p-name" value="${esc(p.name)}" />
      <label>昵称</label><input id="p-nick" value="${esc(p.nickname || "")}" />
      <label>说话方式</label><textarea id="p-style" rows="3">${esc(p.style || "")}</textarea>
      <label>边界 / 雷区</label><textarea id="p-bounds" rows="3">${esc(p.boundaries || "")}</textarea>
      <div class="row" style="margin-top:12px"><button class="primary" onclick="savePersona()">保存</button></div>
    </section>
    <section class="card col-6"><h3>性格（0–100）</h3>
      ${prefs.map((k) => `<label>${labels[k]} <span class="muted">${traits[k] ?? 50}</span></label><input type="range" min="0" max="100" value="${traits[k] ?? 50}" data-trait="${k}" oninput="this.previousElementSibling.querySelector('span').textContent=this.value" />`).join("")}
      <div class="row" style="margin-top:12px"><button class="primary" onclick="saveTraits()">保存性格</button></div>
    </section>
    <section class="card col-12"><h3>自我（SELF）</h3><textarea id="p-self" rows="8">${esc(p.self || "")}</textarea>
      <div class="row" style="margin-top:12px"><button class="primary" onclick="saveSelf()">保存 SELF</button></div>
    </section>`;
}
async function savePersona() {
  try {
    await api("/config", { method: "PUT", body: JSON.stringify({ name: $("#p-name").value, nickname: $("#p-nick").value, style: $("#p-style").value, boundaries: $("#p-bounds").value }) });
    await loadBoot(); toast("已保存"); renderHer();
  } catch (e) { toast(e.message, true); }
}
async function saveSelf() {
  try { await api("/config", { method: "PUT", body: JSON.stringify({ self: $("#p-self").value }) }); await loadBoot(); toast("已保存"); }
  catch (e) { toast(e.message, true); }
}
async function saveTraits() {
  const traits = {};
  $$("[data-trait]").forEach((el) => traits[el.dataset.trait] = Number(el.value));
  try { await api("/config", { method: "PUT", body: JSON.stringify({ traits }) }); await loadBoot(); toast("已保存"); }
  catch (e) { toast(e.message, true); }
}

async function renderMemory() {
  setTitle("记忆", "她自己的记忆；私密抽屉在网页端不可见");
  $("#view").innerHTML = `
    <section class="card col-12"><div class="tabs">
      <button class="${S.memTab === "memories" ? "active" : ""}" onclick="S.memTab='memories';renderMemory()">记忆</button>
      <button class="${S.memTab === "people" ? "active" : ""}" onclick="S.memTab='people';renderMemory()">人物</button>
      <button class="${S.memTab === "diaries" ? "active" : ""}" onclick="S.memTab='diaries';renderMemory()">日记</button>
      <button class="${S.memTab === "archive" ? "active" : ""}" onclick="S.memTab='archive';renderMemory()">回收站</button>
    </div><div id="mem-body">加载中…</div></section>`;
  if (S.memTab === "memories") await renderMemories();
  else if (S.memTab === "people") await renderPeople();
  else if (S.memTab === "diaries") await renderDiaries();
  else await renderArchive();
}
async function renderMemories() {
  const data = await api("/memories?q=" + encodeURIComponent(S.memQ));
  const list = data.memories || [];
  $("#mem-body").innerHTML = `<div class="row" style="margin-bottom:12px"><input id="mem-q" placeholder="搜她的记忆…" value="${esc(S.memQ)}" onkeydown="if(event.key==='Enter'){S.memQ=this.value;renderMemories()}"/><button onclick="S.memQ=document.getElementById('mem-q').value;renderMemories()">搜索</button></div>
    <div class="row" style="margin-bottom:12px"><input id="mem-title" placeholder="记忆标题（你替她记一条）" style="flex:1" /><input id="mem-body" placeholder="正文" style="flex:2" /><button onclick="createMemory()">记下</button></div>
    <div class="list">${list.map((m) => `<div class="list-item"><div class="t">${esc(m.title)}</div><div class="m">${esc(m.domain)} · ${esc(m.kind)} · ${fmt(m.event_time)} · ${esc(m.visibility)}</div><div class="tiny" style="margin-top:6px">${esc(m.body)}</div></div>`).join("") || `<div class="empty">还没有记忆</div>`}</div>`;
}
async function renderDiaries() {
  const data = await api("/diaries");
  const list = data.diaries || [];
  $("#mem-body").innerHTML = `<div class="list">${list.map((d) => `<div class="list-item"><div class="t">${esc(d.day || fmt(d.at))} <span class="badge">${esc(d.mood || "")}</span></div><div class="tiny" style="margin-top:6px;white-space:pre-wrap">${esc(d.content)}</div><div class="m">${esc(d.summary || "")}</div></div>`).join("") || `<div class="empty">还没有日记。也许今晚 Dream 会写。</div>`}</div>`;
}
async function createMemory() {
  const title = $("#mem-title").value.trim(), body = $("#mem-body").value.trim();
  if (!title || !body) { toast("标题和正文都要有", true); return; }
  try { await api("/memories", { method: "POST", body: JSON.stringify({ title, body, domain: "life", importance: 3, visibility: "public" }) }); toast("记下了"); renderMemories(); }
  catch (e) { toast(e.message, true); }
}
async function createPerson() {
  const name = $("#p-name").value.trim(); if (!name) { toast("名字必填", true); return; }
  try { await api("/people", { method: "POST", body: JSON.stringify({ name, channel: $("#p-channel").value, external_id: $("#p-ext").value }) }); toast("已添加"); renderWorld(); }
  catch (e) { toast(e.message, true); }
}
async function renderPeople() {
  const data = await api("/people");
  const people = data.people || [];
  $("#mem-body").innerHTML = `<div class="grid-people">${people.map((p) => `<div class="list-item"><div class="row between"><b>${esc(p.name)}</b><span class="badge ${p.important ? "warn" : ""}">${esc(p.tier)}</span></div>
    <div class="m">${esc(p.brief || "")}</div><div class="m">亲密度 ${p.closeness} · ${esc(p.channel)} · 互动 ${p.interactions || 0}</div>
    <div class="row" style="margin-top:8px"><button class="ghost" onclick="toggleImportant('${p.id}',${!p.important})">${p.important ? "取消重要" : "标为重要"}</button>
    ${p.relationship === "owner" ? "" : `<select onchange="setTier('${p.id}', this.value)" style="width:auto"><option value="stranger" ${p.tier === "stranger" ? "selected" : ""}>陌生</option><option value="acquaintance" ${p.tier === "acquaintance" ? "selected" : ""}>泛泛之交</option><option value="friend" ${p.tier === "friend" ? "selected" : ""}>朋友</option><option value="intimate" ${p.tier === "intimate" ? "selected" : ""}>亲密</option></select>`}
    <button class="ghost danger" onclick="archivePerson('${p.id}')">放进回收站</button></div></div>`).join("") || `<div class="empty">还没有人物</div>`}</div>`;
}
async function setTier(id, tier) { try { await api(`/people/${id}/tier`, { method: "POST", body: JSON.stringify({ tier }) }); toast("关系已调整"); renderPeople(); } catch (e) { toast(e.message, true); } }
async function toggleImportant(id, important) { try { await api(`/people/${id}/important`, { method: "POST", body: JSON.stringify({ important }) }); renderPeople(); } catch (e) { toast(e.message, true); } }
async function archivePerson(id) { try { await api(`/people/${id}/archive`, { method: "POST" }); toast("已归档"); renderPeople(); } catch (e) { toast(e.message, true); } }
async function renderArchive() {
  const q = S.archiveQ || "";
  const data = await api("/archive?q=" + encodeURIComponent(q));
  const list = data.candidates || [];
  $("#mem-body").innerHTML = `<div class="row" style="margin-bottom:12px"><input id="arc-q" placeholder="在回收站搜名字 / 事件…" value="${esc(q)}" onkeydown="if(event.key==='Enter'){S.archiveQ=this.value;renderArchive()}"/><button onclick="S.archiveQ=document.getElementById('arc-q').value;renderArchive()">搜索</button></div>
    <div class="list">${list.map((p) => `<div class="list-item"><div class="row between"><b>${esc(p.name)}</b><span class="badge">${esc(p.tier)}</span></div><div class="m">${esc(p.brief || "")} · 最后 ${esc(p.last_seen || "—")}</div>${p.memories?.length ? `<div class="m">相关记忆：${esc(p.memories.join("；"))}</div>` : ""}
    <div class="row" style="margin-top:8px"><button class="ghost" onclick="restorePerson('${p.people_id}')">恢复</button></div></div>`).join("") || `<div class="empty">没有找到。她可以不记得。</div>`}</div>`;
}
async function restorePerson(id) { try { await api(`/archive/${id}/restore`, { method: "POST" }); toast("已恢复"); renderArchive(); } catch (e) { toast(e.message, true); } }

async function renderWorkbench() {
  setTitle("工作台", "她的电脑：文件、产出、活动");
  const [files, arts, acts] = await Promise.all([api("/files?path=" + encodeURIComponent(S.filesPath)), api("/artifacts"), api("/activities")]);
  const entries = Array.isArray(files) ? files : [];
  const content = S.file ? `<pre class="mono" style="white-space:pre-wrap;max-height:420px;overflow:auto">${esc(S.file.content)}</pre>` : `<div class="empty">点一个文件看内容</div>`;
  $("#view").innerHTML = `
    <section class="card col-4"><h3>文件 ${esc(S.filesPath || "/")}</h3>
      <div class="row" style="margin-bottom:8px"><button class="ghost" onclick="S.filesPath='';S.file=null;renderWorkbench()">根目录</button>${S.filesPath ? `<button class="ghost" onclick="S.filesPath=S.filesPath.split('/').slice(0,-1).join('/');renderWorkbench()">上一级</button>` : ""}</div>
      <div class="list">${entries.map((f) => `<div class="list-item" style="cursor:pointer" onclick="${f.dir ? `S.filesPath='${esc((S.filesPath ? S.filesPath + "/" : "") + f.name)}';renderWorkbench()` : `openFile('${esc((S.filesPath ? S.filesPath + "/" : "") + f.name)}')`}">${f.dir ? "📁" : "📄"} ${esc(f.name)} <span class="muted tiny">${f.size ? Math.round(f.size / 1024) + " KB" : ""}</span></div>`).join("") || `<div class="empty">空目录</div>`}</div>
    </section>
    <section class="card col-8"><h3>${S.file ? esc(S.file.path) : "文件内容"}</h3>${content}</section>
    <section class="card col-12"><h3>终端 · 她的电脑</h3>
      <div class="row"><input id="term-cmd" placeholder="cd /opt/memoh/data/littly/workspace 下执行…" style="flex:1" onkeydown="if(event.key==='Enter')runTerminal()" /><button class="primary" onclick="runTerminal()">执行</button></div>
      <pre id="term-out" class="mono" style="white-space:pre-wrap;max-height:240px;overflow:auto;margin-top:10px;color:var(--muted)">（输出）</pre>
      <div class="muted tiny">受 workbench.allow_shell 控制；限时 15 秒、输出 16KB。这是她自己的电脑，不是安全沙箱。</div></section>
    <section class="card col-12"><h3>她的桌面</h3>
      <div class="row" style="margin-bottom:8px"><a class="badge" href="http://127.0.0.1:6082/vnc.html?autoconnect=true&resize=scale&host=127.0.0.1&port=6082&path=websockify" target="_blank">新标签打开桌面</a><span class="muted tiny">TigerVNC · 1280×800 · 只绑定 127.0.0.1</span></div>
      <iframe src="http://127.0.0.1:6082/vnc.html?autoconnect=true&resize=scale&host=127.0.0.1&port=6082&path=websockify" style="width:100%;height:520px;border:1px solid var(--line);border-radius:10px;background:#000" title="Littly desktop"></iframe></section>
    <section class="card col-12"><h3>浏览器 · 她的电脑</h3>
      <div class="row"><input id="browser-url" placeholder="https://example.com" style="flex:1" onkeydown="if(event.key==='Enter')runBrowser()" /><label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="browser-shot" checked style="width:auto" /> 截图</label><button class="primary" onclick="runBrowser()">打开</button></div>
      <div id="browser-out" class="muted tiny" style="margin-top:8px;white-space:pre-wrap;max-height:260px;overflow:auto"></div></section>
    <section class="card col-12"><h3>快照 · 回滚她的文件</h3>
      <div class="row"><button class="primary" onclick="takeSnapshot()">拍快照</button><span class="muted tiny">保存到 data/snapshots，可恢复工作台文件</span></div>
      <div id="snapshot-list" class="list" style="margin-top:10px">加载中…</div></section>
    <section class="card col-6"><h3>产出（artifacts）</h3><div class="list">${arts.artifacts.map((a) => `<div class="list-item"><div class="t">${a.kind === "snapshot" ? esc(a.title) : `<a href="/littly/api/files/raw?path=${encodeURIComponent(a.path)}" target="_blank">${esc(a.title)}</a>`}</div><div class="m">${esc(a.path)} · ${a.bytes || 0} B · ${fmt(a.created_at)}</div></div>`).join("") || `<div class="empty">还没有产出</div>`}</div></section>
    <section class="card col-6"><h3>活动</h3><div class="list">${acts.activities.map((a) => `<div class="list-item"><div class="t">${esc(a.title)} <span class="badge">${esc(a.status)}</span></div><div class="m">${esc(a.kind)} · ${a.progress || 0}% · ${esc(a.summary || "")}</div></div>`).join("") || `<div class="empty">还没有活动</div>`}</div></section>`;
  refreshSnapshots();
}
async function runTerminal() {
  const cmd = $("#term-cmd").value.trim(); if (!cmd) return;
  $("#term-out").textContent = "…";
  try { const r = await api("/terminal", { method: "POST", body: JSON.stringify({ command: cmd }) }); $("#term-out").textContent = r.output || "(无输出)"; }
  catch (e) { $("#term-out").textContent = "错误：" + e.message; }
}
async function refreshSnapshots() {
  try {
    const d = await api("/snapshots");
    $("#snapshot-list").innerHTML = (d.snapshots || []).map((x) => `<div class="list-item"><div class="row between"><span class="mono tiny">${esc(x.id)}</span><button class="ghost" onclick="restoreSnapshot('${esc(x.id)}')">恢复</button></div><div class="m">${Math.round((x.bytes || 0)/1024)} KB · ${fmt(x.created_at)}</div></div>`).join("") || `<div class="empty">还没有快照</div>`;
  } catch (e) { $("#snapshot-list").textContent = e.message; }
}
async function takeSnapshot() { try { const r = await api("/snapshots", { method: "POST" }); toast("已拍快照：" + r.id); await renderWorkbench(); } catch (e) { toast(e.message, true); } }
async function restoreSnapshot(id) { if (!confirm("恢复 " + id + "？会覆盖同名文件")) return; try { const r = await api(`/snapshots/${encodeURIComponent(id)}/restore`, { method: "POST" }); toast("恢复了 " + r.files + " 个文件"); await renderWorkbench(); } catch (e) { toast(e.message, true); } }
async function runBrowser() {
  const url = $("#browser-url").value.trim(); if (!url) return;
  const el = $("#browser-out"); el.textContent = "打开中…";
  try {
    const r = await api("/browser", { method: "POST", body: JSON.stringify({ url, screenshot: $("#browser-shot").checked }) });
    el.textContent = `标题：${r.title || "(无)"}\n${r.screenshot ? "截图：" + r.screenshot + "\n" : ""}\n${(r.text || "").slice(0, 4000)}`;
    await renderWorkbench();
  } catch (e) { el.textContent = "错误：" + e.message; }
}
async function openFile(path) { try { S.file = await api("/files/content?path=" + encodeURIComponent(path)); renderWorkbench(); } catch (e) { toast(e.message, true); } }

async function renderWorld() {
  await loadWorld();
  const w = S.world, sl = w.channels?.snowluma || {};
  setTitle("世界", "渠道、联系人、工具");
  $("#view").innerHTML = `
    <section class="card col-6"><h3>QQ · SnowLuma</h3><div class="kv">
      <div>开关</div><div>${sl.enabled ? "开" : "关"}</div><div>连接</div><div><span class="badge ${sl.connected ? "ok" : "warn"}">${sl.connected ? "已连接" : (sl.state === "waiting_login" ? "等待扫码登录" : (sl.last_error || "未连接"))}</span></div>
      <div>账号</div><div>${esc(sl.account || "未绑定")}</div><div>WS</div><div class="mono">${esc(sl.ws_url || "")}</div></div>
      <div class="muted tiny" style="margin-top:8px">QQ 走 SnowLuma OneBot v11；账号唯一归属。首次需要扫码：<a href="http://127.0.0.1:6081/vnc.html" target="_blank">noVNC 扫码登录</a> · <a href="http://127.0.0.1:5099/" target="_blank">SnowLuma WebUI</a></div>
      <details style="margin-top:10px"><summary class="muted tiny" style="cursor:pointer">在页面里打开 QQ 登录窗口</summary>
        <iframe src="http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale&host=127.0.0.1&port=6081&path=websockify" style="width:100%;height:520px;border:1px solid var(--line);border-radius:10px;margin-top:8px;background:#000" title="QQ noVNC"></iframe>
      </details></section>
    <section class="card col-6"><h3>她的电脑</h3><div class="kv"><div>vault</div><div class="mono">${esc(w.dirs?.vault || "")}</div><div>workspace</div><div class="mono">${esc(w.dirs?.workspace || "")}</div><div>模型</div><div>${esc(w.model || "")}</div></div></section>
    <section class="card col-12"><h3>联系人</h3>
      <div class="row" style="margin-bottom:10px"><input id="p-name" placeholder="名字" style="flex:1" /><input id="p-channel" placeholder="渠道（manual/qq/…）" style="flex:1" /><input id="p-ext" placeholder="外部 ID（可空）" style="flex:1" /><button onclick="createPerson()">添加</button></div>
      <div id="world-people" class="grid-people">加载中…</div></section>`;
  const data = await api("/people");
  $("#world-people").innerHTML = data.people.map((p) => `<div class="list-item"><b>${esc(p.name)}</b><div class="m">${esc(p.tier)} · ${esc(p.channel)} · ${esc(p.brief || "")}</div></div>`).join("") || `<div class="empty">还没有联系人</div>`;
}

async function renderSettings() {
  if (!S.boot) await loadBoot();
  const b = S.boot;
  setTitle("设置", "把乱七八糟的 bot 设置收成一份：基本 / 模型 / 心跳 / QQ / 工作台 / 健康 / 关于");
  $("#view").innerHTML = `
    <div class="settings-grid">
      <section class="card"><h3>基本</h3>
        <div class="kv"><div>实例</div><div>单实例 · 一个人</div><div>时区</div><div>${esc(b.person.timezone)}</div><div>配置</div><div class="mono">conf/littly.json</div></div>
        <div class="muted tiny" style="margin-top:8px">旧的多 Bot / 多用户 / 市场 / ACP 设置不再出现在这个入口。</div></section>
      <section class="card"><h3>模型</h3>
        <label>模型</label><input id="set-model" value="${esc(b.model.model)}" />
        <label>温度</label><input id="set-temp" type="number" step="0.1" min="0" max="2" value="${b.model.temperature}" />
        <div class="row" style="margin-top:10px"><button class="primary" onclick="saveModel()">保存</button><button class="ghost" onclick="testModel()">测试模型连接</button></div>
        <div id="model-test" class="muted tiny" style="margin-top:6px"></div>
        <div class="muted tiny" style="margin-top:8px">DeepSeek API key 通过环境变量 LITTLY_API_KEY 注入，不落库、不回显。</div></section>
      <section class="card"><h3>心跳</h3>
        <label><input type="checkbox" id="set-hb" ${b.heartbeat.enabled ? "checked" : ""} style="width:auto" /> 启用</label>
        <label>白天间隔（分钟）</label><input id="set-day" type="number" min="5" max="240" value="${b.heartbeat.day_minutes}" />
        <label>夜间间隔（分钟）</label><input id="set-night" type="number" min="10" max="480" value="${b.heartbeat.night_minutes}" />
        <label>Dream 整点（0-23）</label><input id="set-dream" type="number" min="0" max="23" value="${b.memory?.dream_hour ?? 3}" />
        <div class="row"><div style="flex:1"><label>白天开始</label><input id="set-days" value="${esc(b.heartbeat?.day_start || "07:00")}" /></div><div style="flex:1"><label>白天结束</label><input id="set-daye" value="${esc(b.heartbeat?.day_end || "23:00")}" /></div></div>
        <div class="row"><div style="flex:1"><label>安静开始</label><input id="set-qs" value="${esc(b.security?.quiet_start || "23:00")}" /></div><div style="flex:1"><label>安静结束</label><input id="set-qe" value="${esc(b.security?.quiet_end || "08:00")}" /></div></div>
        <div class="row" style="margin-top:10px"><button class="primary" onclick="saveHeartbeat()">保存</button></div></section>
      <section class="card"><h3>QQ · SnowLuma</h3>
        <label><input type="checkbox" id="set-sl" ${b.channels?.snowluma?.enabled ? "checked" : ""} style="width:auto" /> 启用</label>
        <label>WebSocket 地址</label><input id="set-sl-ws" value="${esc(b.channels?.snowluma?.ws_url || "ws://127.0.0.1:3001")}" />
        <label>QQ 号（账号唯一归属）</label><input id="set-sl-account" value="${esc(b.channels?.snowluma?.account || "")}" placeholder="例如 123456789" />
        <label>主人 QQ 号</label><input id="set-sl-owner" value="" placeholder="用于主动消息" />
        <label>Access Token</label><input id="set-sl-token" type="password" value="" placeholder="${b.channels?.snowluma?.last_error ? "连接异常：" + esc(b.channels.snowluma.last_error) : "留空则不修改"}" />
        <label><input type="checkbox" id="set-sl-at" ${b.channels?.snowluma?.group_at_only !== false ? "checked" : ""} style="width:auto" /> 群聊里只有 @ 她才回</label>
        <div class="row" style="margin-top:10px"><button class="primary" onclick="saveSnowLuma()">保存并连接</button></div>
        <div class="muted tiny" style="margin-top:8px">单账号；扫码登录：<a href="http://127.0.0.1:6081/vnc.html" target="_blank">noVNC</a>；登录后把 QQ 号填到上面。</div>
      </section>
      <section class="card"><h3>工作台</h3>
        <div class="kv"><div>目录</div><div class="mono">${esc(b.dirs?.workspace || "")}</div></div>
        <label><input type="checkbox" id="set-shell" ${b.workbench?.allow_shell ? "checked" : ""} style="width:auto" /> 允许她执行 shell（终端）</label>
        <label><input type="checkbox" id="set-net" ${b.workbench?.allow_network ? "checked" : ""} style="width:auto" /> 允许联网</label>
        <label>自主活动间隔（分钟，0=关）</label><input id="set-auto" type="number" min="0" max="1440" value="${b.workbench?.auto_activity_minutes ?? 180}" />
        <div class="row" style="margin-top:10px"><button class="primary" onclick="saveWorkbench()">保存</button></div>
      </section>
      <section class="card"><h3>健康</h3><div id="health-box" class="kv">检查中…</div>
        <div class="row" style="margin-top:10px"><button class="ghost" onclick="updateHealth(true)">重新检查</button></div></section>
      <section class="card" style="grid-column:span 12"><h3>关于</h3>
        <div class="kv"><div>版本</div><div>Littly v2（Memoh fork）</div><div>许可</div><div>AGPL-3.0</div>
        <div>原则</div><div>她是一个人，不是助手；心跳是她自己的时间；私密抽屉网页端不可见。</div></div>
        <div class="row" style="margin-top:10px"><a class="badge" href="/login" target="_blank">打开 Memoh 平台管理（上游工作台）</a></div></section>
    </div>`;
  updateHealth();
}
async function saveModel() { try { await api("/config", { method: "PUT", body: JSON.stringify({ model: $("#set-model").value, temperature: Number($("#set-temp").value) }) }); await loadBoot(); toast("已保存"); } catch (e) { toast(e.message, true); } }
async function testModel() {
  const el = $("#model-test"); el.textContent = "测试中…";
  try { const r = await api("/test-model", { method: "POST" }); el.textContent = `✓ ${r.model} · ${r.latency_ms}ms · ${r.reply}`; }
  catch (e) { el.textContent = "✗ " + e.message; }
}
async function saveHeartbeat() { try { await api("/config", { method: "PUT", body: JSON.stringify({ heartbeat_enabled: $("#set-hb").checked, day_minutes: Number($("#set-day").value), night_minutes: Number($("#set-night").value) }) }); await loadBoot(); toast("已保存"); } catch (e) { toast(e.message, true); } }
async function saveSnowLuma() {
  try {
    const body = {
      snowluma_enabled: $("#set-sl").checked,
      snowluma_ws: $("#set-sl-ws").value,
      snowluma_account: $("#set-sl-account").value,
      snowluma_owner: $("#set-sl-owner").value,
      snowluma_token: $("#set-sl-token").value,
      group_at_only: $("#set-sl-at")?.checked ?? true,
    };
    await api("/config", { method: "PUT", body: JSON.stringify(body) });
    await loadBoot(); toast("渠道配置已保存，正在连接"); renderSettings();
  } catch (e) { toast(e.message, true); }
}
async function saveWorkbench() {
  try { await api("/config", { method: "PUT", body: JSON.stringify({ allow_shell: $("#set-shell").checked, allow_network: $("#set-net").checked, auto_activity_minutes: Number($("#set-auto").value) }) }); await loadBoot(); toast("已保存"); renderSettings(); }
  catch (e) { toast(e.message, true); }
}
async function updateHealth(force) {
  try {
    const h = await api("/health"); const dot = $("#health-dot");
    dot.className = "dot " + (h.status === "ok" ? "ok" : "bad");
    dot.textContent = "她 · " + (h.status === "ok" ? "正常" : "降级") + (h.heartbeat_paused ? "（心跳暂停）" : "");
    if ($("#health-box")) $("#health-box").innerHTML = `<div>状态</div><div>${esc(h.status)}</div><div>模型</div><div>${esc(h.model || "未配置")}</div><div>最近错误</div><div>${esc(h.last_error || "无")}</div><div>心跳</div><div>${h.heartbeat_running ? "运行中" : "停止"}${h.heartbeat_paused ? " · 暂停" : ""}</div><div>下次</div><div>${fmt(h.fallback_at)}</div>`;
  } catch (e) { $("#health-dot").className = "dot bad"; $("#health-dot").textContent = "服务异常"; }
}

window.addEventListener("hashchange", render);
(async function boot() {
  try { await loadBoot(); await loadToday(); } catch (e) { toast(e.message, true); }
  updateHealth();
  render();
})();
