import { useState } from 'react'
import { Save, Database, Cpu, Sliders, FileText, Trash2, RefreshCw, Plus } from 'lucide-react'
import { clearAll } from '@/db/posts'
import { applyUiFontSize, clampUiFontSize, UI_FONT_STEPS } from '@/shared/ui-font'
import type { NotionDatabaseEntry, Settings } from '@/shared/types'
import { bg, type Library } from '../hooks'
import { useDialogs } from '../components/Dialogs'
import { AccountBookmarkExport } from '../components/AccountBookmarkExport'
import { FullBackupPanel } from '../components/FullBackupPanel'

type Section = 'general' | 'notion' | 'llm' | 'data'

export function SettingsV2View({
  settings,
  save,
  lib,
  onNotify,
}: {
  settings: Settings
  save: (s: Settings) => Promise<void>
  lib: Library
  onNotify: (msg: string) => void
}) {
  const { confirm } = useDialogs()
  const [section, setSection] = useState<Section>('general')
  const [s, setS] = useState(settings)
  const [libraryRev, setLibraryRev] = useState(0)
  const [fetchingDbs, setFetchingDbs] = useState(false)
  const [newDbName, setNewDbName] = useState('')
  const [newDbId, setNewDbId] = useState('')

  const fetchNotionDbs = async () => {
    if (!s.notionToken.trim()) {
      onNotify('请先填入 Notion Integration Token')
      return
    }
    const origin = 'https://api.notion.com/*'
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] })
      if (!granted) {
        onNotify('未授予 api.notion.com 访问权限')
        return
      }
    }
    setFetchingDbs(true)
    try {
      const res = await bg<NotionDatabaseEntry[]>({ type: 'notion/listDatabases', token: s.notionToken })
      if (res.ok && res.data) {
        const mergedMap = new Map<string, NotionDatabaseEntry>()
        for (const db of s.notionDatabases ?? []) mergedMap.set(db.id, db)
        for (const db of res.data) mergedMap.set(db.id, db)
        const nextDbs = [...mergedMap.values()]
        const nextDefault = s.notionDatabaseId || nextDbs[0]?.id || ''
        const next = { ...s, notionDatabases: nextDbs, notionDatabaseId: nextDefault }
        setS(next)
        await save(next)
        onNotify(`已拉取到 ${res.data.length} 个 Notion 数据库并自动保存`)
      } else {
        onNotify(`拉取失败：${res.error}`)
      }
    } finally {
      setFetchingDbs(false)
    }
  }

  const up = (patch: Partial<Settings>) => setS((c) => ({ ...c, ...patch }))
  const upLlm = (patch: Partial<Settings['llm']>) => setS((c) => ({ ...c, llm: { ...c.llm, ...patch } }))

  const doSave = async () => {
    if (s.llm.endpoint.trim()) {
      try {
        const origin = new URL(s.llm.endpoint).origin + '/*'
        if (!(await chrome.permissions.contains({ origins: [origin] }))) {
          await chrome.permissions.request({ origins: [origin] })
        }
      } catch {
        /* ignore invalid URL */
      }
    }
    if (s.notionToken.trim()) {
      try {
        const origin = 'https://api.notion.com/*'
        if (!(await chrome.permissions.contains({ origins: [origin] }))) {
          await chrome.permissions.request({ origins: [origin] })
        }
      } catch {
        /* ignore */
      }
    }
    const fixed: Settings = {
      ...s,
      delayMaxSec: Math.max(s.delayMinSec, s.delayMaxSec),
      pageSize: Math.min(100, Math.max(10, s.pageSize)),
      exportBatchSize: Math.min(10000, Math.max(100, s.exportBatchSize || 1000)),
      autoSyncCooldownMin: Math.min(1440, Math.max(1, s.autoSyncCooldownMin || 20)),
      cleanupDailyCap: Math.min(300, Math.max(1, s.cleanupDailyCap || 50)),
    }
    setS(fixed)
    await save(fixed)
    onNotify('设置已保存')
  }

  const tabs: { id: Section; label: string; icon: typeof Sliders }[] = [
    { id: 'general', label: '外观与同步', icon: Sliders },
    { id: 'notion', label: 'Notion 集成', icon: FileText },
    { id: 'llm', label: 'AI 模型配置', icon: Cpu },
    { id: 'data', label: '热库恢复与备份', icon: Database },
  ]

  return (
    <div className="mx-auto max-w-4xl px-5 py-3.5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">设置与数据管理</h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            精简分区配置：外观、自动同步、Notion 直推、本地/云端模型与热库导入导出。
          </p>
        </div>
        {section !== 'data' && (
          <button
            type="button"
            onClick={() => void doSave()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold"
            style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
          >
            <Save className="h-3.5 w-3.5" /> 保存设置
          </button>
        )}
      </div>

      {/* Category pill tabs */}
      <div className="mb-3.5 flex flex-wrap gap-1.5">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = section === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
              style={{
                background: active ? 'var(--accent-soft)' : 'var(--card)',
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                color: active ? 'var(--accent)' : 'var(--fg)',
              }}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>

      {section === 'general' && (
        <div className="v2-card space-y-3.5 p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>界面主题</span>
              <select
                value={s.theme}
                onChange={async (e) => {
                  const theme = e.target.value as Settings['theme']
                  const next = { ...s, theme }
                  setS(next)
                  await save(next)
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              >
                <option value="dark">深邃暗黑（Linear Dark）</option>
                <option value="light">纯净浅白（Reader Light）</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>界面语言</span>
              <select
                value={s.lang}
                onChange={(e) => up({ lang: e.target.value as Settings['lang'] })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              >
                <option value="zh">简体中文</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-medium" style={{ color: 'var(--muted)' }}>界面字号</span>
              <span className="tabular-nums font-medium">{clampUiFontSize(s.uiFontSize)} px</span>
            </div>
            <input
              type="range"
              min={0}
              max={UI_FONT_STEPS.length - 1}
              step={1}
              value={Math.max(0, UI_FONT_STEPS.indexOf(clampUiFontSize(s.uiFontSize) as (typeof UI_FONT_STEPS)[number]))}
              onChange={async (e) => {
                const uiFontSize = UI_FONT_STEPS[Number(e.target.value)] ?? 15
                const next = { ...s, uiFontSize }
                setS(next)
                applyUiFontSize(uiFontSize)
                await save(next)
              }}
              className="w-full accent-[var(--accent)]"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-2" style={{ borderColor: 'var(--border)' }}>
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>自动增量同步冷却（分钟）</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={s.autoSyncCooldownMin}
                onChange={(e) => up({ autoSyncCooldownMin: Number(e.target.value) || 20 })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>X 清理队列每日安全上限（条/天）</span>
              <input
                type="number"
                min={1}
                max={300}
                value={s.cleanupDailyCap}
                onChange={(e) => up({ cleanupDailyCap: Number(e.target.value) || 50 })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
            </label>
          </div>

          <div className="space-y-2 border-t pt-4 text-xs" style={{ borderColor: 'var(--border)' }}>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={s.autoSyncOnXOpen} onChange={(e) => up({ autoSyncOnXOpen: e.target.checked })} />
              <span>打开 x.com 自动识别登录账号并静默增量扫描书签</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={s.syncFolders} onChange={(e) => up({ syncFolders: e.target.checked })} />
              <span>同步 X 原生书签文件夹</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={s.detectDeleted} onChange={(e) => up({ detectDeleted: e.target.checked })} />
              <span>全量同步后保留并标记已删/已取消书签</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={s.confirmBulkDelete} onChange={(e) => up({ confirmBulkDelete: e.target.checked })} />
              <span>批量取消 X 书签前强制二次确认</span>
            </label>
          </div>
        </div>
      )}

      {section === 'notion' && (
        <div className="v2-card space-y-4 p-4">
          <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
            配置后可在阅读抽屉里像 Antigravity 一样<strong>划词引用或引用整篇文章并写批注</strong>，一键选择目标 Notion 数据库同步过去。Token 仅存本机，导出备份默认不包含。
          </div>
          <label className="block text-xs">
            <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>Notion Integration Token (secret_... / ntn_...)</span>
            <div className="flex gap-2">
              <input
                type="password"
                value={s.notionToken}
                onChange={(e) => up({ notionToken: e.target.value })}
                placeholder="ntn_..."
                className="flex-1 rounded-lg border px-3 py-1.5 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
              <button
                type="button"
                disabled={fetchingDbs || !s.notionToken.trim()}
                onClick={() => void fetchNotionDbs()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)] disabled:opacity-40"
                style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${fetchingDbs ? 'animate-spin' : ''}`} />
                <span>{fetchingDbs ? '拉取中...' : '一键拉取我的数据库'}</span>
              </button>
            </div>
          </label>

          {/* Multi-database list */}
          <div className="border-t pt-3.5" style={{ borderColor: 'var(--border)' }}>
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium">可选目标数据库（{(s.notionDatabases ?? []).length} 个，引用批注时可自由切换）</span>
              <span style={{ color: 'var(--muted)' }}>点击设为默认</span>
            </div>
            {(s.notionDatabases ?? []).length > 0 ? (
              <div className="mb-3 space-y-1.5">
                {(s.notionDatabases ?? []).map((entry) => {
                  const isDef = s.notionDatabaseId === entry.id
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs"
                      style={{
                        borderColor: isDef ? 'var(--accent)' : 'var(--border)',
                        background: isDef ? 'var(--accent-soft)' : 'var(--surface)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => up({ notionDatabaseId: entry.id })}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate font-medium">{entry.name}</span>
                        <code className="truncate text-[10.5px]" style={{ color: 'var(--muted)' }}>{entry.id}</code>
                        {isDef && <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--accent)', color: '#fff' }}>默认</span>}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const nextList = (s.notionDatabases ?? []).filter((x) => x.id !== entry.id)
                          up({
                            notionDatabases: nextList,
                            notionDatabaseId: isDef ? nextList[0]?.id ?? '' : s.notionDatabaseId,
                          })
                        }}
                        className="rounded p-1 hover:text-rose-400"
                        style={{ color: 'var(--muted)' }}
                        title="移除此数据库"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="mb-3 rounded-lg border border-dashed px-3 py-2.5 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                尚未添加数据库：可点上方「一键拉取我的数据库」（需在 Notion 页面右上角 Connections 授权你的 Integration），或在下方手动添加。
              </div>
            )}

            {/* Manual add database */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <input
                value={newDbName}
                onChange={(e) => setNewDbName(e.target.value)}
                placeholder="数据库名称（如：随想与笔记库）"
                className="rounded-lg border px-2.5 py-1.5 text-xs sm:col-span-4"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
              <input
                value={newDbId}
                onChange={(e) => setNewDbId(e.target.value)}
                placeholder="32 位 Database ID"
                className="rounded-lg border px-2.5 py-1.5 text-xs sm:col-span-6"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
              <button
                type="button"
                onClick={() => {
                  const id = newDbId.trim()
                  if (!id) return
                  const name = newDbName.trim() || `Database ${id.slice(0, 8)}`
                  const cur = s.notionDatabases ?? []
                  const nextList = [...cur.filter((x) => x.id !== id), { id, name }]
                  up({ notionDatabases: nextList, notionDatabaseId: s.notionDatabaseId || id })
                  setNewDbName('')
                  setNewDbId('')
                }}
                className="inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:border-[var(--accent)] sm:col-span-2"
                style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
              >
                <Plus className="h-3.5 w-3.5" /> 添加
              </button>
            </div>
          </div>

          <label className="block border-t pt-3 text-xs" style={{ borderColor: 'var(--border)' }}>
            <span className="mb-1 block font-medium" style={{ color: 'var(--muted)' }}>默认 Database ID（兼容旧版单项配置）</span>
            <input
              value={s.notionDatabaseId}
              onChange={(e) => up({ notionDatabaseId: e.target.value })}
              placeholder="32 位 UUID，例如 4248ec4ca80981d69b56e34ccfb8069e"
              className="w-full rounded-lg border px-3 py-1.5 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            />
          </label>
        </div>
      )}

      {section === 'llm' && (
        <div className="v2-card space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>一键填入本机端点预设：</span>
            <button
              type="button"
              onClick={() => upLlm({ endpoint: 'http://127.0.0.1:1234/v1', apiKey: '', model: 'qwen2.5-7b-instruct' })}
              className="rounded-lg border px-2.5 py-1 text-xs hover:border-[var(--accent)]"
              style={{ borderColor: 'var(--border)' }}
            >
              LM Studio (127.0.0.1:1234)
            </button>
            <button
              type="button"
              onClick={() => upLlm({ endpoint: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:7b' })}
              className="rounded-lg border px-2.5 py-1 text-xs hover:border-[var(--accent)]"
              style={{ borderColor: 'var(--border)' }}
            >
              Ollama (127.0.0.1:11434)
            </button>
          </div>
          <label className="block text-xs">
            <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>OpenAI 兼容 Endpoint</span>
            <input
              value={s.llm.endpoint}
              onChange={(e) => upLlm({ endpoint: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>API Key（本机 LM Studio / Ollama 可留空）</span>
              <input
                type="password"
                value={s.llm.apiKey}
                onChange={(e) => upLlm({ apiKey: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1.5 block font-medium" style={{ color: 'var(--muted)' }}>模型名称</span>
              <input
                value={s.llm.model}
                onChange={(e) => upLlm({ model: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
              />
            </label>
          </div>
        </div>
      )}

      {section === 'data' && (
        <div className="v2-legacy-wrap space-y-4">
          <div className="rounded-xl border px-4 py-3 text-xs" style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}>
            <strong>提示：</strong>要把 Phase 2 瘦身后的 <strong>22.42 MB 精选热库</strong>（<code>data_sandbox/out/hot_library_backup.json</code>）导入扩展，直接点击下方「从备份恢复」选择该文件即可一步替换，10 大 Notion 领域文件夹与形态标签会自动就位！
          </div>
          <FullBackupPanel
            onNotify={onNotify}
            onLibraryChange={() => {
              setLibraryRev((v) => v + 1)
              void lib.reload()
            }}
          />
          <AccountBookmarkExport revision={libraryRev} onNotify={onNotify} />
          <div className="v2-card flex items-center justify-between p-4">
            <div>
              <div className="text-sm font-medium text-rose-400">清空本地书签库</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>仅清除浏览器 IndexedDB 中的书签缓存，不影响 X 端书签与本地 SQLite 冷库。</div>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (!(await confirm('确定清空本地 IndexedDB 书签库？建议先确认已有备份。'))) return
                await clearAll()
                setLibraryRev((v) => v + 1)
                await lib.reload()
                onNotify('本地书签库已清空')
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs text-rose-400 hover:bg-rose-500/10"
              style={{ borderColor: 'var(--danger)' }}
            >
              <Trash2 className="h-3.5 w-3.5" /> 清空数据
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
