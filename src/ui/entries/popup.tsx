import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Bookmark, RefreshCw, Sparkles, PanelRight, ExternalLink, Zap, Trash2 } from 'lucide-react'
import { APP_VERSION } from '@/backup/full'
import { getCleanupSummary } from '@/db/cleanup'
import { applyUiFontSize } from '@/shared/ui-font'
import { bg, useLibrary, useProgress, useSettings } from '../hooks'
import { I18nProvider } from '../i18n'
import { DialogProvider } from '../components/Dialogs'
import '../styles.css'

function Popup({ themeClass }: { themeClass: string }) {
  const [settings] = useSettings()
  const lib = useLibrary()
  const progress = useProgress()
  const [cleanupPending, setCleanupPending] = useState(0)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getCleanupSummary().then((s) => setCleanupPending(s.pending))
  }, [lib.version])

  const isSyncing = progress?.status === 'running' || progress?.status === 'waiting'

  const triggerQuickSync = async () => {
    const acctRes = await bg<{ screen_name: string }>({ type: 'account/current' })
    const acct = acctRes.ok ? acctRes.data?.screen_name : undefined
    const r = await bg({ type: 'sync/start', mode: 'incremental', ...(acct ? { account: acct } : {}) })
    setMsg(r.ok ? `已启动增量同步${acct ? ` (@${acct})` : ''}` : `未能启动：${r.error}`)
  }

  return (
    <div className={`popup ${themeClass}`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: 'var(--accent)' }}>
            X
          </div>
          <div>
            <div className="text-sm font-semibold leading-none">X Toolkit</div>
            <div className="mt-0.5 text-[10px]" style={{ color: 'var(--muted)' }}>
              v{APP_VERSION} 书签知识库
            </div>
          </div>
        </div>
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px]"
          style={{
            background: settings.autoSyncOnXOpen ? 'rgba(16,185,129,0.14)' : 'var(--surface-2)',
            color: settings.autoSyncOnXOpen ? 'var(--ok)' : 'var(--muted)',
          }}
        >
          <Zap className="h-3 w-3" /> {settings.autoSyncOnXOpen ? '自动同步开' : '手动同步'}
        </span>
      </div>

      {/* Stats card */}
      <div className="v2-card mb-3 grid grid-cols-2 gap-2 p-3 text-xs">
        <div>
          <div style={{ color: 'var(--muted)' }}>热库书签</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums">{lib.totalCount.toLocaleString()}</div>
        </div>
        <div>
          <div style={{ color: 'var(--muted)' }}>待清理队列</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color: cleanupPending ? 'var(--warn)' : 'var(--fg)' }}>
            {cleanupPending.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Quick sync status */}
      {progress && (
        <div className="mb-3 rounded-xl border px-3 py-2 text-[11px]" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between">
            <span>
              <strong>{progress.status}</strong> {progress.account ? `· @${progress.account}` : ''}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
              +{progress.added} / {progress.fetched}
            </span>
          </div>
          {progress.message && <div className="mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{progress.message}</div>}
          {progress.error && <div className="mt-0.5 truncate text-rose-400">{progress.error}</div>}
        </div>
      )}
      {msg && <div className="mb-2 text-[11px]" style={{ color: 'var(--accent)' }}>{msg}</div>}

      {/* Action buttons */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => chrome.runtime.openOptionsPage()}
          className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-semibold"
          style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
        >
          <Bookmark className="h-3.5 w-3.5" /> 打开完整书签工作台 <ExternalLink className="h-3 w-3 opacity-70" />
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={isSyncing}
            onClick={() => void triggerQuickSync()}
            className="flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs hover:bg-[var(--hover)] disabled:opacity-40"
            style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? '同步中' : '立即增量'}</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              const w = await chrome.windows.getCurrent()
              await chrome.sidePanel.open({ windowId: w.id! })
            }}
            className="flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          >
            <PanelRight className="h-3.5 w-3.5" /> 侧边栏快查
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#daily') })}
            className="flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-400" /> 每日唤醒
          </button>
          <button
            type="button"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#cleanup') })}
            className="flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          >
            <Trash2 className="h-3.5 w-3.5 text-rose-400" /> 清理队列
          </button>
        </div>
      </div>
    </div>
  )
}

function Root() {
  const [s] = useSettings()
  const themeClass = s.theme === 'light' ? 'theme-x-light' : 'theme-x-dark'
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-x-dark', 'theme-x-light')
    root.classList.add(themeClass)
  }, [themeClass])
  useEffect(() => {
    applyUiFontSize(s.uiFontSize)
  }, [s.uiFontSize])
  return (
    <I18nProvider lang={s.lang}>
      <DialogProvider>
        <Popup themeClass={themeClass} />
      </DialogProvider>
    </I18nProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
