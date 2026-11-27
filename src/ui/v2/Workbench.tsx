import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  Bookmark,
  Sparkles,
  Inbox,
  Image as ImageIcon,
  Layers,
  Trash2,
  RefreshCw,
  FlaskConical,
  Settings,
  Search,
  Sun,
  Moon,
  LayoutGrid,
  List,
  Download,
  FolderOpen,
  Tag,
  Send,
  Wrench,
  Heart,
  Eye,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Square,
  SlidersHorizontal,
  X,
  FileText,
  AlignLeft,
  MessageSquareQuote,
  Calendar,
  Loader2,
} from 'lucide-react'
import { APP_VERSION } from '@/backup/full'
import { enqueuePostsForCleanup, getCleanupSummary } from '@/db/cleanup'
import { addTags, listBookmarkAccounts, moveToFolder } from '@/db/posts'
import { countYearsForQuery, type YearBucket } from '@/db/query'
import { postsToCsv } from '@/export/csv'
import { postsToSelfContainedHtml } from '@/export/html'
import { postsToJson } from '@/export/json'
import { postsToObsidianFiles } from '@/export/markdown'
import { createZip } from '@/export/zip'
import { groupByOriginal } from '@/library/quote-groups'
import type { Filters, SortKey } from '@/search/engine'
import { parseQuery } from '@/search/query-parser'
import { bumpDbVersion } from '@/shared/storage'
import { STORAGE_KEYS, type LastFullSyncMeta, type Post, type Settings as SettingsType } from '@/shared/types'
import { applyUiFontSize } from '@/shared/ui-font'
import { bg, useLibrary, useProgress, useSettings, useTask } from '../hooks'
import { SyncReportView } from '../components/SyncReportView'

const DOMAIN_COLORS: Record<string, string> = {
  'AI工具与工作流': '#8b5cf6',
  '编程与技术开发': '#3b82f6',
  '投资理财与宏观': '#10b981',
  '效率与知识管理': '#06b6d4',
  '职业与副业营销': '#f59e0b',
  '认知心理与深度思考': '#ec4899',
  '健康与运动': '#22c55e',
  '生活美食与旅游': '#f97316',
  '创作与兴趣': '#a855f7',
  '资讯与娱乐': '#64748b',
  '待清理': '#f43f5e',
}
const FALLBACK_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#f97316']
function folderColor(name: string): string {
  if (DOMAIN_COLORS[name]) return DOMAIN_COLORS[name]
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]
}
import { CommandPalette } from './CommandPalette'
import { ReaderDrawer } from './ReaderDrawer'
import { HighlightText, findMatchedSnippet } from './HighlightText'
import { DailyReviewView } from './DailyReviewView'
import { CleanupQueueView } from './CleanupQueueView'
import { SyncRepairView } from './SyncRepairView'
import { TimelineLabView } from './TimelineLabView'
import { SettingsV2View } from './SettingsV2View'

type NavView =
  | 'library'
  | 'daily'
  | 'xarticles'
  | 'longpost'
  | 'longquote'
  | 'unfiled'
  | 'gallery'
  | 'groups'
  | 'cleanup'
  | 'sync'
  | 'lab'
  | 'settings'
type DisplayMode = 'cards' | 'table' | 'gallery'

const MAX_AUTOLOAD_ITEMS = 400
const PAGE_SIZE_OPTIONS = [30, 50, 100, 200] as const

