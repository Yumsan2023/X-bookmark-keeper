import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeCentroids, timeWeight, toProfileSamples, type ProfileSample } from '@/foryou/profile'
import { buildProfileJob } from '@/foryou/runner'
import { db } from '@/db/db'
import { clearAll, sampleBookmarks } from '@/db/posts'
import type { ForYouProfileRow } from '@/foryou/types'
import type { Post } from '@/shared/types'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

function sample(over: Partial<ProfileSample> = {}): ProfileSample {
  return {
    id: '1',
    text: 'hello',
    tags: [],
    author: 'alice',
    likes: 10,
    views: 100,
    savedAt: NOW,
    embedding: [1, 0],
    ...over,
  }
}

function post(id: string, over: Partial<Post> = {}): Post {
  return {
    tweet_id: id,
    sort_index: id.padStart(5, '0'),
    user_id: '7',
    screen_name: 'alice',
    name: 'A',
    avatar: '',
    created_at: 1,
    text: `post ${id}`,
    lang: 'zh',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 10, quotes: 0, bookmarks: 1, views: 100 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: '',
    tags: [],
    status: 'active',
    saved_at: NOW,
    sync_run: 'r',
    url: `https://x.com/alice/status/${id}`,
    source: 'bookmark',
    accounts: ['alice'],
    ...over,
  }
}

describe('timeWeight', () => {
  it('is 1 now, 0.5 after one half-life, 0.25 after two', () => {
    expect(timeWeight(NOW, 90, NOW)).toBeCloseTo(1, 6)
    expect(timeWeight(NOW - 90 * DAY, 90, NOW)).toBeCloseTo(0.5, 6)
    expect(timeWeight(NOW - 180 * DAY, 90, NOW)).toBeCloseTo(0.25, 6)
    expect(timeWeight(NOW + DAY, 90, NOW)).toBeCloseTo(1, 6)
  })
})

describe('computeCentroids', () => {
  it('weights recent samples above old ones', () => {
    const recent = sample({ id: 'new', savedAt: NOW, embedding: [1, 0] })
    const old = sample({ id: 'old', savedAt: NOW - 90 * DAY, embedding: [0, 1] })
    const { globalCentroid } = computeCentroids([recent, old], { halfLifeDays: 90, now: NOW })
    // weights 1 vs 0.5 → mean (2/3, 1/3), normalized
    expect(globalCentroid[0]).toBeCloseTo(0.8944, 3)
    expect(globalCentroid[1]).toBeCloseTo(0.4472, 3)
    expect(Math.hypot(...globalCentroid)).toBeCloseTo(1, 6)
  })

  it('returns a zero centroid and empty stats for no samples', () => {
    const r = computeCentroids([], { now: NOW })
    expect(r.globalCentroid).toEqual([])
    expect(r.tagCentroids).toEqual({})
    expect(r.topAuthors).toEqual([])
    expect(r.medianLikes).toBeNull()
    expect(r.sampleSize).toBe(0)
  })

  it('builds tag centroids only for tags with >=20 samples, top 12', () => {
    const samples: ProfileSample[] = []
    for (let i = 0; i < 25; i++) samples.push(sample({ id: `a${i}`, tags: ['AI'], embedding: [1, 0] }))
    for (let i = 0; i < 5; i++) samples.push(sample({ id: `b${i}`, tags: ['小众'], embedding: [0, 1] }))
    const { tagCentroids } = computeCentroids(samples, { now: NOW })
    expect(Object.keys(tagCentroids)).toEqual(['AI'])
    expect(tagCentroids['AI'][0]).toBeCloseTo(1, 6)
  })

  it('takes top authors with >=10 bookmarks, top 50, and medians', () => {
    const samples: ProfileSample[] = []
    for (let i = 0; i < 12; i++) samples.push(sample({ id: `a${i}`, author: 'Alice', likes: 10, views: 100 }))
    for (let i = 0; i < 9; i++) samples.push(sample({ id: `b${i}`, author: 'Bob', likes: 20, views: 200 }))
    for (let i = 0; i < 11; i++) samples.push(sample({ id: `c${i}`, author: 'Carol', likes: null, views: null }))
    const { topAuthors, medianLikes, medianViews } = computeCentroids(samples, { now: NOW })
    expect(topAuthors).toEqual(['Alice', 'Carol'])
    expect(medianLikes).toBe(10)
    expect(medianViews).toBe(100)
  })

  it('treats the zero vector as no direction', () => {
    const { globalCentroid } = computeCentroids([sample({ embedding: [0, 0] })], { now: NOW })
    expect(globalCentroid).toEqual([0, 0])
  })
})

