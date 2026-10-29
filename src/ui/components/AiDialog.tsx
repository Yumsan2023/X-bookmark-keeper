import { useRef, useState } from 'react'
import { classifyAll, llmConfigured, type ClassifyProgress } from '@/ai/classify'
import { moveToFolder } from '@/db/posts'
import type { Folder, Post, Settings } from '@/shared/types'
import { useT } from '../i18n'

interface Props {
  settings: Settings
  posts: Post[] // 候选 (选中或未归类)
  scopeLabel: string
  folders: Folder[]
  onClose: () => void
  onApplied: () => void
}

export function AiDialog({ settings, posts, scopeLabel, folders, onClose, onApplied }: Props) {
  const t = useT()
  const [progress, setProgress] = useState<ClassifyProgress | null>(null)
  const [result, setResult] = useState<Map<string, string> | null>(null)
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const ctl = useRef<AbortController>()
  const cfg = settings.llm

  const run = async () => {
    setErr('')
    setRunning(true)
    ctl.current = new AbortController()
    try {
      // 首次使用时向用户申请该接口域名的访问权限 (需用户手势)
      const origin = new URL(cfg.endpoint).origin + '/*'
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        const ok = await chrome.permissions.request({ origins: [origin] })
        if (!ok) throw new Error('未授予访问该 LLM 接口的权限')
      }
      const names = folders.map((f) => f.name)
      if (!names.length && !cfg.allowNewFolders) throw new Error(t('ai_no_folders'))
      const res = await classifyAll(cfg, posts, names, { onProgress: setProgress, signal: ctl.current.signal })
      setResult(res)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const apply = async () => {
    if (!result) return
    const byFolder = new Map<string, string[]>()
    for (const [id, f] of result) byFolder.set(f, [...(byFolder.get(f) ?? []), id])
    for (const [f, ids] of byFolder) await moveToFolder(ids, f)
    onApplied()
    onClose()
  }

  const postMap = new Map(posts.map((p) => [p.tweet_id, p]))
  return (
    <div className="modal-bg">
      <div className="modal wide">
        <h3>{t('ai_title')}</h3>
        <p className="muted">{scopeLabel}: {posts.length} · {cfg.model}</p>
        {err && <p className="err">{err}</p>}
        {progress && <progress value={progress.done} max={progress.total} />}
        {progress && <span className="muted"> {progress.done}/{progress.total} · {t('suggested')} {progress.assigned}</span>}
        {result && (
          <div className="ai-list">
            {[...result].slice(0, 200).map(([id, f]) => (
              <div key={id} className="ai-row">
                <span className="clip">{postMap.get(id)?.text.slice(0, 80)}</span>
                <b>→ {f}</b>
              </div>
            ))}
          </div>
        )}
        <div className="row end">
          {running && <button onClick={() => ctl.current?.abort()}>{t('cancel')}</button>}
          <button onClick={onClose}>{t('close')}</button>
          {!result && llmConfigured(cfg) && <button className="primary" disabled={running || !posts.length} onClick={run}>{t('ai_run')}</button>}
          {result && result.size > 0 && <button className="primary" onClick={apply}>{t('ai_apply')} ({result.size})</button>}
        </div>
      </div>
    </div>
  )
}
