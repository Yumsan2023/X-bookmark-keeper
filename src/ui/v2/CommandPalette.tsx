import { useEffect, useRef, useState } from 'react'
import {
  Folder,
  Sparkles,
  Search,
  RefreshCw,
  Sun,
  Moon,
  Trash2,
  FlaskConical,
  Download,
  Settings,
  ArrowRight,
} from 'lucide-react'
import type { Post } from '@/shared/types'
import type { Library } from '../hooks'

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  lib: Library
  theme: 'dark' | 'light'
  onSelectPost: (post: Post) => void
  onSelectFolder: (folder: string) => void
  onNavigate: (view: string) => void
  onToggleTheme: () => void
  onQuickSync: () => void
  onExportHtml: () => void
  onSearchSubmit: (q: string) => void
}

export function CommandPalette({
  open,
  onClose,
  lib,
  theme,
  onSelectPost,
  onSelectFolder,
  onNavigate,
  onToggleTheme,
  onQuickSync,
  onExportHtml,
  onSearchSubmit,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Post[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHits([])
    setActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 20)
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setHits([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void lib.search({ query: q, page: 1, pageSize: 6 }).then((res) => {
        if (alive) setHits(res.hits.map((h) => h.post))
      })
    }, 120)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [open, query, lib])

  if (!open) return null

  const quickActions = [
    { id: 'sync', label: '立即执行增量同步', icon: RefreshCw, run: () => { onQuickSync(); onClose() } },
    { id: 'daily', label: '打开「每日唤醒 (Daily Review)」', icon: Sparkles, run: () => { onNavigate('daily'); onClose() } },
    { id: 'cleanup', label: '打开「X 端安全清理队列」', icon: Trash2, run: () => { onNavigate('cleanup'); onClose() } },
    { id: 'html', label: '导出当前视图为自包含离线 HTML', icon: Download, run: () => { onExportHtml(); onClose() } },
    { id: 'lab', label: '打开「时间线实验室 (For You / Strike)」', icon: FlaskConical, run: () => { onNavigate('lab'); onClose() } },
    { id: 'theme', label: theme === 'dark' ? '切换到浅色模式' : '切换到深色模式', icon: theme === 'dark' ? Sun : Moon, run: () => { onToggleTheme(); onClose() } },
    { id: 'settings', label: '打开设置与备份', icon: Settings, run: () => { onNavigate('settings'); onClose() } },
  ].filter((a) => !query.trim() || a.label.toLowerCase().includes(query.trim().toLowerCase()))

  const matchedFolders = lib.folders
    .filter((f) => !query.trim() || f.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 6)

  const totalItems = hits.length + matchedFolders.length + quickActions.length

  const runByIndex = (idx: number) => {
    if (idx < hits.length) {
      onSelectPost(hits[idx])
      onClose()
      return
    }
    const fIdx = idx - hits.length
    if (fIdx < matchedFolders.length) {
      onSelectFolder(matchedFolders[fIdx].name)
      onClose()
      return
    }
    const aIdx = fIdx - matchedFolders.length
    if (aIdx >= 0 && aIdx < quickActions.length) {
      quickActions[aIdx].run()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b px-4 py-3.5" style={{ borderColor: 'var(--border)' }}>
          <Search className="h-4 w-4 shrink-0" style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => (totalItems ? (i + 1) % totalItems : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => (totalItems ? (i - 1 + totalItems) % totalItems : 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (e.metaKey || e.ctrlKey || (!totalItems && query.trim())) {
                  onSearchSubmit(query.trim())
                  onClose()
                } else {
                  runByIndex(activeIdx)
                }
              }
            }}
            placeholder="搜索书签正文、@作者、领域文件夹或快捷命令..."
            className="w-full border-0 bg-transparent text-sm outline-none"
            style={{ color: 'var(--fg)' }}
          />
          <kbd
            className="rounded-md border px-1.5 py-0.5 text-[11px]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            ESC
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {query.trim() && (
            <button
              type="button"
              onClick={() => {
                onSearchSubmit(query.trim())
                onClose()
              }}
              className="mb-2 flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--hover)]"
              style={{ color: 'var(--accent)' }}
            >
              <span>在主工作台全文搜索「{query.trim()}」</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}

          {hits.length > 0 && (
            <div className="mb-2">
              <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                匹配书签
              </div>
              {hits.map((post, idx) => (
                <button
                  key={post.tweet_id}
                  type="button"
                  onClick={() => {
                    onSelectPost(post)
                    onClose()
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-xl px-3 py-2 text-left transition-colors"
                  style={{
                    background: activeIdx === idx ? 'var(--hover)' : 'transparent',
                  }}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium" style={{ color: 'var(--fg)' }}>
                      {post.name} <span style={{ color: 'var(--muted)' }}>@{post.screen_name}</span>
                    </span>
                    {post.folder && (
                      <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        {post.folder}
                      </span>
                    )}
                  </div>
                  <div className="line-clamp-1 text-xs" style={{ color: 'var(--muted)' }}>
                    {post.text}
                  </div>
                </button>
              ))}
            </div>
          )}

          {matchedFolders.length > 0 && (
            <div className="mb-2">
              <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                领域文件夹
              </div>
              {matchedFolders.map((f, i) => {
                const idx = hits.length + i
                return (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => {
                      onSelectFolder(f.name)
                      onClose()
                    }}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors"
                    style={{ background: activeIdx === idx ? 'var(--hover)' : 'transparent' }}
                  >
                    <span className="flex items-center gap-2.5">
                      <Folder className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                      <span>{f.name}</span>
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                      {f.count.toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {quickActions.length > 0 && (
            <div>
              <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                快捷操作
              </div>
              {quickActions.map((act, i) => {
                const Icon = act.icon
                const idx = hits.length + matchedFolders.length + i
                return (
                  <button
                    key={act.id}
                    type="button"
                    onClick={act.run}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors"
                    style={{ background: activeIdx === idx ? 'var(--hover)' : 'transparent' }}
                  >
                    <Icon className="h-4 w-4" style={{ color: 'var(--muted)' }} />
                    <span>{act.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
