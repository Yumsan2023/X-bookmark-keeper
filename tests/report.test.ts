import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { clearAll } from '@/db/posts'
import { allocatePercents, computeSyncReportStats } from '@/report/aggregate'
import { classifyPost, isArticleUrl, type ContentKind } from '@/report/classify'
import type { MediaItem, Metrics, Post } from '@/shared/types'

const metrics: Metrics = { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: 0 }

function base(partial: Partial<Post> & Pick<Post, 'tweet_id' | 'screen_name'>): Post {
  return {
    sort_index: partial.tweet_id.padStart(24, '0'),
    user_id: partial.user_id ?? 'u1',
    name: partial.name ?? partial.screen_name,
    avatar: partial.avatar ?? '',
    created_at: 1,
    text: partial.text ?? 'hi',
    lang: 'en',
    urls: partial.urls ?? [],
    media: partial.media ?? [],
    metrics,
    has_image: partial.has_image ?? 0,
    has_video: partial.has_video ?? 0,
    has_link: partial.has_link ?? 0,
    has_quote: partial.has_quote ?? 0,
    has_article: partial.has_article,
    folder: '',
    tags: [],
    status: partial.status ?? 'active',
    saved_at: 1,
    sync_run: 'r1',
    url: `https://x.com/${partial.screen_name}/status/${partial.tweet_id}`,
    source: partial.source ?? 'bookmark',
    thread: partial.thread,
    ...partial,
  }
}

describe('classifyPost', () => {
  it('prioritizes video over image/article/long', () => {
    const media: MediaItem[] = [
      { type: 'photo', url: 'https://pbs.twimg.com/a.jpg' },
      { type: 'video', url: 'https://pbs.twimg.com/v.jpg', video_url: 'https://v.twimg.com/a.mp4' },
    ]
    expect(
      classifyPost(
        base({
          tweet_id: '1',
          screen_name: 'a',
          has_video: 1,
          has_image: 1,
          has_article: 1,
          media,
          text: 'x'.repeat(400),
          urls: ['https://x.com/i/article/1'],
        }),
      ),
    ).toBe('video')
  })

  it('classifies image when no video', () => {
    expect(
      classifyPost(base({ tweet_id: '2', screen_name: 'a', has_image: 1, media: [{ type: 'photo', url: 'u' }] })),
    ).toBe('image')
  })

  it('classifies article by flag or URL', () => {
    expect(classifyPost(base({ tweet_id: '3', screen_name: 'a', has_article: 1 }))).toBe('article')
    expect(
      classifyPost(base({ tweet_id: '4', screen_name: 'a', urls: ['https://x.com/i/articles/123'] })),
    ).toBe('article')
    expect(isArticleUrl('https://x.com/bob/article/xyz')).toBe(true)
  })

  it('classifies long posts by text length or thread', () => {
    expect(classifyPost(base({ tweet_id: '5', screen_name: 'a', text: 'y'.repeat(280) }))).toBe('long')
    expect(
      classifyPost(
        base({
          tweet_id: '6',
          screen_name: 'a',
          text: 'short',
          thread: [{ tweet_id: '6b', text: 'more', created_at: 2, media: [] }],
        }),
      ),
    ).toBe('long')
  })

  it('defaults to standard', () => {
    expect(classifyPost(base({ tweet_id: '7', screen_name: 'a', text: 'hello' }))).toBe('standard')
  })
})

describe('allocatePercents', () => {
  it('sums to 100 when total > 0', () => {
    const pct = allocatePercents([27, 230, 30, 49, 135], 471)
    expect(pct.reduce((a, b) => a + b, 0)).toBe(100)
  })
  it('returns zeros when total is 0', () => {
    expect(allocatePercents([0, 0], 0)).toEqual([0, 0])
  })
})

describe('computeSyncReportStats', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('aggregates kinds and top authors over active bookmarks only', async () => {
    const posts: Post[] = [
      base({ tweet_id: '10', screen_name: 'alice', name: 'Alice', user_id: '1', has_video: 1, media: [{ type: 'video', url: 't' }] }),
      base({ tweet_id: '11', screen_name: 'alice', name: 'Alice', user_id: '1', has_image: 1, media: [{ type: 'photo', url: 'p' }] }),
      base({ tweet_id: '12', screen_name: 'bob', name: 'Bob', user_id: '2', text: 'z'.repeat(300) }),
      base({ tweet_id: '13', screen_name: 'bob', name: 'Bob', user_id: '2', text: 'std' }),
      base({ tweet_id: '14', screen_name: 'carol', name: 'Carol', user_id: '3', has_article: 1 }),
      // excluded: timeline
      base({ tweet_id: '15', screen_name: 'alice', source: 'timeline', text: 'tl' }),
      // excluded: unbookmarked
      base({ tweet_id: '16', screen_name: 'dave', status: 'unbookmarked', text: 'gone' }),
    ]
    await db.posts.bulkPut(posts)
    const r = await computeSyncReportStats(100)
    expect(r.total).toBe(5)
    const byKind = Object.fromEntries(r.kinds.map((k) => [k.kind, k.count])) as Record<ContentKind, number>
    expect(byKind.video).toBe(1)
    expect(byKind.image).toBe(1)
    expect(byKind.long).toBe(1)
    expect(byKind.standard).toBe(1)
    expect(byKind.article).toBe(1)
    expect(r.kinds.reduce((s, k) => s + k.percent, 0)).toBe(100)
    expect(r.authors[0].screen_name).toBe('alice')
    expect(r.authors[0].count).toBe(2)
    expect(r.authors[1].screen_name).toBe('bob')
    expect(r.authors[1].count).toBe(2)
    expect(r.authorCount).toBe(3)
  })
})
