import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { XClient } from '@/api/client'
import { XApiError } from '@/api/errors'
import { DEFAULT_QUERY_IDS, buildUrl } from '@/api/endpoints'
import { bookmarkTweets } from '@/background/actions'
import type { ForYouBookmarkItem } from '@/foryou/types'
import { db } from '@/db/db'
import { clearAll } from '@/db/posts'
import { freshState, localDay } from '@/strike/lib/pure.js'
import { dispatch, __test as storeTest } from '@/strike/lib/store.js'
import type { Post } from '@/shared/types'

const auth = { token: 'Bearer <redacted>', csrf: 'csrf1', uuid: 'uuid1', transaction_id: 'tx1', captured_at: 1 }

function res(status: number, body: unknown = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function mockClient(impl: {
  createBookmark?: (id: string) => Promise<unknown>
  addToFolder?: (id: string, folderId: string) => Promise<unknown>
}) {
  return {
    createBookmark: vi.fn(impl.createBookmark ?? (async () => ({ data: { tweet_bookmark: 'Done' } }))),
    addToFolder: vi.fn(impl.addToFolder ?? (async () => ({}))),
  } as unknown as XClient
}

function item(id: string, handle = 'alice', text = 'hello AI 大模型'): ForYouBookmarkItem {
  return { tweetId: id, handle, text, followed: true, rule: 0.8, vector: null, final: 0.8, reasons: ['topic:ai'] }
}

function seedPost(id: string): Post {
  return {
    tweet_id: id,
    sort_index: id.padStart(5, '0'),
    user_id: '7',
    screen_name: 'alice',
    name: 'A',
    avatar: '',
    created_at: 1,
    text: 'hello',
    lang: 'zh',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 1, quotes: 0, bookmarks: 1, views: 2 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: '',
    tags: [],
    status: 'active',
    saved_at: 1,
    sync_run: 'r',
    url: `https://x.com/alice/status/${id}`,
    source: 'bookmark',
    accounts: ['alice'],
  }
}

// ---- chrome.storage.local stub（runTask publish / getSettings / store.js 共用）----
const holder: { data: Record<string, unknown> } = { data: {} }

function installChrome() {
  holder.data = {}
  const local = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return { ...holder.data }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
      const out: Record<string, unknown> = {}
      for (const key of list) out[key] = holder.data[key]
      return out
    },
    async set(items: Record<string, unknown>) {
      Object.assign(holder.data, items)
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete holder.data[key]
    },
  }
  const runtime = {
    lastError: undefined as { message?: string } | undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`,
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local }, runtime }
}

const TIMELINE_SENDER = { url: 'https://x.com/home' } as const

async function seedState(opts: { enabled?: boolean; bookmarkedToday?: number; backoffUntil?: number } = {}) {
  const state = freshState(Date.now())
  state.settings.foryou.enabled = opts.enabled ?? true
  // freshState 的 day 是今天（localDay(Date.now())），normalizeState 读回时
  // 跨天会清零；这里显式按今天写，保证队列/计数能活过 readRaw。
  state.foryou.day = localDay(Date.now())
  state.foryou.bookmarkedToday = opts.bookmarkedToday ?? 0
  state.foryou.backoffUntil = opts.backoffUntil ?? 0
  holder.data['xsl'] = state
  return state
}

beforeEach(async () => {
  installChrome()
  await clearAll()
  await db.foryouDecisions.clear()
  await db.foryouProfile.clear()
  await db.foryouValidations.clear()
})

describe('XClient.createBookmark', () => {
  it('POSTs CreateBookmark with variables.tweet_id and the queryId in the body', async () => {
    const f = vi.fn(async () => res(200, { data: { tweet_bookmark: 'Done' } }))
    const c = new XClient({
      getAuth: async () => auth,
      getQueryId: async (op) => DEFAULT_QUERY_IDS[op],
      fetchImpl: f as any,
    })
    await c.createBookmark('42')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(buildUrl('CreateBookmark', DEFAULT_QUERY_IDS.CreateBookmark))
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      variables: { tweet_id: '42' },
      queryId: DEFAULT_QUERY_IDS.CreateBookmark,
    })
  })

  it('uses the learned queryId when auth-capture learned one', async () => {
    const f = vi.fn(async () => res(200, { data: {} }))
    const c = new XClient({
      getAuth: async () => auth,
      getQueryId: async () => 'learned-qid-1',
      fetchImpl: f as any,
    })
    await c.createBookmark('42')
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(buildUrl('CreateBookmark', 'learned-qid-1'))
  })

  it('on 404 refreshes queryIds once and retries', async () => {
    const f = vi.fn(async () => res(404, 'not found'))
    f.mockResolvedValueOnce(res(404, 'not found'))
    f.mockResolvedValueOnce(res(200, { data: { tweet_bookmark: 'Done' } }))
    const refresh = vi.fn(async () => true)
    const c = new XClient({
      getAuth: async () => auth,
      getQueryId: async (op) => DEFAULT_QUERY_IDS[op],
      refreshQueryIds: refresh,
      fetchImpl: f as any,
    })
    await c.createBookmark('42')
    expect(f).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('maps 429 to rate_limit with resetAt', async () => {
    const f = vi.fn(async () => res(429))
    const c = new XClient({
      getAuth: async () => auth,
      getQueryId: async (op) => DEFAULT_QUERY_IDS[op],
      fetchImpl: f as any,
    })
    // fetch mock 的 Response 没有 x-rate-limit-reset 头：resetAt 走默认 +15 分钟
    await expect(c.createBookmark('42')).rejects.toMatchObject({ code: 'rate_limit' })
  })
})

describe('bookmarkTweets', () => {
  it('bookmarks, stores a lightweight record with the auto tag, and moves to auto-foryou', async () => {
    const client = mockClient({})
    const sleeps: number[] = []
    const t = await bookmarkTweets(client, [item('101'), item('102')], {
      destination: { kind: 'folder', folder: 'auto-foryou' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(t.status).toBe('done')
    expect(t.done).toBe(2)
    expect(t.failed).toBe(0)
    expect((client.createBookmark as any).mock.calls.map((c: unknown[]) => c[0])).toEqual(['101', '102'])
    const p101 = await db.posts.get('101')
    expect(p101?.status).toBe('active')
    expect(p101?.source).toBe('bookmark')
    expect(p101?.folder).toBe('auto-foryou')
    expect(p101?.tags).toEqual(['auto'])
    // 轻量记录：文本在，互动数/媒体为空，下次同步补全
    expect(p101?.text).toBe('hello AI 大模型')
    expect(p101?.metrics.likes).toBe(0)
    expect(p101?.media).toEqual([])
    const folders = await db.folders.toArray()
    expect(folders).toContainEqual(expect.objectContaining({ name: 'auto-foryou', source: 'local' }))
    const decisions = await db.foryouDecisions.toArray()
    expect(decisions).toHaveLength(2)
    expect(decisions[0]).toMatchObject({ tweet_id: '101', decision: 'bookmark', status: 'bookmarked', destination: 'auto-foryou' })
    expect(sleeps).toEqual([0, 0])
  })

  it('records the configured gap between actions', async () => {
    const client = mockClient({})
    const sleeps: number[] = []
    await bookmarkTweets(client, [item('201'), item('202')], {
      destination: { kind: 'folder', folder: 'auto-foryou' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 5000,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(sleeps).toEqual([5000, 5000])
  })

  it('direct-bookmark destination leaves the folder empty and does not create one', async () => {
    const client = mockClient({})
    await bookmarkTweets(client, [item('301')], {
      destination: { kind: 'bookmark', folder: '' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async () => {},
    })
    expect((await db.posts.get('301'))?.folder).toBe('')
    expect(await db.folders.count()).toBe(0)
    expect((await db.foryouDecisions.get('301'))?.destination).toBe('')
  })

  it('pushes to X only when the folder has x_id and pushFolderMoveToX is on', async () => {
    await db.folders.put({ name: 'x-folder', x_id: 'col-9', source: 'x', created_at: 1 })
    const client = mockClient({})
    await bookmarkTweets(client, [item('401')], {
      destination: { kind: 'folder', folder: 'x-folder' },
      minGapMs: 5000,
      pushFolderMoveToX: true,
      gapMs: () => 0,
      sleepImpl: async () => {},
    })
    expect(client.addToFolder).toHaveBeenCalledWith('401', 'col-9')

    const client2 = mockClient({})
    await bookmarkTweets(client2, [item('402')], {
      destination: { kind: 'folder', folder: 'x-folder' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async () => {},
    })
    expect(client2.addToFolder).not.toHaveBeenCalled()
  })

  it('skips tweets that are already active bookmarks without calling X', async () => {
    await db.posts.put(seedPost('501'))
    const client = mockClient({})
    const t = await bookmarkTweets(client, [item('501'), item('502')], {
      destination: { kind: 'folder', folder: 'auto-foryou' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async () => {},
    })
    expect(client.createBookmark).toHaveBeenCalledTimes(1)
    expect((client.createBookmark as any).mock.calls[0][0]).toBe('502')
    expect(t.skipped).toBe(1)
    expect(t.status).toBe('done')
  })

  it('query_id failure marks the row failed and continues with the next tweet', async () => {
    const client = mockClient({
      createBookmark: async (id: string) => {
        if (id === '601') throw new XApiError('query_id', 'CreateBookmark 的 queryId 可能已失效')
        return { data: {} }
      },
    })
    const t = await bookmarkTweets(client, [item('601'), item('602')], {
      destination: { kind: 'folder', folder: 'auto-foryou' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async () => {},
    })
    expect(t.status).toBe('done')
    expect(t.failed).toBe(1)
    expect((await db.foryouDecisions.get('601'))).toMatchObject({ status: 'failed' })
    expect((await db.foryouDecisions.get('602'))).toMatchObject({ status: 'bookmarked' })
    expect(await db.posts.get('601')).toBeUndefined()
    expect((await db.posts.get('602'))?.folder).toBe('auto-foryou')
  })

  it('two consecutive 429s abort the batch and report the rate-limit strikes', async () => {
    const calls: string[] = []
    const strikes: number[] = []
    const client = mockClient({
      createBookmark: async (id: string) => {
        calls.push(id)
        if (id === '701') throw new XApiError('rate_limit', '触发限流', { resetAt: Date.now() + 1000 })
        return { data: {} }
      },
    })
    const sleeps: number[] = []
    const t = await bookmarkTweets(client, [item('701'), item('702')], {
      destination: { kind: 'folder', folder: 'auto-foryou' },
      minGapMs: 5000,
      pushFolderMoveToX: false,
      gapMs: () => 0,
      sleepImpl: async (ms) => {
        sleeps.push(ms)
      },
      onRateLimited: (n) => {
        strikes.push(n)
      },
    })
    // 701 第一次 429 → 等 resetAt 后队尾重试；702 成功（不把计数清零）；
    // 701 重试又 429 → 本批累计 2 次，中止
    expect(calls).toEqual(['701', '702', '701'])
    expect(strikes).toEqual([1, 2])
    expect(t.status).toBe('error')
    expect(t.error).toMatch(/触发限流 \(429\) 已达 2 次/)
    expect(sleeps).toContain(5000)
    expect((await db.posts.get('702'))?.folder).toBe('auto-foryou')
    expect((await db.foryouDecisions.get('701'))).toMatchObject({ status: 'failed' })
  })
})

describe('FORYOU_BOOKMARK dispatch', () => {
  it('enqueues bookmark decisions up to the remaining daily cap', async () => {
    await seedState({ bookmarkedToday: 4 })
    const result = (await dispatch(
      { type: 'FORYOU_BOOKMARK', items: [item('801'), item('802'), item('803')] },
      TIMELINE_SENDER,
    )) as unknown as { ok: boolean; enqueued: number; skippedCap: number; queued: number }
    expect(result.ok).toBe(true)
    expect(result.enqueued).toBe(1) // dailyCap 5 − 已收藏 4 = 1 个名额
    expect(result.skippedCap).toBe(2)
    expect(result.queued).toBe(1)
  })

  it('refuses when For You is off or a backoff is active', async () => {
    await seedState({ enabled: false })
    const off = (await dispatch({ type: 'FORYOU_BOOKMARK', items: [item('901')] }, TIMELINE_SENDER)) as unknown as {
      ok: boolean
      error: string
    }
    expect(off).toMatchObject({ ok: false, error: 'foryou-off' })

    await seedState({ backoffUntil: Date.now() + 60_000 })
    const backoff = (await dispatch({ type: 'FORYOU_BOOKMARK', items: [item('902')] }, TIMELINE_SENDER)) as unknown as {
      ok: boolean
      error: string
    }
    expect(backoff).toMatchObject({ ok: false, error: 'backoff' })
  })

  it('dedupes the queue and drops non-bookmark decisions', async () => {
    await seedState()
    const first = (await dispatch(
      { type: 'FORYOU_BOOKMARK', items: [item('911'), { ...item('912'), decision: 'hide' }] },
      TIMELINE_SENDER,
    )) as unknown as { enqueued: number }
    expect(first.enqueued).toBe(1)
    const second = (await dispatch(
      { type: 'FORYOU_BOOKMARK', items: [item('911'), item('913')] },
      TIMELINE_SENDER,
    )) as unknown as { enqueued: number; skippedDup: number }
    expect(second.enqueued).toBe(1)
    expect(second.skippedDup).toBe(1)
  })

  it('the queue survives a readRaw round-trip (normalizeState keeps foryou runtime)', async () => {
    await seedState()
    await dispatch({ type: 'FORYOU_BOOKMARK', items: [item('921')] }, TIMELINE_SENDER)
    const state = await storeTest.readRaw()
    expect((state as unknown as { foryou: { queue: { tweetId: string }[] } }).foryou.queue).toHaveLength(1)
    expect((state as unknown as { foryou: { queue: { tweetId: string }[] } }).foryou.queue[0].tweetId).toBe('921')
  })

  it('rolls the day over: yesterday’s queue and count do not carry into today', async () => {
    const state = await seedState()
    const yesterday = new Date(Date.now() - 86_400_000)
    state.foryou.day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(
      yesterday.getDate(),
    ).padStart(2, '0')}`
    state.foryou.bookmarkedToday = 5
    state.foryou.queue = [{ ...item('931'), tweetId: '931' } as never]
    holder.data['xsl'] = state
    const result = (await dispatch({ type: 'FORYOU_BOOKMARK', items: [item('932')] }, TIMELINE_SENDER)) as unknown as {
      ok: boolean
      enqueued: number
      bookmarkedToday: number
    }
    expect(result.ok).toBe(true)
    expect(result.enqueued).toBe(1)
    expect(result.bookmarkedToday).toBe(0)
    const after = await storeTest.readRaw()
    expect((after as unknown as { foryou: { queue: unknown[] } }).foryou.queue).toHaveLength(1)
  })
})
