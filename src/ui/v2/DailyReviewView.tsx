import { useEffect, useState } from 'react'
import { Sparkles, RefreshCw, CheckCircle2, ExternalLink, Trash2, Send, BookOpen } from 'lucide-react'
import { enqueuePostsForCleanup } from '@/db/cleanup'
import { moveToFolder } from '@/db/posts'
import { bumpDbVersion } from '@/shared/storage'
import type { Post } from '@/shared/types'
import { loadOrCreateDailyReview, markDailyReviewed, type DailyReviewState } from '../daily-review'
import { bg } from '../hooks'

export function DailyReviewView({
  notionReady,
  onSelectPost,
  onChanged,
  onNotify,
}: {
  notionReady: boolean
  onSelectPost: (post: Post) => void
  onChanged: () => void
  onNotify: (msg: string) => void
}) {
  const [state, setState] = useState<DailyReviewState | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)

  const load = async (force = false) => {
    setLoading(true)
    try {
      const res = await loadOrCreateDailyReview(force, 5)
      setState(res.state)
      setPosts(res.posts)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(false)
  }, [])

  const reviewedSet = new Set(state?.reviewedIds ?? [])
  const doneCount = posts.filter((p) => reviewedSet.has(p.tweet_id)).length

  const markDone = async (id: string) => {
    const next = await markDailyReviewed(id)
    setState(next)
  }

  const sendCleanup = async (post: Post) => {
    await enqueuePostsForCleanup([post], 'daily-review')
    await moveToFolder([post.tweet_id], '待清理')
    await bumpDbVersion()
    await markDone(post.tweet_id)
    onChanged()
    onNotify('已归入「待清理」队列')
  }

  const pushNotion = async (post: Post) => {
    if (!notionReady) {
      onNotify('请先在设置页配置 Notion Token 与 Database ID')
      return
    }
    const res = await bg({ type: 'notion/push', tweetIds: [post.tweet_id] })
    if (res.ok) {
      await markDone(post.tweet_id)
      onNotify('已加入 Notion 推送队列')
    } else {
      onNotify(`推送失败：${res.error}`)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-3.5">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Sparkles className="h-4 w-4 text-amber-400" />
            <span>每日旧书签唤醒 · Daily Review</span>
          </h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            优先抽取「历史今日」与 S/A 级核心精华，打破收藏即吃灰。今日进度：{doneCount} / {posts.length}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover)]"
          style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>换一批精选</span>
        </button>
      </div>

      {/* Progress bar */}
      <div className="mb-3.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${posts.length ? (doneCount / posts.length) * 100 : 0}%` }}
        />
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-32 animate-pulse rounded-xl border" style={{ background: 'var(--card)', borderColor: 'var(--border)' }} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <div className="rounded-xl border p-8 text-center" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            当前书签库暂无可唤醒内容，请先同步或导入精选热库。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => {
            const done = reviewedSet.has(post.tweet_id)
            return (
              <article
                key={post.tweet_id}
                className={`v2-card p-3.5 transition-opacity ${done ? 'opacity-60' : ''}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold text-sm">{post.name || post.screen_name}</span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      @{post.screen_name} · {post.created_at ? new Date(post.created_at).toISOString().slice(0, 10) : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {post.folder && (
                      <span className="rounded-full px-2.5 py-0.5 text-[11px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        {post.folder}
                      </span>
                    )}
                    {done && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> 已回顾
                      </span>
                    )}
                  </div>
                </div>

                <div
                  onClick={() => onSelectPost(post)}
                  className="cursor-pointer whitespace-pre-wrap break-words text-[14.5px] leading-relaxed"
                >
                  {post.text.length > 420 ? `${post.text.slice(0, 420)}…` : post.text}
                </div>

                {post.quoted?.text && (
                  <div className="mt-3 rounded-xl border p-3 text-xs" style={{ background: 'var(--card-2)', borderColor: 'var(--border)' }}>
                    <span className="font-medium">引用 @{post.quoted.screen_name}：</span>
                    {post.quoted.text.slice(0, 180)}
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-3 text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                    <span>❤️ {post.metrics.likes.toLocaleString()}</span>
                    <span>🔖 {post.metrics.bookmarks.toLocaleString()}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectPost(post)}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--hover)]"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <BookOpen className="h-3.5 w-3.5" /> 展开细读
                    </button>
                    <button
                      type="button"
                      onClick={() => void pushNotion(post)}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs hover:bg-[var(--hover)]"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <Send className="h-3.5 w-3.5" /> 推 Notion
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendCleanup(post)}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs hover:bg-rose-500/10"
                      style={{ borderColor: 'var(--border)', color: 'var(--danger)' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> 移入待清理
                    </button>
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs no-underline hover:bg-[var(--hover)]"
                      style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    {!done && (
                      <button
                        type="button"
                        onClick={() => void markDone(post.tweet_id)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium"
                        style={{ background: 'var(--primary-btn-bg)', color: 'var(--primary-btn-fg)' }}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> 标记已读
                      </button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
