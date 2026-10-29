import { useState } from 'react'
import type { Post } from '@/shared/types'
import { highlight } from '@/search/highlight'
import { useLang, useT } from '../i18n'
import { fmtDate, fmtNum } from '../util'

function Hl({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  )
}

interface Props {
  post: Post
  terms: string[]
  selected: boolean
  onSelect: (id: string, v: boolean) => void
  onTag: (post: Post) => void
  onNote: (post: Post) => void
  onDelete?: (post: Post) => void
  compact?: boolean
}

export function PostCard({ post: p, terms, selected, onSelect, onTag, onNote, onDelete, compact }: Props) {
  const t = useT()
  const lang = useLang()
  const [showThread, setShowThread] = useState(false)
  return (
    <article className={`card ${p.status !== 'active' ? 'card-dim' : ''} ${selected ? 'card-sel' : ''}`}>
      <input className="sel" type="checkbox" checked={selected} onChange={(e) => onSelect(p.tweet_id, e.target.checked)} />
      <div className="card-main">
        <header className="card-head">
          {p.avatar && !compact && <img className="avatar" src={p.avatar} alt="" loading="lazy" />}
          <a href={`https://x.com/${p.screen_name}`} target="_blank" rel="noreferrer" className="author">
            <b><Hl text={p.name || p.screen_name} terms={terms} /></b> <span className="muted">@{p.screen_name}</span>
          </a>
          <span className="muted">· {fmtDate(p.created_at, lang)}</span>
          {p.status === 'tweet_deleted' && <span className="badge bad">{t('deleted_badge')}</span>}
          {p.status === 'unbookmarked' && <span className="badge warn">{t('unbookmarked_badge')}</span>}
          {p.folder && <span className="badge">📁 {p.folder}</span>}
        </header>
        <p className="text"><Hl text={p.text} terms={terms} /></p>
        {p.quoted && (
          <blockquote className="quote">
            <b>{p.quoted.name}</b> <span className="muted">@{p.quoted.screen_name}</span>
            <div><Hl text={p.quoted.text} terms={terms} /></div>
          </blockquote>
        )}
        {p.media.length > 0 && (
          <div className="media">
            {p.media.slice(0, 4).map((m, i) => (
              <a key={i} href={m.video_url ?? m.url} target="_blank" rel="noreferrer" className="thumb">
                <img src={m.url + (m.type === 'photo' ? ':small' : '')} alt={m.alt ?? ''} loading="lazy" />
                {m.type !== 'photo' && <span className="play">▶</span>}
              </a>
            ))}
          </div>
        )}
        {p.urls.length > 0 && (
          <div className="links">
            {p.urls.slice(0, 3).map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" title={u}>🔗 {u.replace(/^https?:\/\//, '').slice(0, 60)}</a>
            ))}
          </div>
        )}
        {!!p.thread?.length && (
          <div>
            <button className="link-btn" onClick={() => setShowThread((v) => !v)}>
              {t('thread')} ({p.thread.length + 1}) {showThread ? '▲' : '▼'}
            </button>
            {showThread && p.thread.map((th) => <p key={th.tweet_id} className="thread-item"><Hl text={th.text} terms={terms} /></p>)}
          </div>
        )}
        {p.note && <p className="note">📝 <Hl text={p.note} terms={terms} /></p>}
        <footer className="card-foot">
          <span className="muted">♥ {fmtNum(p.metrics.likes)} · ⟲ {fmtNum(p.metrics.retweets)} · 👁 {fmtNum(p.metrics.views)}</span>
          <span className="tags">
            {p.tags.map((tg) => <span key={tg} className="tag">#{tg}</span>)}
          </span>
          <span className="spacer" />
          <button className="link-btn" onClick={() => onTag(p)}>🏷 {t('tag')}</button>
          <button className="link-btn" onClick={() => onNote(p)}>📝 {t('edit_note')}</button>
          {onDelete && (
            <button
              type="button"
              className="link-btn danger"
              title={t('unbookmark_x')}
              onClick={() => onDelete(p)}
            >
              🗑 {t('delete_bookmark')}
            </button>
          )}
          <a href={p.url} target="_blank" rel="noreferrer">{t('open_on_x')} ↗</a>
        </footer>
      </div>
    </article>
  )
}
