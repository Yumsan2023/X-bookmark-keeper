import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  X,
  ExternalLink,
  Copy,
  Check,
  FolderOpen,
  Tag,
  Send,
  Wrench,
  Trash2,
  Heart,
  Bookmark,
  Eye,
  MessageCircle,
  Repeat2,
  StickyNote,
  Plus,
  Loader2,
  Quote,
} from 'lucide-react'
import { needsDirectArticleRepair, needsQuotedArticleRepair } from '@/api/parser'
import { db } from '@/db/db'
import { addTags, moveToFolder, removeTags, setNote } from '@/db/posts'
import { enqueuePostsForCleanup } from '@/db/cleanup'
import { postToMarkdown } from '@/export/markdown'
import { bumpDbVersion } from '@/shared/storage'
import type { Folder, NotionDatabaseEntry, Post } from '@/shared/types'
import { bg } from '../hooks'
import { HighlightText, renderHighlightedText } from './HighlightText'

const QUICK_FORM_TAGS = ['干货教程', '开源工具', '深度长文', '观点灵感', '资料清单', '视觉素材', 'tier:S-核心精华']
const MD_IMG_RE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/
const INLINE_URL_RE = /(https?:\/\/[^\s)<>]+)/g

function linkifyText(line: string, keyPrefix: string, highlightTerms?: string[]): ReactNode[] {
  const parts = line.split(INLINE_URL_RE)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={`${keyPrefix}-${i}`}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="break-all underline decoration-current/40 hover:decoration-current"
      >
        {renderHighlightedText(part, highlightTerms, `${keyPrefix}-u-${i}`)}
      </a>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{renderHighlightedText(part, highlightTerms, `${keyPrefix}-t-${i}`)}</span>
    ),
  )
}

