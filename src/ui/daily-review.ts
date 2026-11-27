/**
 * v2 Daily Review (每日旧书签唤醒):
 * Picks 5 high-signal bookmarks each day, prioritizing:
 *   1. "On This Day" anniversary bookmarks (same month/day in earlier years)
 *   2. Curated `tier:S-核心精华` & `tier:A-有用参考` bookmarks
 *   3. High-bookmark / long-form / X Article posts
 * Persisted per local day in chrome.storage.local so refreshing keeps today's deck.
 */
import { db } from '@/db/db'
import { STORAGE_KEYS, type Post } from '@/shared/types'

export interface DailyReviewState {
  day: string
  ids: string[]
  reviewedIds: string[]
}

function todayKey(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function pickDailyReviewCandidates(posts: Post[], count = 5, now = Date.now(), random = Math.random): Post[] {
  const active = posts.filter((p) => p.status === 'active' && p.source !== 'timeline' && p.folder !== '待清理')
  if (!active.length) return []

  const d = new Date(now)
  const month = d.getMonth()
  const day = d.getDate()
  const year = d.getFullYear()

  const scored = active.map((p) => {
    let weight = 1
    const tags = p.tags ?? []
    if (tags.includes('tier:S-核心精华')) weight += 5
    else if (tags.includes('tier:A-有用参考')) weight += 3
    if (p.has_article) weight += 3
    if ((p.metrics?.bookmarks ?? 0) >= 500) weight += 2
    if ((p.text?.length ?? 0) >= 400) weight += 1.5
    const pd = new Date(p.created_at)
    if (pd.getMonth() === month && pd.getDate() === day && pd.getFullYear() < year) {
      weight += 6 // On This Day anniversary boost
    }
    return { post: p, key: Math.pow(random() || 0.0001, 1 / weight) }
  })

  scored.sort((a, b) => b.key - a.key)
  return scored.slice(0, count).map((s) => s.post)
}

export async function loadOrCreateDailyReview(forceRefresh = false, count = 5): Promise<{
  state: DailyReviewState
  posts: Post[]
}> {
  const day = todayKey()
  if (!forceRefresh) {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.dailyReview)
      const saved = got[STORAGE_KEYS.dailyReview] as DailyReviewState | undefined
      if (saved && saved.day === day && Array.isArray(saved.ids) && saved.ids.length) {
        const fetched = (await db.posts.bulkGet(saved.ids)).filter(Boolean) as Post[]
        if (fetched.length) return { state: saved, posts: fetched }
      }
    } catch {
      /* ignore */
    }
  }

  // Sample up to 2500 active bookmarks cleanly without scanning 60k if DB is huge
  const pool = await db.posts.where('status').equals('active').limit(2500).toArray()
  const picked = pickDailyReviewCandidates(pool, count)
  const state: DailyReviewState = {
    day,
    ids: picked.map((p) => p.tweet_id),
    reviewedIds: [],
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.dailyReview]: state })
  } catch {
    /* ignore */
  }
  return { state, posts: picked }
}

export async function markDailyReviewed(tweetId: string): Promise<DailyReviewState> {
  const got = await chrome.storage.local.get(STORAGE_KEYS.dailyReview)
  const cur = (got[STORAGE_KEYS.dailyReview] as DailyReviewState | undefined) ?? {
    day: todayKey(),
    ids: [],
    reviewedIds: [],
  }
  const reviewedIds = cur.reviewedIds.includes(tweetId) ? cur.reviewedIds : [...cur.reviewedIds, tweetId]
  const next: DailyReviewState = { ...cur, reviewedIds }
  await chrome.storage.local.set({ [STORAGE_KEYS.dailyReview]: next })
  return next
}
