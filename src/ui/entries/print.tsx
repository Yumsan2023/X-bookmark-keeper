import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getPosts } from '@/db/posts'
import { STORAGE_KEYS, type Post } from '@/shared/types'
import { fmtDate } from '../util'
import '../styles.css'

/** 打印友好页: 载入后自动 window.print(), 用户在打印对话框选择"另存为 PDF" */
function Print() {
  const [posts, setPosts] = useState<Post[] | null>(null)
  useEffect(() => {
    void (async () => {
      const r = await chrome.storage.local.get(STORAGE_KEYS.printIds)
      const ids = (r[STORAGE_KEYS.printIds] ?? []) as string[]
      const ps = await getPosts(ids)
      ps.sort((a, b) => (a.sort_index < b.sort_index ? 1 : -1))
      setPosts(ps)
      setTimeout(() => window.print(), 800)
    })()
  }, [])
  if (!posts) return <p>Loading…</p>
  return (
    <div className="print">
      <h1>X Bookmarks ({posts.length})</h1>
      {posts.map((p) => (
        <article key={p.tweet_id} className="print-item">
          <h3>{p.name} <small>@{p.screen_name} · {fmtDate(p.created_at, 'zh')}</small></h3>
          <p className="text">{p.text}</p>
          {p.thread?.map((t) => <p key={t.tweet_id} className="text">{t.text}</p>)}
          {p.media.filter((m) => m.type === 'photo').slice(0, 2).map((m, i) => <img key={i} src={m.url + ':small'} />)}
          <div className="muted">{p.folder && `📁 ${p.folder} `}{p.tags.map((t) => `#${t}`).join(' ')} <a href={p.url}>{p.url}</a></div>
        </article>
      ))}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Print />)
