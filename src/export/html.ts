/**
 * Self-contained single-file offline HTML archive exporter.
 * Zero external CDN dependencies: works double-clicked offline in any browser with
 * live keyword search, folder & tag filter pills, dark/light toggle, merged threads, and media.
 */
import type { Post } from '@/shared/types'

function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export function postsToSelfContainedHtml(posts: Post[], title = 'X Bookmarks Archive'): string {
  const payload = posts.map((p) => ({
    id: p.tweet_id,
    name: p.name,
    handle: p.screen_name,
    created_at: p.created_at,
    text: p.text,
    url: p.url,
    folder: p.folder || '',
    tags: p.tags || [],
    accounts: p.accounts || [],
    note: p.note || '',
    metrics: p.metrics,
    media: (p.media || []).map((m) => ({ type: m.type, url: m.url, video_url: m.video_url || '', alt: m.alt || '' })),
    quoted: p.quoted
      ? {
          name: p.quoted.name,
          handle: p.quoted.screen_name,
          text: p.quoted.text,
          article_title: p.quoted.article_title || '',
          article_text: p.quoted.article_text || '',
        }
      : null,
    thread: (p.thread || []).map((t) => ({ text: t.text, created_at: t.created_at, media: t.media || [] })),
  }))

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escHtml(title)} (${posts.length})</title>
<style>
:root{--bg:#0b0d10;--card:#13161b;--card2:#191d24;--fg:#f1f5f9;--muted:#94a3b8;--border:#232833;--accent:#3b82f6;--chip:#1e293b}
.light{--bg:#f8fafc;--card:#ffffff;--card2:#f1f5f9;--fg:#0f172a;--muted:#64748b;--border:#e2e8f0;--accent:#2563eb;--chip:#e2e8f0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"PingFang SC","Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:20;backdrop-filter:blur(12px);background:color-mix(in srgb,var(--bg) 88%,transparent);border-bottom:1px solid var(--border);padding:14px 20px}
.bar{max-width:980px;margin:0 auto;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.title{font-weight:700;font-size:16px;margin-right:auto}
input,select,button{background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:7px 12px;font:inherit}
input{flex:1;min-width:220px}button{cursor:pointer}button:hover{border-color:var(--accent)}
main{max-width:980px;margin:20px auto;padding:0 20px 60px;display:grid;gap:14px}
.meta-row{font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px}
.head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:8px}
.author{font-weight:600}.handle{color:var(--muted);font-weight:400;margin-left:6px}.date{font-size:12px;color:var(--muted)}
.text{white-space:pre-wrap;word-break:break-word;margin:6px 0 10px}
.thread-part{margin-top:10px;padding-left:12px;border-left:2px solid var(--accent);white-space:pre-wrap}
.quoted{background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:13px}
.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin:10px 0}
.media img{width:100%;max-height:240px;object-fit:cover;border-radius:8px;border:1px solid var(--border)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--fg)}
.chip.folder{background:color-mix(in srgb,var(--accent) 18%,var(--card));color:var(--accent)}
.note{margin-top:10px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,#f59e0b 12%,var(--card));font-size:13px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.pager{display:flex;justify-content:center;gap:10px;margin-top:16px}
</style>
</head>
<body>
<header>
  <div class="bar">
    <div class="title">🔖 ${escHtml(title)}</div>
    <input id="q" type="search" placeholder="搜索正文、作者、引用、笔记..." />
    <select id="folder"><option value="">全部领域</option></select>
    <button id="theme" type="button">切换明暗</button>
  </div>
</header>
<main>
  <div class="meta-row" id="stats"></div>
  <div id="list" style="display:grid;gap:14px"></div>
  <div class="pager" id="pager"></div>
</main>
<script>
const POSTS = ${safeJsonForScript(payload)};
const PAGE_SIZE = 50;
let page = 0;
const qEl = document.getElementById('q');
const fEl = document.getElementById('folder');
const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const pagerEl = document.getElementById('pager');
document.getElementById('theme').onclick = () => document.documentElement.classList.toggle('light');
const folders = [...new Set(POSTS.map(p => p.folder).filter(Boolean))].sort();
folders.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f; fEl.appendChild(o); });
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function render(){
  const kw = qEl.value.trim().toLowerCase();
  const folder = fEl.value;
  const filtered = POSTS.filter(p => {
    if (folder && p.folder !== folder) return false;
    if (!kw) return true;
    const hay = (p.name+' '+p.handle+' '+p.text+' '+(p.quoted?.text||'')+' '+(p.quoted?.article_title||'')+' '+(p.quoted?.article_text||'')+' '+p.note+' '+p.tags.join(' ')).toLowerCase();
    return kw.split(/\\s+/).every(t => hay.includes(t));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (page >= totalPages) page = 0;
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  statsEl.textContent = '共 ' + filtered.length + ' / ' + POSTS.length + ' 条书签 · 第 ' + (page + 1) + ' / ' + totalPages + ' 页';
  listEl.innerHTML = slice.map(p => {
    const dt = p.created_at ? new Date(p.created_at).toISOString().slice(0,10) : '';
    const threadHtml = p.thread.map((t,i) => '<div class="thread-part"><strong>'+(i+2)+'/'+(p.thread.length+1)+'</strong> '+esc(t.text)+'</div>').join('');
    const quotedHtml = p.quoted ? '<div class="quoted"><strong>'+esc(p.quoted.name)+' (@'+esc(p.quoted.handle)+')</strong>'+(p.quoted.article_title?'<div style="font-weight:600;margin:4px 0">📄 '+esc(p.quoted.article_title)+'</div>':'')+'<div class="text">'+esc(p.quoted.article_text||p.quoted.text)+'</div></div>' : '';
    const mediaHtml = p.media.length ? '<div class="media">'+p.media.map(m => '<a href="'+esc(m.video_url||m.url)+'" target="_blank" rel="noreferrer"><img loading="lazy" src="'+esc(m.url)+'" alt="'+esc(m.alt)+'"/></a>').join('')+'</div>' : '';
    const chips = [p.folder ? '<span class="chip folder">'+esc(p.folder)+'</span>' : '', ...p.tags.map(t => '<span class="chip">#'+esc(t)+'</span>')].filter(Boolean).join('');
    return '<article class="card"><div class="head"><div><span class="author">'+esc(p.name)+'</span><span class="handle">@'+esc(p.handle)+'</span></div><div class="date">'+dt+' · <a href="'+esc(p.url)+'" target="_blank" rel="noreferrer">原文 ↗</a></div></div><div class="text">'+esc(p.text)+'</div>'+threadHtml+quotedHtml+mediaHtml+(p.note?'<div class="note">📝 '+esc(p.note)+'</div>':'')+'<div class="chips">'+chips+'</div><div class="meta-row" style="margin-top:8px"><span>❤️ '+(p.metrics?.likes||0)+'</span><span>🔖 '+(p.metrics?.bookmarks||0)+'</span><span>👀 '+(p.metrics?.views||0)+'</span></div></article>';
  }).join('');
  pagerEl.innerHTML = totalPages > 1 ? '<button id="prev"'+(page<=0?' disabled':'')+'>上一页</button><button id="next"'+(page>=totalPages-1?' disabled':'')+'>下一页</button>' : '';
  const prev = document.getElementById('prev'); if (prev) prev.onclick = () => { page--; render(); window.scrollTo(0,0); };
  const next = document.getElementById('next'); if (next) next.onclick = () => { page++; render(); window.scrollTo(0,0); };
}
qEl.oninput = () => { page = 0; render(); };
fEl.onchange = () => { page = 0; render(); };
render();
</script>
</body>
</html>`
}