/** 渲染含内嵌图片 ![alt](url)、标题、引用、列表、代码块、可点击链接和搜索关键词高亮的文章与推文正文 */
function RichArticleBody({
  text,
  compact = false,
  highlightTerms,
  onImageClick,
}: {
  text: string
  compact?: boolean
  highlightTerms?: string[]
  onImageClick: (url: string) => void
}) {
  const nodes = useMemo(() => {
    const raw = String(text || '')
    if (!raw.trim()) return null
    const lines = raw.split('\n')
    const out: ReactNode[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()

      // Code block ```...```
      if (trimmed.startsWith('```')) {
        const codeLines: string[] = []
        i++
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i])
          i++
        }
        i++
        out.push(
          <pre
            key={`code-${i}`}
            className="my-2 overflow-x-auto rounded-lg border p-2.5 font-mono text-xs leading-relaxed"
            style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
          >
            <code>{renderHighlightedText(codeLines.join('\n'), highlightTerms, `code-${i}`)}</code>
          </pre>,
        )
        continue
      }

      // Embedded markdown image ![alt](https://...)
      const imgMatch = MD_IMG_RE.exec(trimmed)
      if (imgMatch) {
        const alt = imgMatch[1]
        const url = imgMatch[2]
        out.push(
          <figure key={`img-${i}`} className="my-2.5 overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
            <img
              src={url}
              alt={alt}
              loading="lazy"
              onClick={() => onImageClick(url)}
              className="max-h-96 w-full cursor-zoom-in object-contain bg-black/5 transition-transform hover:scale-[1.01]"
            />
            {alt && alt !== '封面图' && (
              <figcaption className="px-2.5 py-1 text-center text-[11px]" style={{ color: 'var(--muted)' }}>
                {alt}
              </figcaption>
            )}
          </figure>,
        )
        i++
        continue
      }

      if (!trimmed) {
        i++
        continue
      }

      if (trimmed.startsWith('### ')) {
        out.push(
          <h4 key={`h3-${i}`} className="mt-3 mb-1 text-[14px] font-semibold">
            {renderHighlightedText(trimmed.slice(4), highlightTerms, `h3-${i}`)}
          </h4>,
        )
      } else if (trimmed.startsWith('## ')) {
        out.push(
          <h3 key={`h2-${i}`} className="mt-3.5 mb-1.5 text-[15px] font-semibold">
            {renderHighlightedText(trimmed.slice(3), highlightTerms, `h2-${i}`)}
          </h3>,
        )
      } else if (trimmed.startsWith('# ')) {
        out.push(
          <h2 key={`h1-${i}`} className="mt-3.5 mb-1.5 text-base font-bold">
            {renderHighlightedText(trimmed.slice(2), highlightTerms, `h1-${i}`)}
          </h2>,
        )
      } else if (trimmed.startsWith('> ')) {
        out.push(
          <blockquote
            key={`q-${i}`}
            className="my-2 border-l-2 pl-3 italic"
            style={{ borderColor: 'var(--accent)', color: 'var(--muted)' }}
          >
            {linkifyText(trimmed.slice(2), `q-${i}`, highlightTerms)}
          </blockquote>,
        )
      } else if (/^[-•]\s+/.test(trimmed)) {
        out.push(
          <div key={`ul-${i}`} className="my-0.5 flex gap-2 pl-1">
            <span style={{ color: 'var(--accent)' }}>•</span>
            <span className="min-w-0 flex-1 break-words">{linkifyText(trimmed.replace(/^[-•]\s+/, ''), `ul-${i}`, highlightTerms)}</span>
          </div>,
        )
      } else if (/^\d+\.\s+/.test(trimmed)) {
        const m = /^(\d+\.)\s+(.*)$/.exec(trimmed)
        out.push(
          <div key={`ol-${i}`} className="my-0.5 flex gap-2 pl-1">
            <span className="shrink-0 font-medium tabular-nums" style={{ color: 'var(--accent)' }}>
              {m?.[1]}
            </span>
            <span className="min-w-0 flex-1 break-words">{linkifyText(m?.[2] ?? trimmed, `ol-${i}`, highlightTerms)}</span>
          </div>,
        )
      } else {
        out.push(
          <p key={`p-${i}`} className="my-1.5 whitespace-pre-wrap break-words">
            {linkifyText(line, `p-${i}`, highlightTerms)}
          </p>,
        )
      }
      i++
    }
    return out
  }, [text, highlightTerms, onImageClick])

  if (!nodes) return <span style={{ color: 'var(--muted)' }}>(无正文文本)</span>
  return (
    <div className={compact ? 'text-[13px] leading-relaxed' : 'text-[14.5px] leading-relaxed'} style={{ color: 'var(--fg)' }}>
      {nodes}
    </div>
  )
}

function collectInlineImageUrls(text: string | undefined): Set<string> {
  const urls = new Set<string>()
  if (!text) return urls
  for (const line of text.split('\n')) {
    const m = MD_IMG_RE.exec(line.trim())
    if (m) urls.add(m[2])
  }
  return urls
}

export interface ReaderDrawerProps {
  post: Post | null
  folders: (Folder & { count: number })[]
  notionReady: boolean
  notionDatabases?: NotionDatabaseEntry[]
  defaultNotionDbId?: string
  highlightTerms?: string[]
  width?: number
  onClose: () => void
  onPostUpdated?: (post: Post) => void
  onChanged: () => void
  onNotify: (msg: string) => void
}

