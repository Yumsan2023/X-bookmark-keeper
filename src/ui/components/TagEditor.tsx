import { useState } from 'react'
import { addTags, normalizeTag, removeTags, setNote } from '@/db/posts'
import type { Post } from '@/shared/types'
import { useT } from '../i18n'

export function TagEditor({ post, allTags, onClose, onChanged }: { post: Post; allTags: string[]; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [tags, setTags] = useState(post.tags ?? [])
  const [val, setVal] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const add = async () => {
    const parts = val.split(/[\s,，]+/).map(normalizeTag).filter(Boolean)
    if (!parts.length) return
    await addTags([post.tweet_id], parts)
    setTags((cur) => [...new Set([...cur, ...parts])])
    setVal('')
    onChanged()
  }
  const rm = async (tg: string) => {
    await removeTags([post.tweet_id], [tg])
    setTags((cur) => cur.filter((x) => x !== tg))
    onChanged()
  }
  const rename = async (from: string) => {
    const to = normalizeTag(editVal)
    setEditing(null)
    if (!to || to.toLowerCase() === from.toLowerCase()) return
    await removeTags([post.tweet_id], [from])
    await addTags([post.tweet_id], [to])
    setTags((cur) => [...new Set(cur.map((x) => (x === from ? to : x)))])
    onChanged()
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p><b>{t('edit_tags')}</b> — @{post.screen_name}</p>
        <p className="muted small">{t('edit_tags_hint')}</p>
        <div className="tags">
          {tags.map((tg) => (
            <span key={tg} className="tag">
              {editing === tg ? (
                <input
                  className="tag-rename"
                  value={editVal}
                  autoFocus
                  onChange={(e) => setEditVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename(tg)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <>#{tg}</>
              )}
              {editing !== tg && (
                <button type="button" className="x" title={t('rename')} onClick={() => { setEditing(tg); setEditVal(tg) }}>✎</button>
              )}
              <button type="button" className="x" title={editing === tg ? t('save') : t('remove_tag')} onClick={() => void (editing === tg ? rename(tg) : rm(tg))}>{editing === tg ? '✓' : '×'}</button>
            </span>
          ))}
        </div>
        <div className="row">
          <input list="all-tags" value={val} autoFocus={editing == null} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('tag_prompt')} />
          <datalist id="all-tags">{allTags.map((x) => <option key={x} value={x} />)}</datalist>
          <button className="primary" onClick={add}>+</button>
        </div>
        <div className="row end"><button onClick={onClose}>{t('close')}</button></div>
      </div>
    </div>
  )
}

export function NoteEditor({ post, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [val, setVal] = useState(post.note ?? '')
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p><b>{t('edit_note')}</b> — @{post.screen_name}</p>
        <textarea rows={5} value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
        <div className="row end">
          <button onClick={onClose}>{t('cancel')}</button>
          <button className="primary" onClick={async () => { await setNote(post.tweet_id, val.trim()); onChanged(); onClose() }}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}
