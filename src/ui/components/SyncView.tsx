import { useEffect, useState } from 'react'
import type { OperationName } from '@/api/endpoints'
import type { SyncProgress } from '@/shared/types'
import { bg, useAuthInfo, useProgress, useRate, useTask, useTimelineProgress } from '../hooks'
import { useT, type Key } from '../i18n'
import { useDialogs } from './Dialogs'

export function errorHint(p: SyncProgress | undefined): Key | null {
  switch (p?.error_code) {
    case 'auth': return 'hint_auth'
    case 'rate_limit': return 'hint_rate'
    case 'query_id': return 'hint_query_id'
    case 'data': return 'hint_data'
    default: return null
  }
}

export function SyncControls(_props: { compact?: boolean }) {
  const t = useT()
  const { confirm } = useDialogs()
  const p = useProgress()
  const status = p?.status ?? 'idle'
  const active = status === 'running' || status === 'waiting'
  const resumable = !!p && ['paused', 'error', 'cancelled'].includes(status) && p.mode === 'full' && !!p.cursor
  return (
    <div className="row wrap">
      {!active && <button className="primary" onClick={() => bg({ type: 'sync/start', mode: 'incremental' })}>{t('sync_incremental')}</button>}
      {!active && <button onClick={async () => { if (await confirm(t('full_sync_warn'))) bg({ type: 'sync/start', mode: 'full' }) }}>{t('sync_full')}</button>}
      {!active && resumable && status !== 'paused' && <button onClick={() => bg({ type: 'sync/resume' })}>{t('sync_resume')}</button>}
      {active && <button onClick={() => bg({ type: 'sync/pause' })}>{t('pause')}</button>}
      {status === 'paused' && <button className="primary" onClick={() => bg({ type: 'sync/resume' })}>{t('resume')}</button>}
      {(active || status === 'paused') && <button className="danger" onClick={() => bg({ type: 'sync/cancel' })}>{t('cancel')}</button>}
    </div>
  )
}

function ProgressBlock({ p, label }: { p: SyncProgress | undefined; label?: string }) {
  const t = useT()
  if (!p) return <p className="muted">{t('idle')}</p>
  const hint = errorHint(p)
  const phaseLabel =
    p.phase === 'bookmarks' ? t('bookmarks')
    : p.phase === 'folders' ? t('folders')
    : p.phase === 'threads' ? t('threads')
    : p.phase === 'detect' ? t('detect')
    : p.phase === 'timeline' ? t('timeline_phase')
    : t('done')
  return (
    <div className="progress-box">
      {label && <div className="muted">{label}</div>}
      <div className="row wrap">
        <b>{t(p.status as Key)}</b>
        <span className="muted">{t('phase')}: {phaseLabel}{p.folder ? ` (${p.folder})` : ''}{p.handle ? ` @${p.handle}` : ''}</span>
        <span className="muted">{t('pages')} {p.pages} · {t('fetched')} {p.fetched} · {t('added')} {p.added} · {t('updated')} {p.updated}</span>
      </div>
      {(p.status === 'running' || p.status === 'waiting') && <progress />}
      {p.message && <div className="muted">{p.message}</div>}
      {p.error && <div className="err">{t('error')}: {p.error}{hint ? ` — ${t(hint)}` : ''}</div>}
    </div>
  )
}

export function ProgressBox() {
  const p = useProgress()
  return <ProgressBlock p={p} />
}

export function TaskBox() {
  const t = useT()
  const task = useTask()
  if (!task) return null
  return (
    <div className="progress-box">
      <b>{t('task')}: {task.kind}</b> {task.status} {task.done}/{task.total} {task.failed ? `(✗ ${task.failed})` : ''}
      {task.status === 'running' && <progress value={task.done} max={task.total} />}
      {task.error && <div className="err">{task.error}</div>}
    </div>
  )
}

function TimelinePanel() {
  const t = useT()
  const { confirm } = useDialogs()
  const p = useTimelineProgress()
  const [input, setInput] = useState('')
  const status = p?.status ?? 'idle'
  const active = status === 'running' || status === 'waiting'
  const resumable = !!p && ['paused', 'error', 'cancelled'].includes(status) && !!p.cursor && !!p.handle
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>{t('timeline_title')} <span className="muted" style={{ fontWeight: 400, fontSize: '0.85em' }}>v0.2.0</span></h3>
      <p className="muted">{t('timeline_hint')}</p>
      <p className="err" style={{ fontSize: '0.9em' }}>{t('timeline_risk')}</p>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <input
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('timeline_input_ph')}
          value={input}
          disabled={active}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim() && !active) bg({ type: 'timeline/start', handle: input.trim() })
          }}
        />
        {!active && (
          <button
            className="primary"
            disabled={!input.trim()}
            onClick={async () => {
              if (!(await confirm(t('timeline_risk') + '\n\n' + t('full_sync_warn')))) return
              bg({ type: 'timeline/start', handle: input.trim() })
            }}
          >
            {t('timeline_sync')}
          </button>
        )}
        {!active && (
          <button
            onClick={async () => {
              if (!(await confirm(t('timeline_risk') + '\n\n' + t('full_sync_warn')))) return
              bg({ type: 'timeline/startSelf' })
            }}
          >
            {t('timeline_sync_self')}
          </button>
        )}
        {active && <button onClick={() => bg({ type: 'timeline/pause' })}>{t('pause')}</button>}
        {status === 'paused' && <button className="primary" onClick={() => bg({ type: 'timeline/resume' })}>{t('resume')}</button>}
        {!active && resumable && status !== 'paused' && <button onClick={() => bg({ type: 'timeline/resume' })}>{t('sync_resume')}</button>}
        {(active || status === 'paused') && <button className="danger" onClick={() => bg({ type: 'timeline/cancel' })}>{t('cancel')}</button>}
      </div>
      <ProgressBlock p={p} label={t('timeline_phase')} />
    </div>
  )
}

export function SyncView() {
  const t = useT()
  const auth = useAuthInfo()
  const rate = useRate()
  const [ids, setIds] = useState<Record<string, { id: string; source: string }>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    bg<Record<string, { id: string; source: string }>>({ type: 'queryids/get' }).then((r) => r.ok && r.data && setIds(r.data))
  }, [])
  return (
    <div className="panel">
      <h3>{t('sync_status')} <span className="muted" style={{ fontWeight: 400, fontSize: '0.85em' }}>v0.2.0</span></h3>
      <p className="muted">{t('not_verified')}</p>
      <p className={auth ? 'ok' : 'err'}>
        {auth ? `✔ ${t('auth_ok')} (${new Date(auth.captured_at).toLocaleString()})` : `✘ ${t('auth_missing')}`}{' '}
        <button onClick={() => chrome.tabs.create({ url: 'https://x.com/i/bookmarks' })}>{t('open_x_bookmarks')}</button>
      </p>
      <SyncControls />
      <ProgressBox />
      <TaskBox />
      <TimelinePanel />
      <h4>{t('query_ids')}</h4>
      <table className="table small">
        <tbody>
          {(Object.keys(ids) as OperationName[]).map((op) => (
            <tr key={op}>
              <td>{op}</td><td><code>{ids[op].id}</code></td><td className="muted">{ids[op].source}</td>
              <td className="muted">{rate?.[op] ? `${rate[op].remaining}/${rate[op].limit}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button disabled={busy} onClick={async () => {
        setBusy(true)
        const r = await bg<{ ids: typeof ids }>({ type: 'queryids/refresh' })
        if (r.ok && r.data) setIds(r.data.ids)
        setBusy(false)
      }}>{t('refresh_query_ids')}</button>
    </div>
  )
}
