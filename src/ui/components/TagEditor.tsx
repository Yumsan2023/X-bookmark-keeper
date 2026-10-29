import { useState } from 'react'
import { addTags, normalizeTag, removeTags, setNote } from '@/db/posts'
import type { Post } from '@/shared/types'
import { useT } from '../i18n'

export function TagEditor({ post, allTags, onClose, onChanged }: { post: Post; allTags: string[]; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [tags, setTags] = useState(post.tags)
  const [val, setVal] = useState('')
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
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p><b>{t('tag')}</b> — @{post.screen_name}</p>
        <div className="tags">
          {tags.map((tg) => (
            <span key={tg} className="tag">#{tg} <button className="x" onClick={() => rm(tg)}>×</button></span>
          ))}
        </div>
        <div className="row">
          <input list="all-tags" value={val} autoFocus onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder={t('tag_prompt')} />
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
