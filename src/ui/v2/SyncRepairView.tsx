import { useEffect, useState } from 'react'
import { RefreshCw, Zap, Wrench, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight, Pause } from 'lucide-react'
import { needsDirectArticleRepair, needsQuotedArticleRepair } from '@/api/parser'
import { db } from '@/db/db'
import { STORAGE_KEYS, type Post, type Settings } from '@/shared/types'
import { bg, useAuthInfo, useProgress, useTask } from '../hooks'
import { SyncView } from '../components/SyncView'

interface RepairCandidates {
  directArticles: Post[]
  quotedArticles: Post[]
  truncated: Post[]
  tcoLinks: Post[]
}

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
  const [batchSize, setBatchSize] = useState(100)
  const [skipChecked, setSkipChecked] = useState(true)
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
      const directArticles: Post[] = []
      const quotedArticles: Post[] = []
      const truncated: Post[] = []
      const tcoLinks: Post[] = []
      for (const p of all) {
        if (skipChecked && p.article_checked_at) continue
        const s = (p.text || '').trim()
        const directNeedsImg = p.has_article === 1 && !p.article_fetched_at && (p.media?.length ?? 0) === 0
        if (needsDirectArticleRepair(p) || directNeedsImg) {
          directArticles.push(p)
        }
        const quotedNeedsImg =
          !!(p.quoted?.article_title || p.quoted?.article_id) &&
          !(p.quoted?.media?.length || (p.quoted?.article_text || '').includes('!['))
        if (needsQuotedArticleRepair(p.quoted) || quotedNeedsImg) {
          quotedArticles.push(p)
        }
        if (s.length >= 220 && s.length <= 360 && (s.endsWith('…') || s.endsWith('...')) && !p.has_article) {
          truncated.push(p)
        }
        if (TCO_RE.test(s) || (p.urls ?? []).some((u) => u.includes('t.co/'))) {
          tcoLinks.push(p)
        }
      }
      // 优先补全收藏数更高的高价值文章
      const byBookmarks = (a: Post, b: Post) => (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0)
      directArticles.sort(byBookmarks)
      quotedArticles.sort(byBookmarks)
      truncated.sort(byBookmarks)
      setCandidates({ directArticles, quotedArticles, truncated, tcoLinks })
    } finally {
      setScanning(false)
    }
  }

  const startRepair = async (posts: Post[], label: string) => {
    if (!posts.length) return
    const batch = posts.slice(0, batchSize).map((p) => p.tweet_id)
    const r = await bg({ type: 'repair/incomplete', tweetIds: batch })
    onNotify(r.ok ? `已启动「${label}」全文与配图补全（本批 ${batch.length} 条，安全限速，遇 429 自动熔断）` : `启动失败：${r.error}`)
  }

  const startCombinedArticles = async () => {
    if (!candidates) return
    const seen = new Set<string>()
    const combined: Post[] = []
    for (const p of [...candidates.directArticles, ...candidates.quotedArticles]) {
      if (!seen.has(p.tweet_id)) {
        seen.add(p.tweet_id)
        combined.push(p)
      }
    }
    combined.sort((a, b) => (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0))
    await startRepair(combined, '全库残缺 X 文章（直接 + 引用）')
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

      {/* Incomplete content & X Article full-body repair card */}
      <div className="v2-card mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Wrench className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            <div>
              <div className="font-semibold text-sm">X 文章全文 & 残缺内容补全队列</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                只补全缺失正文与 X 长文章全文（含被 quote 引用的文章全文，自动保留引用者长评），不再抓取无关评论区串推。
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value) || 100)}
              className="rounded-lg border px-2 py-1.5 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              title="每批补全条数"
            >
              <option value={20}>每批 20 条</option>
              <option value={50}>每批 50 条</option>
              <option value={100}>每批 100 条 (推荐)</option>
              <option value={200}>每批 200 条</option>
              <option value={500}>全量续跑 (500/批)</option>
            </select>
            <button
              type="button"
              disabled={scanning}
              onClick={() => void scanIncomplete()}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
            >
              {scanning ? '全库扫描中...' : '全库体检扫描残缺文章/配图'}
            </button>
          </div>
        </div>

        {/* Auto-repair toggle + resumable skip-checked toggle */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={settings.autoRepairArticles !== false}
                onChange={(e) => void save({ ...settings, autoRepairArticles: e.target.checked })}
              />
              <span>新同步书签自动补全 X 文章全文</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2" style={{ color: 'var(--muted)' }}>
              <input
                type="checkbox"
                checked={skipChecked}
                onChange={(e) => setSkipChecked(e.target.checked)}
              />
              <span>续跑模式（自动跳过已体检过的条目）</span>
            </label>
          </div>
          {task?.kind === 'repair' && task.status === 'running' && (
            <button
              type="button"
              onClick={async () => {
                const r = await bg({ type: 'sync/cancel' })
                onNotify(r.ok ? '已停止补全任务' : `停止失败：${r.error || '未知错误'}`)
              }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-rose-400 hover:bg-rose-500/10"
              style={{ borderColor: 'var(--danger)' }}
            >
              <Pause className="h-3 w-3" /> 停止补全 ({task.done}/{task.total})
            </button>
          )}
        </div>

        {/* Live repair task progress bar */}
        {task?.kind === 'repair' && (task.status === 'running' || task.done > 0) && (
          <div className="mt-2.5 rounded-lg border px-3 py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between">
              <span>
                补全任务：<strong>{task.status === 'running' ? '正在限速抓取' : task.status}</strong> · 已处理 {task.done} / {task.total}
                {task.failed ? ` · 失败 ${task.failed}` : ''}
              </span>
              <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
                {task.total ? Math.round((task.done / task.total) * 100) : 0}%
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
              <div
                className="h-full rounded-full bg-blue-500 transition-all"
                style={{ width: `${task.total ? Math.min(100, (task.done / task.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        {candidates && (
          <>
            {(candidates.directArticles.length > 0 || candidates.quotedArticles.length > 0) && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
                <span>
                  共检测到 <strong>{(candidates.directArticles.length + candidates.quotedArticles.length).toLocaleString()}</strong> 条残缺 X 文章（含直接收藏与被 quote 文章），按收藏热度优先补全全文与配图
                </span>
                <button
                  type="button"
                  disabled={task?.status === 'running'}
                  onClick={() => void startCombinedArticles()}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
                >
                  一键合并补全本批（前 {Math.min(batchSize, candidates.directArticles.length + candidates.quotedArticles.length)} 条）
                </button>
              </div>
            )}
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: '残缺 X 文章（直接收藏）', list: candidates.directArticles, hint: '缺全文或配图，高收藏优先' },
                { label: '引用了 X 文章（缺全文/图）', list: candidates.quotedArticles, hint: '保留长评 + 抓原文章全文配图' },
                { label: '疑似截断长推文 / Quote', list: candidates.truncated, hint: '补全 note_tweet 完整正文' },
                { label: '未还原 t.co 短链', list: candidates.tcoLinks, hint: '展开真实目标链接' },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border p-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="text-xs font-medium">{item.label}</div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>{item.hint}</div>
                  <div className="mt-2 flex items-baseline justify-between gap-2">
                    <span className="text-xl font-semibold tabular-nums">{item.list.length.toLocaleString()}</span>
                    <button
                      type="button"
                      disabled={!item.list.length || task?.status === 'running'}
                      onClick={() => void startRepair(item.list, item.label)}
                      className="rounded-lg border px-2.5 py-1 text-xs hover:border-[var(--accent)] disabled:opacity-40"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      补前 {Math.min(batchSize, item.list.length)} 条
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
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
