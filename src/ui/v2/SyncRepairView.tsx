import { useEffect, useState } from 'react'
import { RefreshCw, Zap, Wrench, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { db } from '@/db/db'
import { STORAGE_KEYS, type Post, type Settings } from '@/shared/types'
import { bg, useAuthInfo, useProgress, useTask } from '../hooks'
import { SyncView } from '../components/SyncView'

interface RepairCandidates {
  truncated: Post[]
  missingThreads: Post[]
  tcoLinks: Post[]
}

const THREAD_HINT = /(?:^|\s)(?:1\/\d*|1\/|🧵|thread\b|长推|串推)/i
const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/

export function SyncRepairView({
  settings,
  save,
  onOpenReport,
  onNotify,
}: {
  settings: Settings
  save: (s: Settings) => Promise<void>
  onOpenReport: () => void
  onNotify: (msg: string) => void
}) {
  const auth = useAuthInfo()
  const progress = useProgress()
  const task = useTask()
  const [autoMap, setAutoMap] = useState<Record<string, number>>({})
  const [scanning, setScanning] = useState(false)
  const [candidates, setCandidates] = useState<RepairCandidates | null>(null)
  const [showLegacySync, setShowLegacySync] = useState(false)

  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEYS.autoSyncLast).then((r) => {
      const m = r[STORAGE_KEYS.autoSyncLast]
      if (m && typeof m === 'object') setAutoMap(m as Record<string, number>)
    })
  }, [progress?.updated_at])

  const triggerNow = async () => {
    const res = await bg<{ screen_name?: string }>({ type: 'account/current' })
    const acct = res.ok && res.data?.screen_name ? res.data.screen_name : undefined
    const r = await bg({ type: 'sync/start', mode: 'incremental', ...(acct ? { account: acct } : {}) })
    if (r.ok) onNotify(acct ? `已自动识别 @${acct} 并启动增量同步` : '已启动增量同步')
    else onNotify(`启动失败：${r.error}`)
  }

  const scanIncomplete = async () => {
    setScanning(true)
    try {
      const all = await db.posts.where('status').equals('active').toArray()
      const truncated: Post[] = []
      const missingThreads: Post[] = []
      const tcoLinks: Post[] = []
      for (const p of all) {
        const s = (p.text || '').trim()
        if (s.length >= 240 && s.length <= 330 && (s.endsWith('…') || s.endsWith('...')) && !p.has_article) {
          truncated.push(p)
        }
        if ((!p.thread || p.thread.length === 0) && THREAD_HINT.test(s)) {
          missingThreads.push(p)
        }
        if (TCO_RE.test(s) || (p.urls ?? []).some((u) => u.includes('t.co/'))) {
          tcoLinks.push(p)
        }
      }
      setCandidates({ truncated, missingThreads, tcoLinks })
    } finally {
      setScanning(false)
    }
  }

  const startRepair = async (posts: Post[], label: string) => {
    if (!posts.length) return
    const batch = posts.slice(0, 50).map((p) => p.tweet_id)
    const r = await bg({ type: 'repair/incomplete', tweetIds: batch })
    onNotify(r.ok ? `已启动「${label}」定向补全（本批 ${batch.length} 条）` : `启动失败：${r.error}`)
  }

  const running = progress?.status === 'running' || progress?.status === 'waiting'

  return (
    <div className="mx-auto max-w-4xl px-5 py-3.5">
      <div className="mb-3.5">
        <h2 className="text-base font-semibold tracking-tight">同步与残缺内容补全</h2>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
          打开 x.com 自动识别当前登录账号并静默增量同步，无需手动选账号；同时支持残缺长文、串推与短链定向补抓。
        </p>
      </div>

      {/* Auto-sync hero card */}
      <div className="v2-card mb-3.5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ background: settings.autoSyncOnXOpen ? 'rgba(16,185,129,0.14)' : 'var(--surface-2)' }}
            >
              <Zap className="h-4 w-4" style={{ color: settings.autoSyncOnXOpen ? 'var(--ok)' : 'var(--muted)' }} />
            </div>
            <div>
              <div className="flex items-center gap-2 font-semibold text-sm">
                <span>打开 x.com 自动识别账号并静默增量扫描</span>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{
                    background: settings.autoSyncOnXOpen ? 'rgba(16,185,129,0.14)' : 'var(--surface-2)',
                    color: settings.autoSyncOnXOpen ? 'var(--ok)' : 'var(--muted)',
                  }}
                >
                  {settings.autoSyncOnXOpen ? '已开启' : '已关闭'}
                </span>
              </div>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                访问或切回 X 标签页时，扩展自动读取当前登录 @handle 并按冷却时间静默抓取最新书签，自动跳过冷库墓碑防回灌。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={settings.autoSyncOnXOpen}
                onChange={(e) => void save({ ...settings, autoSyncOnXOpen: e.target.checked })}
              />
              <span>启用自动同步</span>
            </label>
            <select
              value={settings.autoSyncCooldownMin}
              onChange={(e) => void save({ ...settings, autoSyncCooldownMin: Number(e.target.value) || 20 })}
              className="rounded-lg border px-2 py-1 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <option value={5}>每 5 分钟</option>
              <option value={15}>每 15 分钟</option>
              <option value={20}>每 20 分钟 (推荐)</option>
              <option value={60}>每 60 分钟</option>
              <option value={180}>每 3 小时</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {auth?.captured_at ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> 会话凭证就绪 ({new Date(auth.captured_at).toLocaleTimeString()})
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> 未捕获凭证：请打开并刷新一次 x.com/i/bookmarks
              </span>
            )}
            {Object.entries(autoMap).map(([acc, ts]) => (
              <span key={acc} className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>
                @{acc} 上次自动同步 {new Date(ts).toLocaleTimeString()}
              </span>
            ))}
          </div>
          <button
            type="button"
            disabled={running}
            onClick={() => void triggerNow()}
            className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-40"
            style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
            <span>{running ? '同步中...' : '一键自动识别并增量同步'}</span>
          </button>
        </div>

        {progress && (
          <div className="mt-3 rounded-xl border px-3.5 py-2.5 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                状态：<strong>{progress.status}</strong> {progress.account ? `· @${progress.account}` : ''} · 页 {progress.pages} · 新增 {progress.added} · 更新 {progress.updated}
              </span>
              {running && (
                <button type="button" onClick={() => void bg({ type: 'sync/cancel' })} className="text-rose-400 hover:underline">
                  取消
                </button>
              )}
            </div>
            {progress.message && <div className="mt-1" style={{ color: 'var(--muted)' }}>{progress.message}</div>}
            {progress.error && <div className="mt-1 text-rose-400">{progress.error}</div>}
          </div>
        )}
      </div>

      {/* Incomplete content repair card */}
      <div className="v2-card mb-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Wrench className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            <div>
              <div className="font-semibold text-sm">残缺内容定向补全队列</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                扫描热库中疑似截断长文、缺失 Thread 串推和未还原的 t.co 短链，按批限速定向补抓。
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={scanning}
            onClick={() => void scanIncomplete()}
            className="rounded-xl border px-3.5 py-2 text-xs font-medium hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)' }}
          >
            {scanning ? '扫描中...' : '扫描当前热库残缺项'}
          </button>
        </div>

        {candidates && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { label: '疑似截断长文', list: candidates.truncated },
              { label: '疑似未抓全 Thread', list: candidates.missingThreads },
              { label: '未还原 t.co 短链', list: candidates.tcoLinks },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border p-3.5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>{item.label}</div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-xl font-semibold tabular-nums">{item.list.length}</span>
                  <button
                    type="button"
                    disabled={!item.list.length || task?.status === 'running'}
                    onClick={() => void startRepair(item.list, item.label)}
                    className="rounded-lg border px-2.5 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    补抓前 {Math.min(50, item.list.length)} 条
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible Full Sync, QueryIds & Public UserTweets panel */}
      <div className="v2-card overflow-hidden">
        <button
          type="button"
          onClick={() => setShowLegacySync((v) => !v)}
          className="flex w-full items-center justify-between px-5 py-3.5 text-left text-sm font-medium hover:bg-[var(--hover)]"
        >
          <span>高级同步：全量同步、公开发帖抓取 (UserTweets)、QueryID 诊断与全量报告</span>
          {showLegacySync ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {showLegacySync && (
          <div className="v2-legacy-wrap border-t p-5" style={{ borderColor: 'var(--border)' }}>
            <SyncView onOpenReport={onOpenReport} />
          </div>
        )}
      </div>
    </div>
  )
}
