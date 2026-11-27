import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ShieldAlert,
  Upload,
  Play,
  RotateCcw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  Pause,
} from 'lucide-react'
import {
  getCleanupSummary,
  importCleanupQueueJson,
  listCleanupQueue,
  removeCleanupItems,
  retryFailedCleanupItems,
  type CleanupQueueSummary,
} from '@/db/cleanup'
import type { CleanupItemStatus, CleanupQueueRow, Settings } from '@/shared/types'
import { bg, useTask } from '../hooks'
import { useDialogs } from '../components/Dialogs'

export function CleanupQueueView({
  settings,
  onNotify,
}: {
  settings: Settings
  onNotify: (msg: string) => void
}) {
  const { confirm } = useDialogs()
  const task = useTask()
  const fileRef = useRef<HTMLInputElement>(null)
  const [summary, setSummary] = useState<CleanupQueueSummary | null>(null)
  const [rows, setRows] = useState<CleanupQueueRow[]>([])
  const [accountFilter, setAccountFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<CleanupItemStatus | 'all'>('pending')
  const [batchLimit, setBatchLimit] = useState<number>(Math.min(20, settings.cleanupDailyCap || 50))
  const [removeLocal, setRemoveLocal] = useState<boolean>(false)
  const [runningMsg, setRunningMsg] = useState<string>('')

  const reload = useCallback(async () => {
    const [sum, list] = await Promise.all([
      getCleanupSummary(),
      listCleanupQueue({ account: accountFilter, status: statusFilter, limit: 200 }),
    ])
    setSummary(sum)
    setRows(list)
  }, [accountFilter, statusFilter])

  useEffect(() => {
    void reload()
  }, [reload, task?.done, task?.status])

  const handleImport = async (file: File) => {
    try {
      const text = await file.text()
      const res = await importCleanupQueueJson(text)
      await reload()
      onNotify(`已导入 ${res.importedItems} 条待清理项 + ${res.importedTombstones.toLocaleString()} 条冷库防回灌墓碑`)
    } catch (e) {
      onNotify(`导入失败：${(e as Error).message}`)
    }
  }

  const handleRunBatch = async () => {
    const ok = await confirm(
      `确认向 X 发送「取消收藏」请求？\n\n` +
        `• 本批最多执行：${batchLimit} 条（每日上限 ${settings.cleanupDailyCap} 条）\n` +
        `• 仅处理「当前已登录 X 账号」名下的待清理条目，自动跳过其他账号\n` +
        `• 每条间隔 3–6 秒随机延迟，遇 2 次限流自动暂停\n` +
        `• X 端取消收藏不可撤销（本地 SQLite 冷库仍永久留底）`,
    )
    if (!ok) return
    setRunningMsg('正在启动安全清理批次...')
    const res = await bg<{ account: string; queued: number; remainingToday: number; dailyCap: number }>({
      type: 'cleanup/run',
      limit: batchLimit,
      removeLocal,
    })
    if (res.ok && res.data) {
      const d = res.data
      setRunningMsg(
        d.queued > 0
          ? `已启动 @${d.account} 的 ${d.queued} 条安全清理任务（今日剩余额度 ${d.remainingToday}/${d.dailyCap}）`
          : `当前登录账号 @${d.account} 暂无可执行的待清理条目，或今日额度已用完（${d.remainingToday}/${d.dailyCap}）`,
      )
    } else {
      setRunningMsg(`无法启动：${res.error}`)
    }
  }

  const isCleanupRunning = task?.kind === 'cleanup' && task.status === 'running'

  return (
    <div className="mx-auto max-w-5xl px-5 py-3.5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">X 端安全清理队列（仅分类待审 · 手动限速执行）</h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            绝不自动删任何书签。导入离线产出的 <code>cleanup_queue_by_account.json</code>，逐条复核后再按当前登录账号分批安全取消 X 端收藏。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void handleImport(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>导入清理队列 JSON</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          { label: '待复核/待执行', value: summary?.pending ?? 0, color: 'var(--warn)' },
          { label: '已安全取消', value: summary?.done ?? 0, color: 'var(--ok)' },
          { label: '执行失败', value: summary?.failed ?? 0, color: 'var(--danger)' },
          { label: '冷库防回灌墓碑', value: summary?.tombstones ?? 0, color: 'var(--accent)' },
        ].map((k) => (
          <div key={k.label} className="v2-card px-3.5 py-2">
            <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{k.label}</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums leading-tight" style={{ color: k.color }}>
              {k.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Safe Execution Control Bar */}
      <div className="v2-card mb-3 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            <span>单批执行条数：</span>
            <input
              type="number"
              min={1}
              max={settings.cleanupDailyCap || 50}
              value={batchLimit}
              onChange={(e) => setBatchLimit(Math.max(1, Number(e.target.value) || 10))}
              className="w-16 rounded-lg border px-2 py-0.5 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            />
            <label className="inline-flex cursor-pointer items-center gap-1.5" style={{ color: 'var(--muted)' }}>
              <input type="checkbox" checked={removeLocal} onChange={(e) => setRemoveLocal(e.target.checked)} />
              <span>同时从扩展热库移除记录</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            {(summary?.failed ?? 0) > 0 && (
              <button
                type="button"
                onClick={async () => {
                  const n = await retryFailedCleanupItems()
                  await reload()
                  onNotify(`已将 ${n} 条失败项重置为待执行`)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-[var(--hover)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <RotateCcw className="h-3.5 w-3.5" /> 重试失败项
              </button>
            )}
            {isCleanupRunning ? (
              <button
                type="button"
                onClick={() => void bg({ type: 'sync/cancel' })}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-rose-400 hover:bg-rose-500/10"
                style={{ borderColor: 'var(--danger)' }}
              >
                <Pause className="h-3.5 w-3.5" /> 停止当前批次 ({task.done}/{task.total})
              </button>
            ) : (
              <button
                type="button"
                disabled={(summary?.pending ?? 0) === 0}
                onClick={() => void handleRunBatch()}
                className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40"
                style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
              >
                <Play className="h-3.5 w-3.5" /> 执行当前账号安全清理批次
              </button>
            )}
          </div>
        </div>
        {runningMsg && <div className="mt-2 text-xs" style={{ color: 'var(--accent)' }}>{runningMsg}</div>}
      </div>

      {/* Filters */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setAccountFilter('all')}
            className="rounded-full border px-2.5 py-0.5 text-xs"
            style={{
              background: accountFilter === 'all' ? 'var(--accent-soft)' : 'transparent',
              borderColor: accountFilter === 'all' ? 'var(--accent)' : 'var(--border)',
              color: accountFilter === 'all' ? 'var(--accent)' : 'var(--muted)',
            }}
          >
            全部账号 ({summary?.total ?? 0})
          </button>
          {(summary?.byAccount ?? []).map((a) => (
            <button
              key={a.account}
              type="button"
              onClick={() => setAccountFilter(a.account)}
              className="rounded-full border px-2.5 py-0.5 text-xs"
              style={{
                background: accountFilter === a.account ? 'var(--accent-soft)' : 'transparent',
                borderColor: accountFilter === a.account ? 'var(--accent)' : 'var(--border)',
                color: accountFilter === a.account ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              @{a.account} ({a.pending} 待清)
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['pending', 'done', 'failed', 'all'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className="rounded-lg border px-2 py-0.5 text-xs"
              style={{
                background: statusFilter === st ? 'var(--surface-2)' : 'transparent',
                borderColor: statusFilter === st ? 'var(--border-strong)' : 'var(--border)',
              }}
            >
              {st === 'pending' ? '待处理' : st === 'done' ? '已取消' : st === 'failed' ? '失败' : '全部'}
            </button>
          ))}
        </div>
      </div>

      {/* Items list */}
      <div className="space-y-1.5">
        {rows.length === 0 ? (
          <div className="v2-card p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
            当前筛选条件下暂无待清理条目。
          </div>
        ) : (
          rows.map((r) => (
            <div key={r.tweet_id} className="v2-card flex items-start justify-between gap-3 px-3.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {r.status === 'pending' && <Clock className="h-3.5 w-3.5 text-amber-400" />}
                  {r.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                  {r.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-rose-400" />}
                  <span className="font-medium">@{r.screen_name || 'unknown'}</span>
                  <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>
                    {r.reason}
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    归属: {(r.accounts ?? [r.account]).map((a) => `@${a}`).join(', ')}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>
                  {r.text_preview || '(空正文)'}
                </div>
                {r.error && <div className="mt-1 text-[11px] text-rose-400">错误: {r.error}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border p-1.5 hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                  title="查看原帖"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    await removeCleanupItems([r.tweet_id])
                    await reload()
                    onNotify('已从清理队列移出（保留原书签）')
                  }}
                  className="rounded-lg border p-1.5 hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                  title="移出清理队列（不删书签）"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