export function ReaderDrawer({
  post,
  folders,
  notionReady,
  notionDatabases = [],
  defaultNotionDbId = '',
  highlightTerms = [],
  width,
  onClose,
  onPostUpdated,
  onChanged,
  onNotify,
}: ReaderDrawerProps) {
  const [noteDraft, setNoteDraft] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Antigravity-style highlight-to-quote + annotation + multi-DB Notion sync
  const [selectionPill, setSelectionPill] = useState<{ text: string; top: number; left: number } | null>(null)
  const [quoteModalOpen, setQuoteModalOpen] = useState(false)
  const [quoteDraft, setQuoteDraft] = useState('')
  const [annotationDraft, setAnnotationDraft] = useState('')
  const [includeFullPost, setIncludeFullPost] = useState(true)
  const [saveLocalNote, setSaveLocalNote] = useState(true)
  const [targetDbId, setTargetDbId] = useState<string>(() => localStorage.getItem('xt_v2_last_notion_db') || defaultNotionDbId)
  const [lastNotionUrl, setLastNotionUrl] = useState<string>('')

  const availableDbs = useMemo<NotionDatabaseEntry[]>(() => {
    const map = new Map<string, NotionDatabaseEntry>()
    for (const d of notionDatabases) {
      if (d?.id) map.set(d.id, d)
    }
    if (defaultNotionDbId && !map.has(defaultNotionDbId)) {
      map.set(defaultNotionDbId, { id: defaultNotionDbId, name: `默认数据库 (${defaultNotionDbId.slice(0, 8)})` })
    }
    return [...map.values()]
  }, [notionDatabases, defaultNotionDbId])

  useEffect(() => {
    if (!targetDbId && availableDbs.length > 0) {
      setTargetDbId(defaultNotionDbId || availableDbs[0].id)
    }
  }, [targetDbId, availableDbs, defaultNotionDbId])

  useEffect(() => {
    setNoteDraft(post?.note ?? '')
    setTagInput('')
    setLightboxUrl(null)
    setSelectionPill(null)
    setQuoteModalOpen(false)
    setLastNotionUrl('')
  }, [post?.tweet_id])

  // 灯箱或引用弹窗打开时优先截获 Esc 仅关闭当前浮层，避免误关底下的阅读抽屉并丢失草稿
  useEffect(() => {
    if (!lightboxUrl && !quoteModalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (lightboxUrl) setLightboxUrl(null)
      else if (quoteModalOpen) setQuoteModalOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lightboxUrl, quoteModalOpen])

  if (!post) return null

  const openQuoteComposer = (selectedSnippet?: string) => {
    const fullFallback = [
      post.article_title ? `【${post.article_title}】` : '',
      post.text,
      post.quoted?.article_text ? `\n---\n引用文章：${post.quoted.article_title || ''}\n${post.quoted.article_text}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim()
    setQuoteDraft(selectedSnippet?.trim() || fullFallback.slice(0, 1500))
    setAnnotationDraft('')
    setIncludeFullPost(true)
    setSaveLocalNote(true)
    setSelectionPill(null)
    setLastNotionUrl('')
    setQuoteModalOpen(true)
  }

  const handleTextMouseUp = () => {
    const sel = window.getSelection()
    const raw = sel?.toString().trim() ?? ''
    if (!raw || raw.length < 4 || !sel || sel.rangeCount === 0) {
      setSelectionPill(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelectionPill(null)
      return
    }
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
    setSelectionPill({
      text: raw,
      top: Math.max(52, rect.top / zoom - 36),
      left: Math.min(window.innerWidth / zoom - 180, Math.max(12, rect.left / zoom + rect.width / zoom / 2 - 75)),
    })
  }

  const handleSyncQuoteToNotion = async () => {
    const dbId = targetDbId || defaultNotionDbId
    if (!notionReady || !dbId) {
      onNotify('请先在「设置 → Notion 集成」填写 Token 并拉取/添加目标数据库')
      return
    }
    setBusy(true)
    try {
      const origin = 'https://api.notion.com/*'
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        const granted = await chrome.permissions.request({ origins: [origin] })
        if (!granted) {
          onNotify('未授予 api.notion.com 访问权限，已取消同步')
          return
        }
      }
      localStorage.setItem('xt_v2_last_notion_db', dbId)
      const res = await bg<{ pageId: string; url?: string; post?: Post }>({
        type: 'notion/pushQuote',
        tweetId: post.tweet_id,
        databaseId: dbId,
        quoteText: quoteDraft,
        annotation: annotationDraft,
        includeFullPost,
        saveLocalNote,
      })
      if (res.ok && res.data) {
        if (res.data.post) {
          setNoteDraft(res.data.post.note ?? '')
          onPostUpdated?.(res.data.post)
        }
        if (res.data.url) setLastNotionUrl(res.data.url)
        onChanged()
        onNotify('已将引用片段与批注同步到 Notion！')
      } else {
        onNotify(`同步失败：${res.error || '未知错误'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSaveQuoteLocallyOnly = async () => {
    const stamp = new Date().toISOString().slice(0, 10)
    const snippet = [
      `[${stamp}]`,
      quoteDraft.trim() ? `> ${quoteDraft.trim().slice(0, 300)}` : '',
      annotationDraft.trim(),
    ]
      .filter(Boolean)
      .join('\n')
    const nextNote = post.note?.trim() ? `${post.note.trim()}\n\n${snippet}` : snippet
    await setNote(post.tweet_id, nextNote)
    await bumpDbVersion()
    setNoteDraft(nextNote)
    onPostUpdated?.({ ...post, note: nextNote })
    onChanged()
    setQuoteModalOpen(false)
    onNotify('已将引用与批注保存到本地笔记')
  }

  const saveNote = async () => {
    if (noteDraft === (post.note ?? '')) return
    await setNote(post.tweet_id, noteDraft)
    await bumpDbVersion()
    onChanged()
    onNotify('笔记已保存')
  }

  const handleFolder = async (folderName: string) => {
    await moveToFolder([post.tweet_id], folderName)
    await bumpDbVersion()
    onChanged()
    onNotify(folderName ? `已移入「${folderName}」` : '已移出文件夹')
  }

  const handleAddTag = async (raw: string) => {
    const clean = raw.trim()
    if (!clean) return
    await addTags([post.tweet_id], [clean])
    await bumpDbVersion()
    setTagInput('')
    onChanged()
  }

  const handleRemoveTag = async (tag: string) => {
    await removeTags([post.tweet_id], [tag])
    await bumpDbVersion()
    onChanged()
  }

  const handleCopyMd = async () => {
    await navigator.clipboard.writeText(postToMarkdown(post, { frontmatter: true }))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
    onNotify('已复制带 Frontmatter 的 Markdown')
  }

  const handlePushNotion = async () => {
    if (!notionReady) {
      onNotify('请先在「设置 → Notion 集成」填写 Token 与 Database ID')
      return
    }
    setBusy(true)
    try {
      const origin = 'https://api.notion.com/*'
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        const granted = await chrome.permissions.request({ origins: [origin] })
        if (!granted) {
          onNotify('未授予 api.notion.com 访问权限，已取消推送')
          return
        }
      }
      const res = await bg({ type: 'notion/push', tweetIds: [post.tweet_id] })
      onNotify(res.ok ? '已加入 Notion 推送队列' : `推送失败：${res.error}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRepair = async () => {
    setBusy(true)
    try {
      const res = await bg<{
        updated: boolean
        message: string
        post?: Post
      }>({ type: 'repair/single', tweetId: post.tweet_id })
      if (res.ok && res.data) {
        if (res.data.post) onPostUpdated?.(res.data.post)
        onChanged()
        onNotify(res.data.message)
      } else {
        onNotify(`补全失败：${res.error || '未知错误'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleClearThread = async () => {
    await db.posts.update(post.tweet_id, { thread: [], thread_fetched_at: undefined })
    await bumpDbVersion()
    onChanged()
    onNotify('已清除该条目的串推记录')
  }

  const handleSendCleanup = async () => {
    await enqueuePostsForCleanup([post], 'manual:drawer')
    await moveToFolder([post.tweet_id], '待清理')
    await bumpDbVersion()
    onChanged()
    onNotify('已归入「待清理」并加入 X 端安全清理队列（未删除原书签）')
  }

  const createdStr = post.created_at ? new Date(post.created_at).toLocaleString() : ''

  return (
    <>
      <aside
        className="flex h-full shrink-0 flex-col border-l"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          width: `${width ?? 500}px`,
        }}
      >
        {/* Drawer Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3.5 py-2" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-1.5">
            <a
              href={post.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium no-underline transition-colors hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              title="在 X 打开原文"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>原文</span>
            </a>
            <button
              type="button"
              onClick={() => void handleCopyMd()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>MD</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => openQuoteComposer()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-[var(--accent)] hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              title="引用整篇内容并写批注，自选 Notion 数据库一键同步（也可直接划词引用片段）"
            >
              <Quote className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
              <span>引用→Notion</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRepair()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover)] disabled:opacity-60"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              title="抓取完整正文 / X 文章全文与配图（含引用文章全文）/ 还原短链"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              <span>{busy ? '抓取中...' : '补全全文'}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSendCleanup()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-rose-500/10"
              style={{ borderColor: 'var(--border)', color: 'var(--danger)' }}
              title="归入待清理队列（不立即删 X 书签）"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover)]"
            style={{ color: 'var(--muted)' }}
            aria-label="关闭阅读抽屉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Reader Body — supports Antigravity-style text selection Quote */}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5"
          onMouseUp={handleTextMouseUp}
          onScroll={() => selectionPill && setSelectionPill(null)}
        >
          {/* Active search keyword highlight pill */}
          {highlightTerms.length > 0 && (
            <div
              className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px]"
              style={{ background: 'rgba(250, 204, 21, 0.1)', borderColor: 'rgba(234, 179, 8, 0.35)' }}
            >
              <span style={{ color: 'var(--muted)' }}>已高亮搜索词：</span>
              {highlightTerms.map((term) => (
                <mark
                  key={term}
                  className="rounded px-1.5 py-0.5 font-medium"
                  style={{ background: 'rgba(250, 204, 21, 0.38)', color: 'inherit' }}
                >
                  {term}
                </mark>
              ))}
            </div>
          )}

          {/* Author block */}
          <div className="mb-4 flex items-center gap-3">
            {post.avatar ? (
              <img src={post.avatar} alt="" className="h-10 w-10 rounded-full border object-cover" style={{ borderColor: 'var(--border)' }} />
            ) : (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {(post.name || post.screen_name || '?')[0]?.toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">
                <HighlightText text={post.name || post.screen_name} terms={highlightTerms} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                <span>@<HighlightText text={post.screen_name} terms={highlightTerms} /></span>
                <span>·</span>
                <span>{createdStr}</span>
              </div>
            </div>
          </div>

          {/* Account badges */}
          {(post.accounts?.length ?? 0) > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {post.accounts!.map((a) => (
                <span
                  key={a}
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}
                >
                  收藏自 @{a}
                </span>
              ))}
            </div>
          )}

          {/* Direct X Article incomplete banner */}
          {needsDirectArticleRepair(post) && (
            <div
              className="mb-3 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
              style={{ background: 'var(--accent-soft)', borderColor: 'var(--border)' }}
            >
              <span>检测到这是一篇仅含摘要的 X 文章，可一键拉取全文与配图</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRepair()}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium disabled:opacity-60"
                style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                <span>{busy ? '抓取中...' : '抓取文章全文'}</span>
              </button>
            </div>
          )}

          {/* Main Text (with inline markdown images, headings, blockquotes, lists & clickable links) */}
          <article>
            <RichArticleBody text={post.text} highlightTerms={highlightTerms} onImageClick={setLightboxUrl} />
          </article>

          {/* Thread items */}
          {post.thread && post.thread.length > 0 && (
            <div className="mt-5 space-y-2.5 border-l-2 pl-4" style={{ borderColor: 'var(--accent)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
                  Thread 串推 ({post.thread.length + 1} 条)
                </div>
                <button
                  type="button"
                  onClick={() => void handleClearThread()}
                  className="rounded-md border px-2 py-0.5 text-[11px] hover:border-[var(--danger)] hover:text-rose-400"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                  title="仅清除附加的串推列表，保留主推文"
                >
                  清除串推
                </button>
              </div>
              {post.thread.map((item, idx) => (
                <div key={item.tweet_id} className="rounded-xl border p-3 text-sm leading-relaxed" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
                  <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
                    {idx + 2} / {post.thread!.length + 1}
                  </div>
                  <div className="whitespace-pre-wrap break-words">
                    <HighlightText text={item.text} terms={highlightTerms} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Media grid (dedupe images already rendered inline in RichArticleBody) */}
          {(() => {
            const inlineUrls = collectInlineImageUrls(post.text)
            const extraMedia = (post.media ?? []).filter((m) => m.type !== 'photo' || !inlineUrls.has(m.url))
            if (!extraMedia.length) return null
            return (
              <div className={`mt-4 grid gap-2 ${extraMedia.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {extraMedia.map((m, idx) => (
                  <div key={idx} className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                    {m.type === 'photo' ? (
                      <img
                        src={m.url}
                        alt={m.alt || ''}
                        loading="lazy"
                        onClick={() => setLightboxUrl(m.url)}
                        className="max-h-72 w-full cursor-zoom-in object-cover transition-transform hover:scale-[1.01]"
                      />
                    ) : (
                      <a
                        href={m.video_url || m.url}
                        target="_blank"
                        rel="noreferrer"
                        className="relative block"
                      >
                        <img src={m.url} alt="" className="max-h-64 w-full object-cover opacity-85" />
                        <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-0.5 text-[11px] text-white">
                          ▶ {m.type === 'animated_gif' ? 'GIF' : '视频'}
                        </span>
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

          {/* Quoted Tweet / X Article */}
          {post.quoted && (
            <div className="mt-4 rounded-xl border p-3.5" style={{ background: 'var(--card-2)', borderColor: 'var(--border)' }}>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="font-semibold">
                  <HighlightText text={post.quoted.name || ''} terms={highlightTerms} />{' '}
                  <span className="font-normal" style={{ color: 'var(--muted)' }}>
                    @<HighlightText text={post.quoted.screen_name || ''} terms={highlightTerms} />
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {post.quoted.article_text && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-500">
                      已含文章全文 · {post.quoted.article_text.length.toLocaleString()} 字
                    </span>
                  )}
                  {(needsQuotedArticleRepair(post.quoted) ||
                    (post.quoted.article_text && !(post.quoted.media?.length || collectInlineImageUrls(post.quoted.article_text).size))) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRepair()}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium hover:border-[var(--accent)] disabled:opacity-60"
                      style={{ borderColor: 'var(--border)', color: 'var(--accent)', background: 'var(--card)' }}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                      <span>{post.quoted.article_text ? '补全配图' : '抓取引用文章全文'}</span>
                    </button>
                  )}
                </div>
              </div>
              {post.quoted.article_title && (
                <div className="mb-1.5 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                  📄 <HighlightText text={post.quoted.article_title} terms={highlightTerms} />
                </div>
              )}
              {post.quoted.article_text ? (
                <div className="mt-2 border-t pt-2.5" style={{ borderColor: 'var(--border)' }}>
                  <RichArticleBody text={post.quoted.article_text} compact highlightTerms={highlightTerms} onImageClick={setLightboxUrl} />
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>
                  <RichArticleBody text={post.quoted.text || post.quoted.article_preview || ''} compact highlightTerms={highlightTerms} onImageClick={setLightboxUrl} />
                </div>
              )}
              {(() => {
                const qInline = collectInlineImageUrls(post.quoted?.article_text || post.quoted?.text)
                const qExtraMedia = (post.quoted?.media ?? []).filter((m) => m.type !== 'photo' || !qInline.has(m.url))
                if (!qExtraMedia.length) return null
                return (
                  <div className={`mt-2.5 grid gap-2 ${qExtraMedia.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    {qExtraMedia.map((m, idx) => (
                      <div key={idx} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                        {m.type === 'photo' ? (
                          <img
                            src={m.url}
                            alt={m.alt || ''}
                            loading="lazy"
                            onClick={() => setLightboxUrl(m.url)}
                            className="max-h-60 w-full cursor-zoom-in object-cover"
                          />
                        ) : (
                          <a href={m.video_url || m.url} target="_blank" rel="noreferrer" className="relative block">
                            <img src={m.url} alt="" className="max-h-56 w-full object-cover opacity-85" />
                            <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-0.5 text-[11px] text-white">
                              ▶ {m.type === 'animated_gif' ? 'GIF' : '视频'}
                            </span>
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Engagement stats */}
          <div
            className="mt-5 flex flex-wrap items-center gap-4 border-y py-3 text-xs tabular-nums"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            <span className="inline-flex items-center gap-1"><Heart className="h-3.5 w-3.5" /> {post.metrics.likes.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1"><Bookmark className="h-3.5 w-3.5" /> {post.metrics.bookmarks.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1"><Repeat2 className="h-3.5 w-3.5" /> {post.metrics.retweets.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> {post.metrics.replies.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> {post.metrics.views.toLocaleString()}</span>
          </div>

          {/* Organization: Folder + Tags + Note */}
          <div className="mt-5 space-y-4">
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--muted)' }}>
                <FolderOpen className="h-3.5 w-3.5" />
                <span>领域文件夹</span>
              </label>
              <select
                value={post.folder || ''}
                onChange={(e) => void handleFolder(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                <option value="">未归类（收件箱）</option>
                {folders.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name} ({f.count})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--muted)' }}>
                <Tag className="h-3.5 w-3.5" />
                <span>标签与形态</span>
              </label>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(post.tags ?? []).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    <span>#{tag}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveTag(tag)}
                      className="ml-0.5 opacity-70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleAddTag(tagInput)
                    }
                  }}
                  placeholder="输入新标签回车添加..."
                  className="flex-1 rounded-lg border px-2.5 py-1.5 text-xs outline-none"
                  style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                />
                <button
                  type="button"
                  onClick={() => void handleAddTag(tagInput)}
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加</span>
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {QUICK_FORM_TAGS.filter((t) => !(post.tags ?? []).includes(t)).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => void handleAddTag(t)}
                    className="rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:border-[var(--accent)]"
                    style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                  >
                    + {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--muted)' }}>
                <StickyNote className="h-3.5 w-3.5" />
                <span>个人阅读笔记（失焦自动保存）</span>
              </label>
              <textarea
                rows={4}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={() => void saveNote()}
                placeholder="记下你的思考、行动项或摘录..."
                className="w-full resize-y rounded-xl border p-3 text-sm leading-relaxed outline-none focus:border-[var(--accent)]"
                style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--fg)' }}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* Antigravity-style Floating Selection Quote Pill */}
      {selectionPill && !quoteModalOpen && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            openQuoteComposer(selectionPill.text)
          }}
          className="fixed z-[90] inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-xl transition-transform hover:scale-105"
          style={{
            top: `${selectionPill.top}px`,
            left: `${selectionPill.left}px`,
            background: 'var(--primary-btn-bg)',
            color: 'var(--primary-btn-fg)',
            borderColor: 'var(--border-strong)',
          }}
        >
          <Quote className="h-3.5 w-3.5" />
          <span>引用并批注 → Notion</span>
        </button>
      )}

      {/* Antigravity-style Quote & Annotate -> Notion Modal */}
      {quoteModalOpen && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
          onClick={() => setQuoteModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border p-4 shadow-2xl"
            style={{ background: 'var(--card)', borderColor: 'var(--border-strong)', color: 'var(--fg)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Quote className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                <span>引用批注并同步到 Notion</span>
              </div>
              <button
                type="button"
                onClick={() => setQuoteModalOpen(false)}
                className="rounded-lg p-1 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between" style={{ color: 'var(--muted)' }}>
                  <span>引用的原文片段（可微调）</span>
                  <button
                    type="button"
                    onClick={() =>
                      setQuoteDraft(
                        [
                          post.article_title ? `【${post.article_title}】` : '',
                          post.text,
                          post.quoted?.article_text ? `\n---\n${post.quoted.article_title || ''}\n${post.quoted.article_text}` : '',
                        ]
                          .filter(Boolean)
                          .join('\n')
                          .trim()
                          .slice(0, 1800),
                      )
                    }
                    className="hover:underline"
                    style={{ color: 'var(--accent)' }}
                  >
                    改为引用整篇
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={quoteDraft}
                  onChange={(e) => setQuoteDraft(e.target.value)}
                  className="w-full resize-y rounded-xl border-l-4 border p-2.5 text-xs leading-relaxed outline-none"
                  style={{
                    background: 'var(--card-2)',
                    borderColor: 'var(--border)',
                    borderLeftColor: 'var(--accent)',
                    color: 'var(--fg)',
                  }}
                />
              </div>

              <div>
                <label className="mb-1 block font-medium" style={{ color: 'var(--muted)' }}>
                  你的批注 / 思考 / 行动项
                </label>
                <textarea
                  rows={3}
                  autoFocus
                  value={annotationDraft}
                  onChange={(e) => setAnnotationDraft(e.target.value)}
                  placeholder="写下你的批注、启发或待办..."
                  className="w-full resize-y rounded-xl border p-2.5 text-xs leading-relaxed outline-none focus:border-[var(--accent)]"
                  style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                />
              </div>

              <div>
                <label className="mb-1 block font-medium" style={{ color: 'var(--muted)' }}>
                  目标 Notion 数据库
                </label>
                {availableDbs.length > 0 ? (
                  <select
                    value={targetDbId}
                    onChange={(e) => setTargetDbId(e.target.value)}
                    className="w-full rounded-lg border px-2.5 py-1.5 text-xs"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                  >
                    {availableDbs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="rounded-lg border px-2.5 py-2 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--warn)' }}>
                    尚未配置 Notion 数据库：请先去左侧底部「设置 → Notion 集成」填入 Token 并一键拉取你的数据库列表。
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4" style={{ color: 'var(--muted)' }}>
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={includeFullPost} onChange={(e) => setIncludeFullPost(e.target.checked)} />
                  <span>附加完整原文（Notion 折叠块）</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={saveLocalNote} onChange={(e) => setSaveLocalNote(e.target.checked)} />
                  <span>同时追加到本地笔记</span>
                </label>
              </div>

              {lastNotionUrl && (
                <div className="rounded-lg border px-3 py-2 text-xs text-emerald-500" style={{ background: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.3)' }}>
                  ✅ 已成功同步到 Notion！{' '}
                  <a href={lastNotionUrl} target="_blank" rel="noreferrer" className="font-semibold underline">
                    在 Notion 中打开 ↗
                  </a>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleSaveQuoteLocallyOnly()}
                  className="rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--hover)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  仅存本地笔记
                </button>
                <button
                  type="button"
                  disabled={busy || !availableDbs.length}
                  onClick={() => void handleSyncQuoteToNotion()}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  <span>{busy ? '同步中...' : '一键同步到 Notion'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Media Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
          onClick={() => setLightboxUrl(null)}
        >
          <img src={lightboxUrl} alt="" className="max-h-[90vh] max-w-[90vw] rounded-xl shadow-2xl" />
        </div>
      )}
    </>
  )
}