function triggerDownload(filename: string, content: string | Uint8Array, mime: string) {
  const bytes = typeof content === 'string' ? content : new Uint8Array(content)
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Workbench({ mode }: { mode: 'full' | 'side' }) {
  const [settings, save] = useSettings()
  const lib = useLibrary()
  const progress = useProgress()
  const task = useTask()

  const initialView: NavView = useMemo(() => {
    const h = window.location.hash.replace(/^#/, '')
    if (h === 'strike' || h === 'foryou' || h === 'lab') return 'lab'
    if (h === 'daily') return 'daily'
    if (h === 'cleanup') return 'cleanup'
    if (h === 'sync') return 'sync'
    if (h === 'settings') return 'settings'
    return 'library'
  }, [])

  const [view, setView] = useState<NavView>(initialView)
  const [displayMode, setDisplayMode] = useState<DisplayMode>('cards')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(mode === 'side')
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('xt_v2_sidebar_w'))
    return Number.isFinite(saved) && saved >= 180 && saved <= 360 ? saved : 224
  })
  const [readerWidth, setReaderWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('xt_v2_reader_w'))
    return Number.isFinite(saved) && saved >= 320 && saved <= 1100 ? saved : 500
  })
  const [draggingPane, setDraggingPane] = useState<'sidebar' | 'reader' | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [toast, setToast] = useState('')

  // Query & filter state
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeFolder, setActiveFolder] = useState<string>('') // '' = all, '__none__' = unfiled
  const [activeAccount, setActiveAccount] = useState<string>('') // '' = all
  const [activeTag, setActiveTag] = useState<string>('')
  const [activeYear, setActiveYear] = useState<string>('') // '' = all, '2026', '2025', '2024', 'older'
  const [yearBuckets, setYearBuckets] = useState<YearBucket[]>([])
  const [mediaFilter, setMediaFilter] = useState<'' | 'image' | 'video' | 'link' | 'quote'>('')
  const [sort, setSort] = useState<SortKey>('saved_desc')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(() => {
    const saved = Number(localStorage.getItem('xt_v2_page_size'))
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(saved) ? saved : 50
  })
  const [autoLoadMore, setAutoLoadMore] = useState<boolean>(() => localStorage.getItem('xt_v2_autoload') !== '0')
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadedExtraPages, setLoadedExtraPages] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [dropFolder, setDropFolder] = useState<string | null>(null)

  // Results & selection
  const [posts, setPosts] = useState<Post[]>([])
  const [total, setTotal] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [selectedPost, setSelectedPost] = useState<Post | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [focusedIdx, setFocusedIdx] = useState<number>(0)

  // Metadata badges
  const [accounts, setAccounts] = useState<{ account: string; count: number }[]>([])
  const [cleanupPending, setCleanupPending] = useState(0)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const mainScrollRef = useRef<HTMLElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const feedReqIdRef = useRef(0)
  const feedSignalRef = useRef({ aborted: false })
  const PAGE_SIZE = pageSize

  const highlightTerms = useMemo(() => {
    const p = parseQuery(debouncedQuery)
    return [...p.terms, ...p.phrases]
  }, [debouncedQuery])

  const notify = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 4500)
  }, [])

  // Theme & font sync
  const themeClass = settings.theme === 'light' ? 'theme-x-light' : 'theme-x-dark'
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-x-dark', 'theme-x-light')
    root.classList.add(themeClass)
  }, [themeClass])

  useEffect(() => {
    applyUiFontSize(settings.uiFontSize)
  }, [settings.uiFontSize])

  // Debounce search query
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query)
      setPage(0)
    }, 240)
    return () => clearTimeout(t)
  }, [query])

  // Load account counts & cleanup pending badge
  useEffect(() => {
    void listBookmarkAccounts().then(setAccounts)
    void getCleanupSummary().then((s) => setCleanupPending(s.pending))
  }, [lib.version, view])

  // Full sync pending report auto-open
  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEYS.lastFullSync).then((r) => {
      const m = r[STORAGE_KEYS.lastFullSync] as LastFullSyncMeta | undefined
      if (m?.pendingReport) {
        setReportOpen(true)
        void chrome.storage.local.set({ [STORAGE_KEYS.lastFullSync]: { ...m, pendingReport: false } })
      }
    })
  }, [progress?.status])

  // Fetch paged bookmarks whenever query/filters/view/db version change
  const isFeedView =
    view === 'library' ||
    view === 'xarticles' ||
    view === 'longpost' ||
    view === 'longquote' ||
    view === 'unfiled' ||
    view === 'gallery' ||
    view === 'groups'

  const buildQuerySpec = useCallback((): { fullQuery: string; baseFilters: Filters; filters: Filters } => {
    const folderClause =
      view === 'unfiled' || activeFolder === '__none__'
        ? 'folder:none'
        : activeFolder
          ? /\s/.test(activeFolder)
            ? `folder:"${activeFolder}"`
            : `folder:${activeFolder}`
          : ''
    const hasClause =
      view === 'gallery'
        ? 'has:media'
        : mediaFilter
          ? `has:${mediaFilter}`
          : ''
    const fullQuery = [debouncedQuery.trim(), folderClause, hasClause].filter(Boolean).join(' ')
    const viewTags: string[] = []
    const excludeTags: string[] = []
    if (view === 'xarticles') viewTags.push('X文章')
    if (view === 'longpost') {
      viewTags.push('长文章')
      excludeTags.push('X文章')
    }
    if (view === 'longquote') viewTags.push('长Quote')
    if (activeTag && !viewTags.includes(activeTag)) viewTags.push(activeTag)

    const baseFilters: Filters = {
      ...(activeAccount ? { accounts: [activeAccount] } : {}),
      ...(viewTags.length ? { tags: viewTags } : {}),
      ...(excludeTags.length ? { excludeTags } : {}),
    }

    let since: number | undefined
    let until: number | undefined
    if (activeYear === 'older') {
      since = 0
      until = new Date(2024, 0, 1).getTime() - 1
    } else if (/^\d{4}$/.test(activeYear)) {
      const y = Number(activeYear)
      since = new Date(y, 0, 1).getTime()
      until = new Date(y + 1, 0, 1).getTime() - 1
    }
    const filters: Filters = {
      ...baseFilters,
      ...(since != null ? { since } : {}),
      ...(until != null ? { until } : {}),
    }
    return { fullQuery, baseFilters, filters }
  }, [view, activeFolder, mediaFilter, debouncedQuery, activeAccount, activeTag, activeYear])

  const loadFeed = useCallback(async () => {
    if (!isFeedView) return
    // 中止上一次尚未完成的搜索，彻底防止旧的慢查询（例如刚输入单字母时）覆盖新的精确结果
    const reqId = ++feedReqIdRef.current
    feedSignalRef.current.aborted = true
    const signal = { aborted: false }
    feedSignalRef.current = signal

    setFetching(true)
    setLoadedExtraPages(0)
    try {
      const { fullQuery, filters } = buildQuerySpec()
      const limit = view === 'groups' ? 1500 : PAGE_SIZE
      const res = await lib.search({
        query: fullQuery,
        sort,
        page: view === 'groups' ? 0 : page,
        pageSize: limit,
        filters,
        signal,
      })
      if (signal.aborted || reqId !== feedReqIdRef.current) return
      const nextPosts = res.hits.map((h) => h.post)
      setPosts(nextPosts)
      setTotal(res.total)
      setSelectedPost((cur) => (cur ? nextPosts.find((p) => p.tweet_id === cur.tweet_id) ?? cur : null))
    } finally {
      if (reqId === feedReqIdRef.current) {
        setFetching(false)
      }
    }
  }, [isFeedView, buildQuerySpec, view, PAGE_SIZE, lib, sort, page])

  const loadMoreFeed = useCallback(async () => {
    if (!isFeedView || view === 'groups' || fetching || loadingMore) return
    const nextPageIdx = page + loadedExtraPages + 1
    if (nextPageIdx * PAGE_SIZE >= total) return
    if (posts.length >= MAX_AUTOLOAD_ITEMS) return
    const reqId = feedReqIdRef.current
    const signal = feedSignalRef.current
    setLoadingMore(true)
    try {
      const { fullQuery, filters } = buildQuerySpec()
      const res = await lib.search({
        query: fullQuery,
        sort,
        page: nextPageIdx,
        pageSize: PAGE_SIZE,
        filters,
        signal,
      })
      if (signal.aborted || reqId !== feedReqIdRef.current) return
      const more = res.hits.map((h) => h.post)
      if (more.length) {
        setPosts((prev) => {
          const seen = new Set(prev.map((p) => p.tweet_id))
          return [...prev, ...more.filter((p) => !seen.has(p.tweet_id))]
        })
        setLoadedExtraPages((n) => n + 1)
      }
      setTotal(res.total)
    } finally {
      setLoadingMore(false)
    }
  }, [isFeedView, view, fetching, loadingMore, page, loadedExtraPages, PAGE_SIZE, total, posts.length, buildQuerySpec, lib, sort])

  useEffect(() => {
    void loadFeed()
  }, [loadFeed, lib.version])

  // Compute live year sub-classification counts for current view/folder/account/tag
  useEffect(() => {
    if (!isFeedView || view === 'groups') {
      setYearBuckets([])
      return
    }
    let alive = true
    const { fullQuery, baseFilters } = buildQuerySpec()
    void countYearsForQuery(parseQuery(fullQuery), baseFilters)
      .then((buckets) => {
        if (alive) setYearBuckets(buckets)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [isFeedView, view, buildQuerySpec, lib.version])

  // IntersectionObserver for smooth Auto-Load Next Page
  useEffect(() => {
    if (!autoLoadMore || !isFeedView || view === 'groups') return
    const el = loadMoreRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreFeed()
      },
      { root: mainScrollRef.current, rootMargin: '260px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [autoLoadMore, isFeedView, view, loadMoreFeed])

  // Global keyboard shortcuts (Cmd+K, J/K, Enter, X, Esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      const tag = (e.target as HTMLElement | null)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchInputRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else if (selectedPost) setSelectedPost(null)
        else if (checkedIds.size > 0) setCheckedIds(new Set())
      } else if (isFeedView && posts.length > 0) {
        if (e.key === 'j') {
          e.preventDefault()
          setFocusedIdx((i) => {
            const next = Math.min(posts.length - 1, i + 1)
            if (selectedPost) setSelectedPost(posts[next])
            return next
          })
        } else if (e.key === 'k') {
          e.preventDefault()
          setFocusedIdx((i) => {
            const next = Math.max(0, i - 1)
            if (selectedPost) setSelectedPost(posts[next])
            return next
          })
        } else if (e.key === 'Enter') {
          e.preventDefault()
          if (posts[focusedIdx]) setSelectedPost(posts[focusedIdx])
        } else if (e.key === 'x' && posts[focusedIdx]) {
          e.preventDefault()
          const target = posts[focusedIdx]
          void enqueuePostsForCleanup([target], 'shortcut:x')
            .then(() => moveToFolder([target.tweet_id], '待清理'))
            .then(() => bumpDbVersion())
            .then(() => {
              void loadFeed()
              notify(`已将 @${target.screen_name} 归入待清理队列`)
            })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, selectedPost, checkedIds.size, isFeedView, posts, focusedIdx, loadFeed, notify])

  const quickSync = async () => {
    const r = await bg<{ triggered: boolean; reason: string; account?: string }>({ type: 'sync/autoTrigger' })
    if (r.ok && r.data?.triggered) {
      notify(`已自动识别 @${r.data.account} 并开始静默增量同步`)
      return
    }
    const acctRes = await bg<{ screen_name: string }>({ type: 'account/current' })
    const acct = acctRes.ok ? acctRes.data?.screen_name : undefined
    const s = await bg({ type: 'sync/start', mode: 'incremental', ...(acct ? { account: acct } : {}) })
    notify(s.ok ? `已启动增量同步${acct ? ` (@${acct})` : ''}` : `同步未能启动：${s.error}`)
  }

  const toggleTheme = () => {
    const nextTheme: SettingsType['theme'] = settings.theme === 'light' ? 'dark' : 'light'
    void save({ ...settings, theme: nextTheme })
  }

  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBulkMove = async (folder: string) => {
    const ids = [...checkedIds]
    if (!ids.length) return
    await moveToFolder(ids, folder)
    await bumpDbVersion()
    setCheckedIds(new Set())
    await lib.reload()
    notify(`已将 ${ids.length} 条移入「${folder || '未归类'}」`)
  }

  const handleBulkCleanup = async () => {
    const ids = [...checkedIds]
    if (!ids.length) return
    const targetPosts = await lib.getPostsByIds(ids)
    await enqueuePostsForCleanup(targetPosts, 'bulk:workbench')
    await moveToFolder(ids, '待清理')
    await bumpDbVersion()
    setCheckedIds(new Set())
    await lib.reload()
    notify(`已将 ${ids.length} 条归入「待清理」并加入安全清理队列`)
  }

  const handleBulkNotion = async () => {
    if (!settings.notionToken || !settings.notionDatabaseId) {
      notify('请先在「设置 → Notion 集成」填写 Token 与 Database ID')
      return
    }
    const ids = [...checkedIds]
    if (!ids.length) return
    const origin = 'https://api.notion.com/*'
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] })
      if (!granted) return
    }
    const r = await bg({ type: 'notion/push', tweetIds: ids })
    if (r.ok) {
      setCheckedIds(new Set())
      notify(`已将 ${ids.length} 条加入 Notion 推送队列`)
    }
  }

  const handleExport = async (fmt: 'html' | 'obsidian' | 'json' | 'csv') => {
    setShowExportMenu(false)
    const target = checkedIds.size > 0 ? await lib.getPostsByIds([...checkedIds]) : posts
    if (!target.length) {
      notify('当前没有可导出的书签')
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    if (fmt === 'html') {
      triggerDownload(`x-bookmarks-${stamp}.html`, postsToSelfContainedHtml(target, activeFolder || 'X Bookmarks Archive'), 'text/html;charset=utf-8')
      notify(`已导出 ${target.length} 条为自包含离线 HTML`)
    } else if (fmt === 'obsidian') {
      const files = postsToObsidianFiles(target)
      const zip = createZip(files.map((f) => ({ name: f.name, data: new TextEncoder().encode(f.data) })))
      triggerDownload(`x-bookmarks-obsidian-${stamp}.zip`, zip, 'application/zip')
      notify(`已导出 ${target.length} 条 Obsidian Markdown Zip`)
    } else if (fmt === 'json') {
      triggerDownload(`x-bookmarks-${stamp}.json`, postsToJson(target), 'application/json;charset=utf-8')
      notify(`已导出 ${target.length} 条 JSON`)
    } else if (fmt === 'csv') {
      triggerDownload(`x-bookmarks-${stamp}.csv`, postsToCsv(target), 'text/csv;charset=utf-8')
      notify(`已导出 ${target.length} 条 CSV`)
    }
  }

  const onDropToFolder = async (folderName: string, e: DragEvent) => {
    e.preventDefault()
    setDropFolder(null)
    const draggedId = e.dataTransfer.getData('text/x-tweet-id')
    const ids = draggedId ? (checkedIds.has(draggedId) ? [...checkedIds] : [draggedId]) : [...checkedIds]
    if (!ids.length) return
    await moveToFolder(ids, folderName === '__none__' ? '' : folderName)
    await bumpDbVersion()
    setCheckedIds(new Set())
    await lib.reload()
    notify(`已移入「${folderName === '__none__' ? '未归类' : folderName}」(${ids.length} 条)`)
  }

  const quoteGroups = useMemo(() => {
    if (view !== 'groups') return []
    return groupByOriginal(posts).filter((g) => g.posts.length > 1)
  }, [view, posts])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isSyncing = progress?.status === 'running' || progress?.status === 'waiting'
  const notionReady = !!(settings.notionToken.trim() && settings.notionDatabaseId.trim())

  const openFolderView = (folderName: string) => {
    setView(folderName === '__none__' ? 'unfiled' : 'library')
    setActiveFolder(folderName)
    setPage(0)
  }

  const startResize = (which: 'sidebar' | 'reader', startClientX: number) => {
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
    const startW = which === 'sidebar' ? sidebarWidth : readerWidth
    const viewportCssW = window.innerWidth / zoom
    let latestW = startW
    setDraggingPane(which)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startClientX) / zoom
      if (which === 'sidebar') {
        latestW = Math.round(Math.min(360, Math.max(180, startW + delta)))
        setSidebarWidth(latestW)
      } else {
        const minCenter = 320
        const leftUsed = sidebarCollapsed ? 0 : sidebarWidth
        const maxReader = Math.max(360, Math.round(viewportCssW - leftUsed - minCenter))
        latestW = Math.round(Math.min(maxReader, Math.max(320, startW - delta)))
        setReaderWidth(latestW)
      }
    }

    const onUp = () => {
      setDraggingPane(null)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      localStorage.setItem(which === 'sidebar' ? 'xt_v2_sidebar_w' : 'xt_v2_reader_w', String(latestW))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className={`v2-workbench-shell flex w-full overflow-hidden ${themeClass}`} style={{ background: 'var(--bg)', color: 'var(--fg)' }}>
      {/* LEFT SIDEBAR */}
      {!sidebarCollapsed && (
        <>
          <aside
            className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)', width: `${sidebarWidth}px` }}
          >
          {/* Brand + Collapse */}
          <div className="flex shrink-0 items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <div
                className="flex h-6 w-6 items-center justify-center rounded-md font-bold text-xs"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                X
              </div>
              <div>
                <div className="text-[13px] font-semibold leading-none tracking-tight">X Toolkit</div>
                <div className="mt-0.5 text-[10px] leading-none" style={{ color: 'var(--muted)' }}>
                  v{APP_VERSION} · {lib.totalCount.toLocaleString()} 条
                </div>
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={toggleTheme}
                className="rounded-lg p-1 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
                title="切换明暗主题"
              >
                {settings.theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setSidebarCollapsed(true)}
                className="rounded-lg p-1 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
                title="收起侧边栏"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Cmd+K Search trigger */}
          <div className="shrink-0 px-2.5 pb-1.5">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex w-full items-center justify-between rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors hover:border-[var(--border-strong)]"
              style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              <span className="flex items-center gap-1.5">
                <Search className="h-3 w-3" />
                <span>快速搜索 / 命令...</span>
              </span>
              <kbd className="rounded border px-1 text-[10px]" style={{ borderColor: 'var(--border)' }}>⌘K</kbd>
            </button>
          </div>

          {/* Live auto-sync status pill */}
          <div className="shrink-0 px-2.5 pb-2">
            <button
              type="button"
              onClick={() => void quickSync()}
              className="flex w-full items-center justify-between rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
            >
              <span className="flex items-center gap-1.5 truncate">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSyncing ? 'animate-pulse bg-blue-500' : settings.autoSyncOnXOpen ? 'bg-emerald-500' : 'bg-slate-500'}`} />
                <span className="truncate">{isSyncing ? `同步中 (${progress?.fetched ?? 0})` : settings.autoSyncOnXOpen ? '自动增量同步已就绪' : '手动同步模式'}</span>
              </span>
              <RefreshCw className={`h-3 w-3 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} style={{ color: 'var(--muted)' }} />
            </button>
          </div>

          {/* Scrollable navigation */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {/* Smart Views */}
            <div className="space-y-0.5">
              {(() => {
                const xArtCount = lib.tags.find((t) => t.tag === 'X文章')?.count ?? 0
                const longAllCount = lib.tags.find((t) => t.tag === '长文章')?.count ?? 0
                const longPostCount = Math.max(0, longAllCount - xArtCount)
                const longQuoteCount = lib.tags.find((t) => t.tag === '长Quote')?.count ?? 0
                return [
                  { id: 'library' as const, label: '全部书签', icon: Bookmark, count: lib.totalCount, action: () => { setView('library'); setActiveFolder(''); setActiveYear(''); setPage(0) } },
                  { id: 'daily' as const, label: '每日唤醒', icon: Sparkles, count: 5, accent: true, action: () => setView('daily') },
                  { id: 'xarticles' as const, label: 'X 文章', icon: FileText, count: xArtCount, color: '#8b5cf6', action: () => { setView('xarticles'); setActiveFolder(''); setActiveYear(''); setPage(0) } },
                  { id: 'longpost' as const, label: '长推文 (Long Post)', icon: AlignLeft, count: longPostCount, color: '#3b82f6', action: () => { setView('longpost'); setActiveFolder(''); setActiveYear(''); setPage(0) } },
                  { id: 'longquote' as const, label: '深度长Quote', icon: MessageSquareQuote, count: longQuoteCount, color: '#06b6d4', action: () => { setView('longquote'); setActiveFolder(''); setActiveYear(''); setPage(0) } },
                  { id: 'unfiled' as const, label: '未整理收件箱', icon: Inbox, count: lib.unfiledCount, action: () => { setActiveYear(''); openFolderView('__none__') } },
                  { id: 'gallery' as const, label: '媒体画廊', icon: ImageIcon, action: () => { setView('gallery'); setDisplayMode('gallery'); setActiveFolder(''); setActiveYear(''); setPage(0) } },
                  { id: 'groups' as const, label: '引用归组 & 去重', icon: Layers, action: () => { setView('groups'); if (activeFolder === '__none__') setActiveFolder(''); setPage(0) } },
                  { id: 'cleanup' as const, label: '待清理队列', icon: Trash2, count: cleanupPending, warn: cleanupPending > 0, action: () => setView('cleanup') },
                ]
              })().map((item) => {
                const Icon = item.icon
                const active = view === item.id && (item.id !== 'library' || activeFolder === '')
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.action}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12.5px] leading-snug transition-colors"
                    style={{
                      background: active ? 'var(--tab-active-bg)' : 'transparent',
                      color: active ? 'var(--tab-active-fg)' : 'var(--fg)',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: item.color ?? (item.accent ? '#f59e0b' : item.warn ? 'var(--danger)' : 'var(--muted)') }} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {typeof item.count === 'number' && item.count > 0 && (
                      <span className="text-[11px] tabular-nums" style={{ color: item.warn ? 'var(--danger)' : 'var(--muted)' }}>
                        {item.count.toLocaleString()}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Accounts quick filter */}
            {accounts.length > 0 && (
              <div className="mt-2.5">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                  收藏账号
                </div>
                <div className="flex flex-wrap gap-1 px-1.5">
                  <button
                    type="button"
                    onClick={() => { setActiveAccount(''); setPage(0) }}
                    className="rounded-full border px-2 py-0 text-[10.5px] leading-5"
                    style={{
                      background: activeAccount === '' ? 'var(--accent-soft)' : 'transparent',
                      borderColor: activeAccount === '' ? 'var(--accent)' : 'var(--border)',
                      color: activeAccount === '' ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    全部
                  </button>
                  {accounts.map((a) => (
                    <button
                      key={a.account}
                      type="button"
                      onClick={() => { setActiveAccount(activeAccount === a.account ? '' : a.account); setPage(0) }}
                      className="rounded-full border px-2 py-0 text-[10.5px] leading-5"
                      style={{
                        background: activeAccount === a.account ? 'var(--accent-soft)' : 'transparent',
                        borderColor: activeAccount === a.account ? 'var(--accent)' : 'var(--border)',
                        color: activeAccount === a.account ? 'var(--accent)' : 'var(--muted)',
                      }}
                    >
                      @{a.account}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Domain Folders (drag-and-drop targets) */}
            <div className="mt-2.5">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
                领域文件夹 ({lib.folders.length})
              </div>
              <div className="space-y-0.5">
                {lib.folders.map((folder) => {
                  const active = view === 'library' && activeFolder === folder.name
                  const isOver = dropFolder === folder.name
                  return (
                    <button
                      key={folder.name}
                      type="button"
                      onDragOver={(e) => { e.preventDefault(); setDropFolder(folder.name) }}
                      onDragLeave={() => setDropFolder(null)}
                      onDrop={(e) => void onDropToFolder(folder.name, e)}
                      onClick={() => openFolderView(folder.name)}
                      className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12.5px] leading-snug transition-colors"
                      style={{
                        background: isOver ? 'var(--accent-soft)' : active ? 'var(--tab-active-bg)' : 'transparent',
                        outline: isOver ? '1px dashed var(--accent)' : 'none',
                        color: active ? 'var(--tab-active-fg)' : 'var(--fg)',
                      }}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: folderColor(folder.name) }} />
                        <span className="truncate">{folder.name}</span>
                      </span>
                      <span className="text-[11px] tabular-nums" style={{ color: 'var(--muted)' }}>
                        {folder.count.toLocaleString()}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Pinned Bottom Utility Nav — always visible without scrolling */}
          <div className="grid shrink-0 grid-cols-3 gap-1 border-t p-1.5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            {[
              { id: 'sync' as const, label: '同步', title: '同步与补全', icon: RefreshCw },
              { id: 'lab' as const, label: '实验室', title: '时间线实验室', icon: FlaskConical },
              { id: 'settings' as const, label: '设置', title: '设置与备份', icon: Settings },
            ].map((item) => {
              const Icon = item.icon
              const active = view === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  title={item.title}
                  onClick={() => setView(item.id)}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] leading-none transition-colors hover:bg-[var(--hover)]"
                  style={{
                    background: active ? 'var(--tab-active-bg)' : 'transparent',
                    color: active ? 'var(--tab-active-fg)' : 'var(--muted)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          title="左右拖动调整侧边栏宽度（双击重置）"
          onMouseDown={(e) => {
            e.preventDefault()
            startResize('sidebar', e.clientX)
          }}
          onDoubleClick={() => {
            setSidebarWidth(224)
            localStorage.setItem('xt_v2_sidebar_w', '224')
          }}
          className="group relative -mx-[3px] z-20 w-[6px] shrink-0 cursor-col-resize select-none"
        >
          <div
            className="mx-auto h-full w-[2px] transition-colors"
            style={{
              background: draggingPane === 'sidebar' ? 'var(--accent)' : 'transparent',
            }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ background: 'var(--accent)' }}
          />
        </div>
        </>
      )}

      {/* CENTER WORKSPACE */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top bar when sidebar collapsed or in Feed view */}
        <header
          className="flex shrink-0 items-center justify-between gap-2.5 border-b px-4 py-1.5"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {sidebarCollapsed && (
              <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="rounded-lg p-1.5 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
                title="展开侧边栏"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            )}
            {isFeedView ? (
              <div className="relative flex max-w-lg flex-1 items-center">
                <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`搜索 ${activeFolder && activeFolder !== '__none__' ? activeFolder : '全部书签'}（支持 from: has: tag: -排除）...`}
                  className="w-full rounded-xl border py-1.5 pl-9 pr-8 text-xs outline-none focus:border-[var(--accent)]"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                />
                {fetching && query.trim() && (
                  <Loader2 className="pointer-events-none absolute right-8 h-3.5 w-3.5 animate-spin" style={{ color: 'var(--accent)' }} />
                )}
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-2.5"
                    style={{ color: 'var(--muted)' }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <div className="text-sm font-semibold">
                {view === 'daily' ? '每日唤醒' : view === 'cleanup' ? '待清理队列' : view === 'sync' ? '同步与补全' : view === 'lab' ? '时间线实验室' : '设置与备份'}
              </div>
            )}
          </div>

          {isFeedView && (
            <div className="flex items-center gap-2">
              {lib.indexing && (
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                  索引 {lib.indexProgress ?? 0}%
                </span>
              )}
              <select
                value={sort}
                onChange={(e) => { setSort(e.target.value as SortKey); setPage(0) }}
                className="rounded-lg border px-2 py-1 text-xs outline-none"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                <option value="saved_desc">最近收藏</option>
                <option value="created_desc">最新发布</option>
                <option value="likes_desc">点赞最高</option>
                <option value="views_desc">曝光最高</option>
                <option value="saved_asc">最早收藏</option>
              </select>

              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--hover)]"
                style={{
                  borderColor: showFilters || mediaFilter || activeTag ? 'var(--accent)' : 'var(--border)',
                  color: showFilters || mediaFilter || activeTag ? 'var(--accent)' : 'var(--fg)',
                }}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <span>筛选</span>
              </button>

              {/* View Mode Switcher */}
              <div className="hidden rounded-lg border p-0.5 sm:inline-flex" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
                {([
                  { id: 'cards', icon: LayoutGrid, title: '精致卡片' },
                  { id: 'table', icon: List, title: '紧凑表格' },
                  { id: 'gallery', icon: ImageIcon, title: '媒体画廊' },
                ] as const).map((m) => {
                  const Icon = m.icon
                  return (
                    <button
                      key={m.id}
                      type="button"
                      title={m.title}
                      onClick={() => setDisplayMode(m.id)}
                      className="rounded-md p-1 transition-colors"
                      style={{
                        background: displayMode === m.id ? 'var(--tab-active-bg)' : 'transparent',
                        color: displayMode === m.id ? 'var(--tab-active-fg)' : 'var(--muted)',
                      }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  )
                })}
              </div>

              {/* Export Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowExportMenu((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>导出</span>
                </button>
                {showExportMenu && (
                  <div
                    className="absolute right-0 top-9 z-40 w-52 rounded-xl border p-1.5 shadow-xl"
                    style={{ background: 'var(--card)', borderColor: 'var(--border-strong)' }}
                  >
                    <button type="button" onClick={() => void handleExport('html')} className="flex w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--hover)]">
                      🌐 自包含离线 HTML（推荐）
                    </button>
                    <button type="button" onClick={() => void handleExport('obsidian')} className="flex w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--hover)]">
                      📝 Obsidian Markdown Zip
                    </button>
                    <button type="button" onClick={() => void handleExport('json')} className="flex w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--hover)]">
                      📦 JSON 数据文件
                    </button>
                    <button type="button" onClick={() => void handleExport('csv')} className="flex w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-[var(--hover)]">
                      📊 CSV 表格
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </header>

        {/* Filter bar */}
        {isFeedView && showFilters && (
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>内容：</span>
            {(['', 'image', 'video', 'link', 'quote'] as const).map((m) => (
              <button
                key={m || 'all'}
                type="button"
                onClick={() => { setMediaFilter(m); setPage(0) }}
                className="rounded-full border px-2.5 py-0.5"
                style={{
                  background: mediaFilter === m ? 'var(--accent-soft)' : 'transparent',
                  borderColor: mediaFilter === m ? 'var(--accent)' : 'var(--border)',
                  color: mediaFilter === m ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {m === '' ? '全部' : m === 'image' ? '含图' : m === 'video' ? '视频' : m === 'link' ? '外链' : '引用'}
              </button>
            ))}
            {lib.tags.length > 0 && (
              <>
                <span className="ml-2" style={{ color: 'var(--muted)' }}>标签：</span>
                <select
                  value={activeTag}
                  onChange={(e) => { setActiveTag(e.target.value); setPage(0) }}
                  className="rounded-lg border px-2 py-0.5 text-xs"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
                >
                  <option value="">全部标签</option>
                  {lib.tags.slice(0, 40).map((t) => (
                    <option key={t.tag} value={t.tag}>#{t.tag} ({t.count})</option>
                  ))}
                </select>
              </>
            )}
            {(activeFolder || activeAccount || activeTag || mediaFilter || query) && (
              <button
                type="button"
                onClick={() => { setActiveFolder(''); setActiveAccount(''); setActiveTag(''); setMediaFilter(''); setQuery(''); setPage(0) }}
                className="ml-auto text-xs hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                清除全部筛选
              </button>
            )}
          </div>
        )}

        {/* Toast / Running task banner */}
        {(toast || (task && task.status === 'running')) && (
          <div
            className="flex items-center justify-between border-b px-4 py-2 text-xs"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}
          >
            <span>
              {task && task.status === 'running'
                ? `后台任务 [${task.kind}] 进行中：${task.done} / ${task.total}${task.failed ? ` (失败 ${task.failed})` : ''}`
                : toast}
            </span>
            {task && task.status === 'running' && (
              <button
                type="button"
                onClick={async () => {
                  const r = await bg({ type: 'sync/cancel' })
                  notify(r.ok ? '已停止后台任务' : `停止失败：${r.error || '未知错误'}`)
                }}
                className="text-rose-400 hover:underline"
              >
                取消任务
              </button>
            )}
          </div>
        )}

        {/* MAIN SCROLLABLE CANVAS */}
        <main ref={mainScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {view === 'daily' && (
            <DailyReviewView
              notionReady={notionReady}
              onSelectPost={setSelectedPost}
              onChanged={() => void lib.reload()}
              onNotify={notify}
            />
          )}
          {view === 'cleanup' && <CleanupQueueView settings={settings} onNotify={notify} />}
          {view === 'sync' && (
            <SyncRepairView
              settings={settings}
              save={save}
              onOpenReport={() => setReportOpen(true)}
              onNotify={notify}
            />
          )}
          {view === 'lab' && <TimelineLabView />}
          {view === 'settings' && <SettingsV2View settings={settings} save={save} lib={lib} onNotify={notify} />}

          {/* QUOTE GROUPS VIEW */}
          {view === 'groups' && (
            <div className="mx-auto max-w-4xl space-y-2.5 px-5 py-3.5">
              <div className="mb-2.5">
                <h2 className="text-base font-semibold">按引用原文归组（发现重复引用 {quoteGroups.length} 组）</h2>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  不同博主引用同一条原推文的书签会自动合并在一组，方便保留最优质的一条、把其余短评归入待清理。
                </p>
              </div>
              {quoteGroups.length === 0 ? (
                <div className="v2-card p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>当前结果中未发现重复引用的书签组。</div>
              ) : (
                quoteGroups.slice(0, 60).map((g) => (
                  <div key={g.key} className="v2-card p-3">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                        原帖 @{g.info.screen_name || 'unknown'} · 被 {g.posts.length} 条书签引用
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          const extras = g.posts.slice(1)
                          await enqueuePostsForCleanup(extras, 'quote-group:extra')
                          await moveToFolder(extras.map((p) => p.tweet_id), '待清理')
                          await bumpDbVersion()
                          await lib.reload()
                          notify(`已保留 1 条，将多余的 ${extras.length} 条归入待清理`)
                        }}
                        className="rounded-lg border px-2 py-0.5 text-[11px] hover:border-[var(--danger)] hover:text-rose-400"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        保留首条，其余 {g.posts.length - 1} 条入待清理
                      </button>
                    </div>
                    <div className="space-y-1">
                      {g.posts.map((p) => (
                        <button
                          key={p.tweet_id}
                          type="button"
                          onClick={() => setSelectedPost(p)}
                          className="flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs hover:bg-[var(--hover)]"
                        >
                          <span className="truncate">
                            <strong>@{p.screen_name}</strong>：{p.text.slice(0, 100)}
                          </span>
                          <span className="ml-3 shrink-0 tabular-nums" style={{ color: 'var(--muted)' }}>
                            🔖 {p.metrics.bookmarks}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* MAIN BOOKMARK FEED (CARDS / TABLE / GALLERY) */}
          {(view === 'library' || view === 'xarticles' || view === 'longpost' || view === 'longquote' || view === 'unfiled' || view === 'gallery') && (
            <div className="px-4 py-2.5">
              {/* Year Sub-Classification Bar */}
              {yearBuckets.length > 1 && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                    <Calendar className="h-3 w-3" /> 按年份：
                  </span>
                  <button
                    type="button"
                    onClick={() => { setActiveYear(''); setPage(0) }}
                    className="rounded-full border px-2 py-0.5 transition-colors"
                    style={{
                      background: activeYear === '' ? 'var(--accent-soft)' : 'transparent',
                      borderColor: activeYear === '' ? 'var(--accent)' : 'var(--border)',
                      color: activeYear === '' ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    全部年份
                  </button>
                  {yearBuckets.map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      onClick={() => { setActiveYear(activeYear === b.key ? '' : b.key); setPage(0) }}
                      className="rounded-full border px-2 py-0.5 tabular-nums transition-colors"
                      style={{
                        background: activeYear === b.key ? 'var(--accent-soft)' : 'transparent',
                        borderColor: activeYear === b.key ? 'var(--accent)' : 'var(--border)',
                        color: activeYear === b.key ? 'var(--accent)' : 'var(--muted)',
                      }}
                    >
                      {b.label} ({b.count.toLocaleString()})
                    </button>
                  ))}
                </div>
              )}

              {/* Subheader stats + Select page + Page Size & Auto-load */}
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (checkedIds.size === posts.length && posts.length > 0) setCheckedIds(new Set())
                      else setCheckedIds(new Set(posts.map((p) => p.tweet_id)))
                    }}
                    className="inline-flex items-center gap-1 hover:text-[var(--fg)]"
                  >
                    {checkedIds.size === posts.length && posts.length > 0 ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                    <span>全选本页</span>
                  </button>
                  <span>
                    共 <strong style={{ color: 'var(--fg)' }}>{total.toLocaleString()}</strong> 条
                    {view === 'xarticles' ? ' · X文章' : view === 'longpost' ? ' · 长推文' : view === 'longquote' ? ' · 深度长Quote' : ''}
                    {activeFolder && activeFolder !== '__none__' ? ` · ${activeFolder}` : ''}
                    {activeYear ? ` · ${activeYear === 'older' ? '2023及更早' : `${activeYear}年`}` : ''}
                    {activeAccount ? ` · @${activeAccount}` : ''}
                    {activeTag ? ` · #${activeTag}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      const next = Number(e.target.value) || 50
                      setPageSize(next)
                      setPage(0)
                      localStorage.setItem('xt_v2_page_size', String(next))
                    }}
                    className="rounded-md border px-1.5 py-0.5 text-[11px]"
                    style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                    title="每页显示条数"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n} 条/页
                      </option>
                    ))}
                  </select>
                  <label className="inline-flex cursor-pointer items-center gap-1" title="滚到底部自动追加下一页（最多连续 400 条防卡顿）">
                    <input
                      type="checkbox"
                      checked={autoLoadMore}
                      onChange={(e) => {
                        setAutoLoadMore(e.target.checked)
                        localStorage.setItem('xt_v2_autoload', e.target.checked ? '1' : '0')
                      }}
                    />
                    <span>自动加载下一页</span>
                  </label>
                  <span className="hidden items-center gap-1 xl:inline-flex">
                    <kbd className="rounded border px-1" style={{ borderColor: 'var(--border)' }}>J/K</kbd>
                    <kbd className="rounded border px-1" style={{ borderColor: 'var(--border)' }}>Enter</kbd>
                    <kbd className="rounded border px-1" style={{ borderColor: 'var(--border)' }}>X</kbd>
                  </span>
                </div>
              </div>

              {fetching && posts.length === 0 ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <div key={i} className="h-36 animate-pulse rounded-2xl border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }} />
                  ))}
                </div>
              ) : posts.length === 0 ? (
                <div className="v2-card mx-auto mt-10 max-w-md p-10 text-center">
                  <div className="text-base font-semibold">暂无匹配的书签</div>
                  <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                    你可以点击左侧「同步与补全」自动抓取最新 X 书签，或在「设置 → 热库恢复与备份」导入 Phase 2 瘦身后的 22MB 精选热库。
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setView('sync')}
                      className="rounded-xl px-4 py-2 text-xs font-semibold"
                      style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
                    >
                      去同步
                    </button>
                    <button
                      type="button"
                      onClick={() => setView('settings')}
                      className="rounded-xl border px-4 py-2 text-xs"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      导入精选热库
                    </button>
                  </div>
                </div>
              ) : displayMode === 'table' ? (
                /* COMPACT TABLE MODE */
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
                        <th className="w-8 p-2.5"></th>
                        <th className="w-36 p-2.5 font-medium">作者</th>
                        <th className="p-2.5 font-medium">内容</th>
                        <th className="w-32 p-2.5 font-medium">领域</th>
                        <th className="w-20 p-2.5 text-right font-medium">收藏</th>
                        <th className="w-24 p-2.5 text-right font-medium">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {posts.map((post, idx) => {
                        const isSel = selectedPost?.tweet_id === post.tweet_id
                        return (
                          <tr
                            key={post.tweet_id}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData('text/x-tweet-id', post.tweet_id)}
                            onClick={() => { setSelectedPost(post); setFocusedIdx(idx) }}
                            className="cursor-pointer border-b transition-colors hover:bg-[var(--row-hover)]"
                            style={{
                              borderColor: 'var(--row-border)',
                              background: isSel ? 'var(--row-sel)' : undefined,
                            }}
                          >
                            <td className="p-2.5" onClick={(e) => { e.stopPropagation(); toggleCheck(post.tweet_id) }}>
                              <input type="checkbox" checked={checkedIds.has(post.tweet_id)} readOnly />
                            </td>
                            <td className="truncate p-2.5 font-medium">
                              @<HighlightText text={post.screen_name} terms={highlightTerms} />
                            </td>
                            <td className="max-w-md truncate p-2.5">
                              {post.text ? <HighlightText text={post.text} terms={highlightTerms} /> : '(无文本)'}
                            </td>
                            <td className="p-2.5">
                              {post.folder && (
                                <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                                  {post.folder}
                                </span>
                              )}
                            </td>
                            <td className="p-2.5 text-right tabular-nums" style={{ color: 'var(--muted)' }}>
                              {post.metrics.bookmarks.toLocaleString()}
                            </td>
                            <td className="p-2.5 text-right tabular-nums" style={{ color: 'var(--muted)' }}>
                              {post.created_at ? new Date(post.created_at).toISOString().slice(0, 10) : ''}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : displayMode === 'gallery' ? (
                /* MEDIA GALLERY MODE */
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {posts.map((post) => {
                    const thumb = post.media?.[0]?.url
                    return (
                      <div
                        key={post.tweet_id}
                        onClick={() => setSelectedPost(post)}
                        className="v2-card group cursor-pointer overflow-hidden"
                      >
                        <div className="aspect-[4/3] w-full overflow-hidden bg-black/30">
                          {thumb ? (
                            <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                          ) : (
                            <div className="flex h-full items-center justify-center p-4 text-xs" style={{ color: 'var(--muted)' }}>
                              {post.text.slice(0, 80)}
                            </div>
                          )}
                        </div>
                        <div className="p-3">
                          <div className="truncate text-xs font-medium">
                            @<HighlightText text={post.screen_name} terms={highlightTerms} />
                          </div>
                          <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                            <HighlightText text={post.text} terms={highlightTerms} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                /* DEFAULT: READWISE / LINEAR POLISHED CARDS */
                <div className={`grid gap-2.5 ${selectedPost ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2'}`}>
                  {posts.map((post, idx) => {
                    const isSel = selectedPost?.tweet_id === post.tweet_id
                    const isChecked = checkedIds.has(post.tweet_id)
                    const isFocused = focusedIdx === idx
                    const thumb = post.media?.[0]?.url
                    return (
                      <article
                        key={post.tweet_id}
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/x-tweet-id', post.tweet_id)}
                        onClick={() => { setSelectedPost(post); setFocusedIdx(idx) }}
                        className={`v2-card group cursor-pointer px-3.5 py-2.5 ${isSel ? 'selected' : ''}`}
                        style={{
                          boxShadow: isFocused && !isSel ? '0 0 0 1px var(--border-strong)' : undefined,
                        }}
                      >
                        <div className="mb-1.5 flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleCheck(post.tweet_id)}
                              className="mt-0.5 shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 truncate text-xs">
                                <span className="truncate font-semibold">
                                  <HighlightText text={post.name || post.screen_name} terms={highlightTerms} />
                                </span>
                                <span className="truncate" style={{ color: 'var(--muted)' }}>
                                  @<HighlightText text={post.screen_name} terms={highlightTerms} />
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                            <span>{post.created_at ? new Date(post.created_at).toISOString().slice(0, 10) : ''}</span>
                            <a
                              href={post.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="opacity-0 transition-opacity group-hover:opacity-100"
                              style={{ color: 'var(--muted)' }}
                              title="在 X 打开"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        </div>

                        <div className="flex gap-2.5">
                          <div className="min-w-0 flex-1">
                            <div className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-snug">
                              {post.text ? <HighlightText text={post.text} terms={highlightTerms} /> : <span style={{ color: 'var(--muted)' }}>(无正文)</span>}
                            </div>
                            {(() => {
                              const matchCtx = findMatchedSnippet(post, highlightTerms)
                              if (!matchCtx) return null
                              return (
                                <div
                                  className="mt-1.5 line-clamp-2 rounded-lg border px-2 py-1 text-[11px] leading-snug"
                                  style={{ background: 'rgba(250, 204, 21, 0.08)', borderColor: 'rgba(234, 179, 8, 0.35)', color: 'var(--fg)' }}
                                >
                                  <span className="mr-1.5 font-semibold" style={{ color: 'var(--accent)' }}>
                                    命中({matchCtx.source}):
                                  </span>
                                  <HighlightText text={matchCtx.snippet} terms={highlightTerms} />
                                </div>
                              )
                            })()}
                            {post.quoted?.article_title && (
                              <div className="mt-1.5 truncate rounded-lg border px-2 py-0.5 text-[11px]" style={{ background: 'var(--card-2)', borderColor: 'var(--border)', color: 'var(--accent)' }}>
                                📄 <HighlightText text={post.quoted.article_title} terms={highlightTerms} />
                              </div>
                            )}
                          </div>
                          {thumb && (
                            <img
                              src={thumb}
                              alt=""
                              loading="lazy"
                              className="h-16 w-16 shrink-0 rounded-lg border object-cover"
                              style={{ borderColor: 'var(--border)' }}
                            />
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pt-1.5 text-[11px]" style={{ borderTop: '1px solid var(--row-border)' }}>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {post.folder && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                              >
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: folderColor(post.folder) }} />
                                {post.folder}
                              </span>
                            )}
                            {(post.tags ?? []).slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                onClick={(e) => { e.stopPropagation(); setActiveTag(tag); setPage(0) }}
                                className="rounded-full px-2 py-0.5 text-[10.5px] hover:underline"
                                style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center gap-3 tabular-nums" style={{ color: 'var(--muted)' }}>
                            <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3" /> {post.metrics.likes.toLocaleString()}</span>
                            <span className="inline-flex items-center gap-1"><Bookmark className="h-3 w-3" /> {post.metrics.bookmarks.toLocaleString()}</span>
                            {post.metrics.views > 0 && (
                              <span className="hidden items-center gap-1 sm:inline-flex"><Eye className="h-3 w-3" /> {(post.metrics.views / 1000).toFixed(post.metrics.views >= 10000 ? 0 : 1)}k</span>
                            )}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}

              {/* Auto-load sentinel + Pagination */}
              {totalPages > 1 && (
                <div className="mt-5 flex flex-col items-center gap-2.5 pb-16 text-xs">
                  {autoLoadMore && (page + loadedExtraPages + 1) * PAGE_SIZE < total && (
                    <div ref={loadMoreRef} className="flex items-center justify-center py-2">
                      {posts.length >= MAX_AUTOLOAD_ITEMS ? (
                        <button
                          type="button"
                          onClick={() => {
                            const nextStart = Math.min(totalPages - 1, page + loadedExtraPages + 1)
                            setPage(nextStart)
                            mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                          }}
                          className="rounded-lg border px-3.5 py-1.5 text-xs font-medium hover:border-[var(--accent)]"
                          style={{ borderColor: 'var(--border)', background: 'var(--card)', color: 'var(--accent)' }}
                        >
                          已连续加载 {posts.length} 条 · 点击进入下一组（保持流畅）
                        </button>
                      ) : (
                        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                          {loadingMore ? '正在自动加载下一页...' : `已显示 ${posts.length} / ${total.toLocaleString()} 条，继续下滑自动加载`}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-center gap-3">
                    <button
                      type="button"
                      disabled={page <= 0}
                      onClick={() => {
                        setPage((p) => Math.max(0, p - 1))
                        mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 disabled:opacity-40"
                      style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" /> 上一页
                    </button>
                    <span className="tabular-nums" style={{ color: 'var(--muted)' }}>
                      第 {page + 1}{loadedExtraPages > 0 ? `–${page + loadedExtraPages + 1}` : ''} / {totalPages} 页
                    </span>
                    <button
                      type="button"
                      disabled={page + loadedExtraPages >= totalPages - 1}
                      onClick={() => {
                        setPage((p) => Math.min(totalPages - 1, p + loadedExtraPages + 1))
                        mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 disabled:opacity-40"
                      style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
                    >
                      下一页 <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>

        {/* FLOATING BULK ACTION BAR */}
        {checkedIds.size > 0 && (
          <div className="pointer-events-none absolute bottom-5 left-0 right-0 z-30 flex justify-center px-4">
            <div
              className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border px-4 py-2.5 text-xs shadow-2xl backdrop-blur-md"
              style={{ background: 'color-mix(in srgb, var(--card) 94%, transparent)', borderColor: 'var(--border-strong)' }}
            >
              <span className="font-semibold">已选 {checkedIds.size} 条</span>
              <span className="h-4 w-px" style={{ background: 'var(--border)' }} />
              <div className="inline-flex items-center gap-1">
                <FolderOpen className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== '') void handleBulkMove(e.target.value === '__none__' ? '' : e.target.value)
                    e.target.value = ''
                  }}
                  className="rounded-lg border px-2 py-1 text-xs"
                  style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                >
                  <option value="" disabled>移至领域...</option>
                  <option value="__none__">移出文件夹</option>
                  {lib.folders.map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const raw = window.prompt('输入要批量添加的标签（逗号分隔）：')
                  if (!raw) return
                  const tags = raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
                  if (!tags.length) return
                  await addTags([...checkedIds], tags)
                  await bumpDbVersion()
                  setCheckedIds(new Set())
                  await lib.reload()
                  notify(`已批量添加标签：${tags.join(', ')}`)
                }}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 hover:bg-[var(--hover)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <Tag className="h-3.5 w-3.5" /> 打标签
              </button>
              <button
                type="button"
                onClick={() => void handleBulkNotion()}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 hover:bg-[var(--hover)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <Send className="h-3.5 w-3.5" /> 推 Notion
              </button>
              <button
                type="button"
                onClick={async () => {
                  const r = await bg({ type: 'repair/incomplete', tweetIds: [...checkedIds] })
                  if (r.ok) {
                    setCheckedIds(new Set())
                    notify('已启动所选书签定向补全')
                  }
                }}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 hover:bg-[var(--hover)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <Wrench className="h-3.5 w-3.5" /> 补全正文/文章
              </button>
              <button
                type="button"
                onClick={() => void handleBulkCleanup()}
                className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-rose-400 hover:bg-rose-500/10"
                style={{ borderColor: 'var(--border)' }}
              >
                <Trash2 className="h-3.5 w-3.5" /> 移入待清理
              </button>
              <button
                type="button"
                onClick={() => setCheckedIds(new Set())}
                className="ml-1 rounded-lg p-1 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT SLIDE-OVER READER DRAWER (RESIZABLE) */}
      {selectedPost && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            title="左右拖动调整列表与阅读栏宽度（双击重置）"
            onMouseDown={(e) => {
              e.preventDefault()
              startResize('reader', e.clientX)
            }}
            onDoubleClick={() => {
              setReaderWidth(500)
              localStorage.setItem('xt_v2_reader_w', '500')
            }}
            className="group relative -mx-[3px] z-20 w-[6px] shrink-0 cursor-col-resize select-none"
          >
            <div
              className="mx-auto h-full w-[2px] transition-colors"
              style={{
                background: draggingPane === 'reader' ? 'var(--accent)' : 'transparent',
              }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100"
              style={{ background: 'var(--accent)' }}
            />
          </div>
          <ReaderDrawer
            post={selectedPost}
            folders={lib.folders}
            notionReady={notionReady}
            notionDatabases={settings.notionDatabases ?? []}
            defaultNotionDbId={settings.notionDatabaseId}
            highlightTerms={highlightTerms}
            width={readerWidth}
            onClose={() => setSelectedPost(null)}
            onPostUpdated={(updated) => setSelectedPost(updated)}
            onChanged={() => {
              void lib.reload()
              void loadFeed()
            }}
            onNotify={notify}
          />
        </>
      )}

      {/* CMD+K COMMAND PALETTE */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        lib={lib}
        theme={settings.theme}
        onSelectPost={(p) => {
          setSelectedPost(p)
        }}
        onSelectFolder={(f) => openFolderView(f)}
        onNavigate={(v) => setView(v as NavView)}
        onToggleTheme={toggleTheme}
        onQuickSync={() => void quickSync()}
        onExportHtml={() => void handleExport('html')}
        onSearchSubmit={(q) => {
          setView('library')
          setQuery(q)
        }}
      />

      {/* FULL SYNC REPORT MODAL */}
      <SyncReportView
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        onViewAuthor={(handle) => {
          setReportOpen(false)
          setView('library')
          setQuery(`from:${handle}`)
        }}
        syncedInRun={progress?.status === 'done' && progress.mode === 'full' ? progress.fetched : undefined}
        lastSyncAt={progress?.status === 'done' && progress.mode === 'full' ? progress.updated_at : undefined}
      />
    </div>
  )
}
