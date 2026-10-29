import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { padSortIndex } from '@/api/parser'
import { XApiError } from '@/api/errors'
import { SyncEngine, type SyncApi } from '@/background/sync-engine'
import { db } from '@/db/db'
import { clearAll, moveToFolder, upsertParsed } from '@/db/posts'
import { DEFAULT_SETTINGS, type Settings, type SyncProgress } from '@/shared/types'
import { bookmarksPage, cursorEntry, folderTimelinePage, foldersResponse, threadResponse, tweet, tweetEntry } from './fixtures/builders'

/** 构造分页的假 API: pages[i] = 该页的 tweet id 列表; cursor 形如 "c1","c2" */
function fakeApi(pages: string[][], opts: { onCall?: (cursor?: string) => void; failOnce?: Record<string, XApiError> } = {}) {
  const failed = new Set<string>()
  const calls: (string | undefined)[] = []
  let sort = 100000
  const api: Partial<SyncApi> = {
    async getBookmarks(cursor) {
      calls.push(cursor)
      opts.onCall?.(cursor)
      const key = cursor ?? 'c0'
      const err = opts.failOnce?.[key]
      if (err && !failed.has(key)) {
        failed.add(key)
        throw err
      }
      const idx = Number(key.slice(1))
      const ids = pages[idx] ?? []
      const entries: any[] = ids.map((id) => tweetEntry(tweet({ id, text: `post ${id}` }), String(sort--)))
      if (idx + 1 < pages.length) entries.push(cursorEntry(`c${idx + 1}`))
      else entries.push(cursorEntry('c_end')) // 真实 X 末页仍会给游标, 下一页为空
      return bookmarksPage(entries)
    },
  }
  return { api, calls }
}

function mkEngine(api: Partial<SyncApi>, settings: Partial<Settings> = {}, extra: { progress?: { v?: SyncProgress }; sleeps?: number[] } = {}) {
  const store = extra.progress ?? {}
  const history: SyncProgress[] = []
  const engine = new SyncEngine({
    api: {
      getBookmarks: async () => bookmarksPage([]),
      getFolders: async () => foldersResponse([]),
      getFolderTimeline: async () => folderTimelinePage([]),
      getTweetDetail: async () => ({}),
      ...api,
    } as SyncApi,
    getSettings: async () => ({ ...DEFAULT_SETTINGS, syncFolders: false, detectDeleted: true, delayMinSec: 0, delayMaxSec: 0, ...settings }),
    loadProgress: async () => store.v,
    saveProgress: async (p) => {
      store.v = p
      history.push(p)
    },
    sleep: async (ms) => {
      extra.sleeps?.push(ms)
    },
    random: () => 0,
  })
  return { engine, store, history }
}

beforeEach(async () => {
  await clearAll()
})