describe('toProfileSamples', () => {
  it('throws when embeddings and samples are misaligned', () => {
    expect(() =>
      toProfileSamples(
        [{ tweet_id: '1', text: 'x', screen_name: 'a', tags: [], likes: null, views: null, saved_at: NOW }],
        [[1, 0], [0, 1]],
      ),
    ).toThrow('条数不对')
  })
})

describe('sampleBookmarks', () => {
  beforeEach(async () => {
    await clearAll()
  })

  it('takes the newest first, then random rest, capped and deduped', async () => {
    const rows: Post[] = []
    for (let i = 0; i < 10; i++) {
      rows.push(post(String(i), { saved_at: NOW - i * DAY, text: `post ${i}` }))
    }
    rows.push(post('11', { status: 'unbookmarked' }))
    rows.push(post('12', { source: 'timeline' }))
    await db.posts.bulkPut(rows)
    const sampled = await sampleBookmarks({ nRecent: 3, nRandom: 4, random: () => 0.5 })
    expect(sampled).toHaveLength(7)
    expect(sampled.slice(0, 3).map((p) => p.tweet_id)).toEqual(['0', '1', '2'])
    expect(sampled.every((p) => p.text.length <= 500)).toBe(true)
    expect(new Set(sampled.map((p) => p.tweet_id)).size).toBe(7)
  })

  it('returns [] when there are no active bookmarks', async () => {
    expect(await sampleBookmarks()).toEqual([])
  })
})

describe('buildProfileJob', () => {
  beforeEach(async () => {
    await clearAll()
    await db.foryouProfile.clear()
  })

  const embedCfg = { endpoint: 'http://127.0.0.1:1234/v1', model: 'bge-m3' }

  it('writes a profile whose centroid excludes the holdout', async () => {
    // 30 samples. Deterministic shuffle (random() = 0.99 → no swaps),
    // so holdout = first 3 (ids 0–2). Their vectors are [0,1]; train is
    // all [1,0], so a leaked holdout would tilt the centroid — it must
    // stay exactly [1,0]. Their tag must not get a centroid either.
    // Train has 27 'AI' tags (≥20) so AI does get a centroid.
    const sampled = Array.from({ length: 30 }, (_, i) => ({
      tweet_id: String(i),
      text: `post ${i}`,
      screen_name: 'alice',
      tags: i < 3 ? ['HoldoutTag'] : ['AI'],
      likes: 10,
      views: 100,
      saved_at: NOW,
    }))
    const embedFn = vi.fn(async (texts: string[]) =>
      texts.map((t) => (t === 'post 0' || t === 'post 1' || t === 'post 2' ? [0, 1] : [1, 0])),
    )
    const saved: ForYouProfileRow[] = []
    const progress: string[] = []
    const result = await buildProfileJob({
      embed: embedCfg,
      halfLifeDays: 90,
      sampleFn: async () => sampled,
      embedFn,
      saveFn: async (row) => {
        saved.push(row)
      },
      progressFn: (p) => {
        progress.push(p.status)
      },
      random: () => 0.99,
      now: () => NOW,
    })
    expect(result.sampled).toBe(30)
    expect(result.holdout).toBe(3)
    expect(result.profile.holdoutIds).toHaveLength(3)
    expect(result.profile.sampleSize).toBe(27)
    expect(result.profile.globalCentroid[0]).toBeCloseTo(1, 6)
    expect(result.profile.globalCentroid[1]).toBeCloseTo(0, 6)
    expect(result.profile.holdoutIds).toEqual(['0', '1', '2'])
    expect(Object.keys(result.profile.tagCentroids)).toEqual(['AI'])
    expect(saved).toHaveLength(1)
    expect(saved[0].dim).toBe(2)
    expect(saved[0].model).toBe('bge-m3')
    expect(saved[0].negCentroid).toBeNull()
    expect(progress).toContain('done')
  })

  it('throws without saving when there are no bookmarks', async () => {
    const saveFn = vi.fn()
    await expect(
      buildProfileJob({ embed: embedCfg, sampleFn: async () => [], saveFn: async () => saveFn() }),
    ).rejects.toThrow('没有可建画像的书签')
    expect(saveFn).not.toHaveBeenCalled()
  })

  it('aborts and does not save when cancelled mid-embedding', async () => {
    const ctrl = new AbortController()
    const sampled = Array.from({ length: 5 }, (_, i) => ({
      tweet_id: String(i),
      text: `post ${i}`,
      screen_name: 'alice',
      tags: [],
      likes: null,
      views: null,
      saved_at: NOW,
    }))
    const saveFn = vi.fn()
    const embedFn = async () => {
      ctrl.abort()
      throw new Error('embedding 已取消')
    }
    await expect(
      buildProfileJob({ embed: embedCfg, signal: ctrl.signal, sampleFn: async () => sampled, embedFn, saveFn: async () => saveFn() }),
    ).rejects.toThrow('取消')
    expect(saveFn).not.toHaveBeenCalled()
  })
})
