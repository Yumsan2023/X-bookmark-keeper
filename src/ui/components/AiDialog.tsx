import { useMemo, useRef, useState } from 'react'
import { classifyAll, llmConfigured, type ClassifyProgress } from '@/ai/classify'
import { applyTagsToPosts } from '@/db/posts'
import type { Post, Settings } from '@/shared/types'
import { useT } from '../i18n'

const PREVIEW_PAGE = 40

interface Props {
  settings: Settings
  posts: Post[]
  scopeLabel: string
  knownTags: string[]
  onClose: () => void
  onApplied: () => void
}

export function AiDialog({ settings, posts, scopeLabel, knownTags, onClose, onApplied }: Props) {
  const t = useT()
  const [progress, setProgress] = useState<ClassifyProgress | null>(null)
  const [rows, setRows] = useState<{ id: string; tags: string[] }[] | null>(null)
  const [page, setPage] = useState(0)
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const ctl = useRef<AbortController>()
  const cfg = settings.llm

  const run = async () => {
    setErr('')
    setRunning(true)
    setRows(null)
    setPage(0)
    ctl.current = new AbortController()
    try {
      const origin = new URL(cfg.endpoint).origin + '/*'
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        const ok = await chrome.permissions.request({ origins: [origin] })
        if (!ok) throw new Error(t('ai_permission_denied'))
      }
      if (!knownTags.length && cfg.allowNewTags === false) throw new Error(t('ai_no_tags'))
      const res = await classifyAll(cfg, posts, knownTags, { onProgress: setProgress, signal: ctl.current.signal })
      setRows([...res.entries()].map(([id, tags]) => ({ id, tags })))
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const apply = async () => {
    if (!rows) return
    const keep = rows.filter((r) => r.tags.length)
    await applyTagsToPosts(keep.map((r) => [r.id, r.tags]))
    onApplied()
    onClose()
  }

  const dropTag = (id: string, tag: string) => {
    setRows((cur) => cur?.map((r) => (r.id === id ? { ...r, tags: r.tags.filter((x) => x !== tag) } : r)) ?? cur)
  }

  const postMap = useMemo(() => new Map(posts.map((p) => [p.tweet_id, p])), [posts])
  const total = rows?.length ?? 0
  const pages = Math.max(1, Math.ceil(total / PREVIEW_PAGE))
  const safePage = Math.min(page, pages - 1)
  const slice = rows?.slice(safePage * PREVIEW_PAGE, safePage * PREVIEW_PAGE + PREVIEW_PAGE) ?? []
  const applyCount = rows?.filter((r) => r.tags.length).length ?? 0
  const from = total ? safePage * PREVIEW_PAGE + 1 : 0
  const to = Math.min(total, safePage * PREVIEW_PAGE + slice.length)

  return (
    <div className="modal-bg">
      <div className="modal wide">
        <h3>{t('ai_title')}</h3>
        <p className="muted">{scopeLabel}: {posts.length} · {cfg.model}</p>
        <p className="muted small">{t('ai_confirm_hint')}</p>
        {err && <p className="err">{err}</p>}
        {progress && <progress value={progress.done} max={progress.total} />}
        {progress && <span className="muted"> {progress.done}/{progress.total} · {t('suggested')} {progress.assigned}</span>}
        {rows && total === 0 && <p className="muted">{t('ai_preview_empty')}</p>}
        {rows && total > 0 && (
          <>
            <p className="muted small">{t('ai_preview_range', { from, to, total })}</p>
            <div className="ai-list">
              {slice.map((row) => (
                <div key={row.id} className="ai-row">
                  <span className="clip">{postMap.get(row.id)?.text.slice(0, 80)}</span>
                  <span className="ai-tags">
                    {row.tags.length ? row.tags.map((tag) => (
                      <span key={tag} className="tag">
                        #{tag}
                        <button type="button" className="x" title={t('remove_tag')} onClick={() => dropTag(row.id, tag)}>×</button>
                      </span>
                    )) : <span className="muted">{t('ai_row_cleared')}</span>}
                  </span>
                </div>
              ))}
            </div>
            {pages > 1 && (
              <div className="ai-pager">
                <button type="button" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t('prev')}</button>
                <span className="muted">{safePage + 1} / {pages}</span>
                <button type="button" disabled={safePage + 1 >= pages} onClick={() => setPage((p) => p + 1)}>{t('next')}</button>
              </div>
            )}
          </>
        )}
        <div className="row end">
          {running && <button onClick={() => ctl.current?.abort()}>{t('cancel')}</button>}
          <button onClick={onClose}>{t('close')}</button>
          {!rows && llmConfigured(cfg) && <button className="primary" disabled={running || !posts.length} onClick={() => void run()}>{t('ai_run')}</button>}
          {rows && applyCount > 0 && <button className="primary" onClick={() => void apply()}>{t('ai_apply')} ({applyCount})</button>}
        </div>
      </div>
    </div>
  )
}
