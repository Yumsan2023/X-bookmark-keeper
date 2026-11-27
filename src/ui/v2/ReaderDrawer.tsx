import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import { addTags, moveToFolder, removeTags, setNote } from '@/db/posts'
import { enqueuePostsForCleanup } from '@/db/cleanup'
import { postToMarkdown } from '@/export/markdown'
import { bumpDbVersion } from '@/shared/storage'
import type { Folder, Post } from '@/shared/types'
import { bg } from '../hooks'

const QUICK_FORM_TAGS = ['干货教程', '开源工具', '深度长文', '观点灵感', '资料清单', '视觉素材', 'tier:S-核心精华']

export interface ReaderDrawerProps {
  post: Post | null
  folders: (Folder & { count: number })[]
  notionReady: boolean
  onClose: () => void
  onChanged: () => void
  onNotify: (msg: string) => void
}

export function ReaderDrawer({ post, folders, notionReady, onClose, onChanged, onNotify }: ReaderDrawerProps) {
  const [noteDraft, setNoteDraft] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setNoteDraft(post?.note ?? '')
    setTagInput('')
    setLightboxUrl(null)
  }, [post?.tweet_id])

  if (!post) return null

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
      const res = await bg({ type: 'repair/incomplete', tweetIds: [post.tweet_id] })
      onNotify(res.ok ? '已启动定向补抓（完整正文 / Thread / 短链还原）' : `补抓失败：${res.error}`)
    } finally {
      setBusy(false)
    }
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
        className="flex h-full w-[460px] shrink-0 flex-col border-l xl:w-[520px]"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
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
              onClick={() => void handlePushNotion()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              title="一键推送到 Notion 数据库"
            >
              <Send className="h-3.5 w-3.5" />
              <span>Notion</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRepair()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              title="补抓完整 Thread / 截断长文 / 还原 t.co"
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>补全</span>
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

        {/* Scrollable Reader Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
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
              <div className="truncate font-semibold">{post.name || post.screen_name}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                <span>@{post.screen_name}</span>
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

          {/* Main Text */}
          <article className="whitespace-pre-wrap break-words text-[15px] leading-relaxed" style={{ color: 'var(--fg)' }}>
            {post.text || <span style={{ color: 'var(--muted)' }}>(无正文文本)</span>}
          </article>

          {/* Thread items */}
          {post.thread && post.thread.length > 0 && (
            <div className="mt-5 space-y-3 border-l-2 pl-4" style={{ borderColor: 'var(--accent)' }}>
              <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
                Thread 串推 ({post.thread.length + 1} 条)
              </div>
              {post.thread.map((item, idx) => (
                <div key={item.tweet_id} className="rounded-xl border p-3 text-sm leading-relaxed" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
                  <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--muted)' }}>
                    {idx + 2} / {post.thread!.length + 1}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{item.text}</div>
                </div>
              ))}
            </div>
          )}

          {/* Media grid */}
          {post.media && post.media.length > 0 && (
            <div className={`mt-4 grid gap-2 ${post.media.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {post.media.map((m, idx) => (
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
          )}

          {/* Quoted Tweet / X Article */}
          {post.quoted && (
            <div className="mt-4 rounded-xl border p-3.5" style={{ background: 'var(--card-2)', borderColor: 'var(--border)' }}>
              <div className="mb-1 text-xs font-semibold">
                {post.quoted.name}{' '}
                <span className="font-normal" style={{ color: 'var(--muted)' }}>
                  @{post.quoted.screen_name}
                </span>
              </div>
              {post.quoted.article_title && (
                <div className="mb-1.5 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
                  📄 {post.quoted.article_title}
                </div>
              )}
              <div className="whitespace-pre-wrap break-words text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>
                {post.quoted.text || post.quoted.article_preview}
              </div>
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