describe('SyncEngine', () => {
  it('full sync walks all pages and stores posts', async () => {
    const { api, calls } = fakeApi([['10', '9'], ['8', '7'], ['6']])
    const { engine, store } = mkEngine(api)
    const p = await engine.start('full')
    expect(p.status).toBe('done')
    expect(calls).toEqual([undefined, 'c1', 'c2', 'c_end'])
    expect(await db.posts.count()).toBe(5)
    expect(store.v).toMatchObject({ status: 'done', fetched: 5, added: 5, pages: 4 })
    // sort_index 越靠前的书签越大
    const newest = await db.posts.orderBy('sort_index').last()
    expect(newest!.tweet_id).toBe('10')
  })

  it('incremental sync stops at first page containing an already-saved bookmark', async () => {
    const full = fakeApi([['10', '9'], ['8', '7'], ['6', '5']])
    await mkEngine(full.api).engine.start('full')
    // X 端新增 12, 11, 老的从 10 开始
    const inc = fakeApi([['12', '11', '10'], ['9', '8']])
    const p = await mkEngine(inc.api).engine.start('incremental')
    expect(p.status).toBe('done')
    expect(inc.calls).toEqual([undefined]) // 第二页没有请求
    expect(await db.posts.count()).toBe(8)
    expect(p.added).toBe(2)
  })

  it('full sync marks bookmarks removed on X as unbookmarked but keeps them', async () => {
    await mkEngine(fakeApi([['10', '9', '8']]).api).engine.start('full')
    const p = await mkEngine(fakeApi([['10', '8']]).api).engine.start('full')
    expect(p.status).toBe('done')
    expect((await db.posts.get('9'))!.status).toBe('unbookmarked')
    expect((await db.posts.get('9'))!.text).toBe('post 9')
    expect((await db.posts.get('10'))!.status).toBe('active')
  })

  it('marks tweets deleted on X (tombstone) as tweet_deleted', async () => {
    await mkEngine(fakeApi([['10', '9']]).api).engine.start('full')
    const tomb = {
      entryId: 'tweet-9',
      sortIndex: '5',
      content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: 'TweetTombstone' } } } },
    }
    const api: Partial<SyncApi> = {
      getBookmarks: async (c) => (c ? bookmarksPage([]) : bookmarksPage([tweetEntry(tweet({ id: '10' }), '9'), tomb, cursorEntry('x')])),
    }
    await mkEngine(api).engine.start('full')
    expect((await db.posts.get('9'))!.status).toBe('tweet_deleted')
    expect((await db.posts.get('10'))!.status).toBe('active')
  })

  it('cancel keeps the cursor so that resume continues from the checkpoint', async () => {
    const { api, calls } = fakeApi([['10'], ['9'], ['8'], ['7']])
    const ref: { engine?: SyncEngine } = {}
    const wrapped: Partial<SyncApi> = {
      getBookmarks: async (c, n) => {
        if (c === 'c2') ref.engine!.cancel()
        return api.getBookmarks!(c, n)
      },
    }
    const progress: { v?: SyncProgress } = {}
    const m1 = mkEngine(wrapped, {}, { progress })
    ref.engine = m1.engine
    const p1 = await m1.engine.start('full')
    expect(p1.status).toBe('cancelled')
    expect(progress.v!.cursor).toBeDefined()
    const fetchedBefore = await db.posts.count()
    expect(fetchedBefore).toBeGreaterThan(0)
    expect(fetchedBefore).toBeLessThan(4)

    calls.length = 0
    const m2 = mkEngine(api, {}, { progress })
    const p2 = await m2.engine.start('resume')
    expect(p2.status).toBe('done')
    expect(p2.run_id).toBe(p1.run_id)
    expect(calls[0]).toBe(p1.cursor) // 从断点继续, 不从头开始
    expect(await db.posts.count()).toBe(4)
  })

  it('pause blocks until resume', async () => {
    const { api } = fakeApi([['3'], ['2'], ['1']])
    const ref: { engine?: SyncEngine } = {}
    const seen: string[] = []
    const m = mkEngine({
      getBookmarks: async (c, n) => {
        if (c === 'c1') ref.engine!.pause()
        return api.getBookmarks!(c, n)
      },
    })
    ref.engine = m.engine
    const run = m.engine.start('full')
    await new Promise((r) => setTimeout(r, 30))
    expect(m.store.v!.status).toBe('paused')
    seen.push(String(await db.posts.count()))
    m.engine.resume()
    const p = await run
    expect(p.status).toBe('done')
    expect(await db.posts.count()).toBe(3)
  })

  it('429 waits until reset (no spinning) then continues', async () => {
    const reset = Date.now() + 60_000
    const { api, calls } = fakeApi([['2'], ['1']], { failOnce: { c1: new XApiError('rate_limit', '429', { resetAt: reset }) } })
    let now = Date.now()
    const sleeps: number[] = []
    const store: { v?: SyncProgress } = {}
    const engine = new SyncEngine({
      api: { getBookmarks: api.getBookmarks, getFolders: async () => foldersResponse([]), getFolderTimeline: async () => folderTimelinePage([]), getTweetDetail: async () => ({}) } as SyncApi,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, syncFolders: false, delayMinSec: 0, delayMaxSec: 0 }),
      loadProgress: async () => store.v,
      saveProgress: async (p) => void (store.v = p),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
      random: () => 0,
    })
    const p = await engine.start('full')
    expect(p.status).toBe('done')
    expect(calls.filter((c) => c === 'c1')).toHaveLength(2)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000)
    expect(await db.posts.count()).toBe(2)
  })

  it('auth error ends the run as error with code and keeps the cursor', async () => {
    const { api } = fakeApi([['2'], ['1']], { failOnce: { c1: new XApiError('auth', 'forbidden') } })
    const m = mkEngine(api)
    const p = await m.engine.start('full')
    expect(p).toMatchObject({ status: 'error', error_code: 'auth' })
    expect(p.cursor).toBe('c1')
  })

  it('transient network errors are retried', async () => {
    const { api, calls } = fakeApi([['2'], ['1']], { failOnce: { c1: new XApiError('network', 'down') } })
    const p = await mkEngine(api).engine.start('full')
    expect(p.status).toBe('done')
    expect(calls.filter((c) => c === 'c1')).toHaveLength(2)
  })

  it('unrecognized response structure is reported as data error', async () => {
    const p = await mkEngine({ getBookmarks: async () => ({ data: { something_else: {} } }) }).engine.start('full')
    expect(p).toMatchObject({ status: 'error', error_code: 'data' })
  })

  it('does not run the removed-bookmark detection when the sync errored midway', async () => {
    await mkEngine(fakeApi([['10', '9', '8']]).api).engine.start('full')
    const { api } = fakeApi([['10'], ['9']], { failOnce: { c1: new XApiError('auth', 'x') } })
    await mkEngine(api).engine.start('full')
    expect(await db.posts.where('status').equals('active').count()).toBe(3)
  })

  it('syncs X folders: assigns folder, keeps bookmark sort index, drops stale membership', async () => {
    await mkEngine(fakeApi([['10', '9', '8']]).api).engine.start('full')
    await moveToFolder(['8'], 'AI') // 本地以为 8 在 AI 里, 但 X 端已经不在了
    const api: Partial<SyncApi> = {
      getBookmarks: async (c) =>
        bookmarksPage(c ? [] : [tweetEntry(tweet({ id: '10' }), '300'), tweetEntry(tweet({ id: '9' }), '200'), tweetEntry(tweet({ id: '8' }), '100'), cursorEntry('end')]),
      getFolders: async () => foldersResponse([{ id: 'f1', name: 'AI' }]),
      getFolderTimeline: async (id, c) => (c ? folderTimelinePage([]) : folderTimelinePage([tweetEntry(tweet({ id: '9' }), '5'), cursorEntry('fend')])),
    }
    const p = await mkEngine(api, { syncFolders: true }).engine.start('full')
    expect(p.status).toBe('done')
    expect((await db.posts.get('9'))!.folder).toBe('AI')
    expect((await db.posts.get('8'))!.folder).toBe('')
    // 文件夹时间线 (sortIndex=5) 不会覆盖书签总表里的排序值
    expect((await db.posts.get('9'))!.sort_index).toBe(padSortIndex('200'))
    const f = (await db.folders.get('AI'))!
    expect(f).toMatchObject({ x_id: 'f1', source: 'x' })
  })

  it('fetches threads when enabled', async () => {
    const focal = tweet({ id: '10', user_id: 'u1', conversation_id: '10' })
    const second = tweet({ id: '11', text: 'part two', user_id: 'u1', conversation_id: '10' })
    const api: Partial<SyncApi> = {
      getBookmarks: async (c) => bookmarksPage(c ? [] : [tweetEntry(focal, '5'), cursorEntry('x')]),
      getTweetDetail: async () => threadResponse(focal, [{ tweet: second, module: true }]),
    }
    const p = await mkEngine(api, { fetchThreads: true }).engine.start('full')
    expect(p.status).toBe('done')
    const post = (await db.posts.get('10'))!
    expect(post.thread?.map((t) => t.text)).toEqual(['part two'])
    expect(post.thread_fetched_at).toBeTypeOf('number')
  })

  it('refuses to start twice concurrently', async () => {
    const { api, calls } = fakeApi([['2'], ['1']])
    const m = mkEngine(api)
    const a = m.engine.start('full')
    await m.engine.start('full') // 第二次调用被忽略, 不会并发跑第二个循环
    expect((await a).status).toBe('done')
    expect(calls).toEqual([undefined, 'c1', 'c_end'])
  })

  it('upsertParsed integration: resurrected posts are treated as new for incremental stop', async () => {
    await mkEngine(fakeApi([['1']]).api).engine.start('full')
    await db.posts.update('1', { status: 'unbookmarked' })
    const r = await upsertParsed([(await import('@/api/parser')).tweetToPost(tweet({ id: '1' }))!], 'zz')
    expect(r.existingIds).toEqual([])
  })
})
