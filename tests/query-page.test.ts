import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { clearAll, upsertParsed } from '@/db/posts'
import { iteratePostsBatches, pagePostsNoText } from '@/db/query'
import { parseTimelinePage, type ParsedPost } from '@/api/parser'
import { bookmarksPage, tweet, tweetEntry } from './fixtures/builders'
import { parseQuery } from '@/search/query-parser'
import { SearchEngine } from '@/search/engine'
import { buildIndexBatched, searchPage } from '@/search/service'
import { buildBatchExport, chunkPosts, batchFileName } from '@/export/batch'
import type { Post } from '@/shared/types'

function parsed(ids: string[]): ParsedPost[] {
  return parseTimelinePage(bookmarksPage(ids.map((id, i) => tweetEntry(tweet({ id, text: `t${id}` }), String(9000 - i))))).entries.map((e) => (e as any).post)
}

beforeEach(async () => {
  await clearAll()
})

describe('pagePostsNoText', () => {
  it('paginates without loading the whole table into one array result', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i + 1))
    await upsertParsed(parsed(ids), 'r')
    const page0 = await pagePostsNoText({ offset: 0, limit: 40, sort: 'saved_desc' })
    const page1 = await pagePostsNoText({ offset: 40, limit: 40, sort: 'saved_desc' })
    const page2 = await pagePostsNoText({ offset: 80, limit: 40, sort: 'saved_desc' })
    expect(page0.total).toBe(120)
    expect(page0.posts).toHaveLength(40)
    expect(page1.posts).toHaveLength(40)
    expect(page2.posts).toHaveLength(40)
    const allIds = [...page0.posts, ...page1.posts, ...page2.posts].map((p) => p.tweet_id)
    expect(new Set(allIds).size).toBe(120)
    // saved_desc: 更大 sort_index 在前 (builders 用 9000-i)
    expect(page0.posts[0].sort_index >= page0.posts[39].sort_index).toBe(true)
  })

  it('filters by folder via index and paginates', async () => {
    await upsertParsed(parsed(['1', '2', '3', '4', '5']), 'r')
    await db.posts.update('1', { folder: 'Dev' })
    await db.posts.update('2', { folder: 'Dev' })
    await db.posts.update('3', { folder: 'Dev' })
    const r = await pagePostsNoText({
      offset: 0,
      limit: 2,
      sort: 'saved_desc',
      parsed: parseQuery('folder:Dev'),
    })
    expect(r.total).toBe(3)
    expect(r.posts).toHaveLength(2)
    expect(r.posts.every((p) => p.folder === 'Dev')).toBe(true)
  })
})

describe('iteratePostsBatches / index build does not require toArray upfront', () => {
  it('yields batches covering all posts', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(200 + i))
    await upsertParsed(parsed(ids), 'r')
    const got: string[] = []
    for await (const batch of iteratePostsBatches(10)) {
      expect(batch.length).toBeLessThanOrEqual(10)
      got.push(...batch.map((p) => p.tweet_id))
    }
    expect(got.sort()).toEqual(ids.sort())
  })

  it('buildIndexBatched then searchPage returns matches without setPosts(all)', async () => {
    await upsertParsed(parsed(['1', '2', '3']), 'r')
    await db.posts.update('1', { text: 'Learning Rust async' })
    await db.posts.update('2', { text: 'pasta recipe' })
    const engine = new SearchEngine()
    await buildIndexBatched(engine)
    expect(engine.ready).toBe(true)
    expect(engine.documentCount).toBe(3)
    const r = await searchPage(engine, { query: 'rust', page: 0, pageSize: 10 })
    expect(r.hits.map((h) => h.post.tweet_id)).toContain('1')
    expect(r.total).toBeGreaterThanOrEqual(1)
  })

})

describe('searchPage empty query', () => {
  it('returns a page without requiring SearchEngine.setPosts', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(300 + i))
    await upsertParsed(parsed(ids), 'r')
    const engine = new SearchEngine()
    const r = await searchPage(engine, { query: '', page: 0, pageSize: 20, sort: 'saved_desc' })
    expect(r.hits).toHaveLength(20)
    expect(r.total).toBe(50)
    expect(engine.ready).toBe(false) // still no full index needed to browse
  })
})

describe('batch export', () => {
  function fakePosts(n: number): Post[] {
    return Array.from({ length: n }, (_, i) => ({
      tweet_id: String(i + 1),
      sort_index: String(100000 + i).padStart(24, '0'),
      user_id: 'u',
      screen_name: 'a',
      name: 'A',
      avatar: '',
      created_at: Date.UTC(2024, 0, 1) + i * 86400000,
      text: `post ${i + 1}`,
      lang: 'en',
      urls: [],
      media: [],
      metrics: { replies: 0, retweets: 0, likes: i, quotes: 0, bookmarks: 0, views: 0 },
      has_image: 0,
      has_video: 0,
      has_link: 0,
      has_quote: 0,
      folder: '',
      tags: [],
      status: 'active' as const,
      saved_at: 0,
      sync_run: 'r',
      url: `https://x.com/a/status/${i + 1}`,
    }))
  }

  it('chunks and names batches with index/total/range', () => {
    expect(chunkPosts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    const name = batchFileName('json', { batchIndex: 1, batchTotal: 59, start: 1, end: 1000 }, 59000)
    expect(name).toMatch(/bookmarks_001_of_059_00001-01000\.json/)
  })

  it('builds one zip containing multiple batch files for JSON', () => {
    const posts = fakePosts(2500)
    const { zips, batchTotal, postTotal } = buildBatchExport('json', posts, 1000, 10)
    expect(postTotal).toBe(2500)
    expect(batchTotal).toBe(3)
    expect(zips).toHaveLength(1)
    expect(zips[0].filename).toMatch(/bookmarks_batch_json_.*_003batches\.zip/)
    expect(zips[0].data.byteLength).toBeGreaterThan(100)
  })

  it('splits into multiple zips when batches exceed batchesPerZip', () => {
    const posts = fakePosts(25)
    const { zips, batchTotal } = buildBatchExport('csv', posts, 5, 2) // 5 batches, 2 per zip → 3 zips
    expect(batchTotal).toBe(5)
    expect(zips).toHaveLength(3)
  })

  it('obsidian batches go into per-batch folders inside zip', () => {
    const posts = fakePosts(3)
    const { zips, batchTotal } = buildBatchExport('obsidian', posts, 2, 10)
    expect(batchTotal).toBe(2)
    expect(zips).toHaveLength(1)
  })
})
