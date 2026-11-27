import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyMark,
  defaultSettings,
  freshState,
  parseTopicsText,
  sanitizeSettings,
  setWhitelist,
  topicsToText,
} from '@/strike/lib/pure.js'
import { dispatch } from '@/strike/lib/store.js'
import { db } from '@/db/db'
import { clearAll } from '@/db/posts'
import type { Post } from '@/shared/types'

type DispatchResult = {
  ok?: boolean
  error?: string
  results?: { tweetId: string; handle: string; final: number; decision: string; rule: number | null; vector?: number | null }[]
  tags?: string[]
}

async function callDispatch(message: Record<string, unknown>, sender: Record<string, unknown>): Promise<DispatchResult> {
  return (await dispatch(message, sender)) as unknown as DispatchResult
}

const NOW = 1_700_000_000_000
const INTERNAL = { internal: true } as const

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
    sendMessage(message: unknown, callback?: (result: unknown) => void) {
      void dispatch(message, { internal: true }).then((result) => callback?.(result))
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local }, runtime }
}

function post(id: string, tags: string[]): Post {
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
    folder: 'Dev',
    tags,
    status: 'active',
    saved_at: 1,
    sync_run: 'r',
    url: `https://x.com/alice/status/${id}`,
    source: 'bookmark',
    accounts: ['alice'],
    note: '',
  }
}

async function seedState(topics: { id: string; label: string; weight: number; keywords: string[] }[] = []) {
  const state = freshState(NOW)
  state.settings.foryou.topics = topics
  holder.data['xsl'] = state
  return state
}

describe('foryou settings', () => {
  it('defaults to hybrid mode, hide 0.15, trial cap 5, auto-foryou folder', () => {
    const fy = defaultSettings().foryou
    expect(fy.enabled).toBe(false)
    // M3: 默认改回 hybrid（设计 §4.2）；画像未建好时自动退化为规则版。
    expect(fy.mode).toBe('hybrid')
    expect(fy.bookmarkThreshold).toBe(0.7)
    expect(fy.hideThreshold).toBe(0.15)
    expect(fy.showScoreChip).toBe(true)
    expect(fy.autoScroll).toBe(true)
    expect(fy.dailyCap).toBe(5)
    expect(fy.minGapMs).toBe(5000)
    expect(fy.destination).toEqual({ kind: 'folder', folder: 'auto-foryou' })
    expect(fy.topics).toEqual([])
    expect(fy.embed).toEqual({ endpoint: 'http://127.0.0.1:1234/v1', model: 'bge-m3' })
  })

  it('adds foryou defaults when old settings lack them', () => {
    const prev = defaultSettings()
    delete (prev as unknown as Record<string, unknown>).foryou
    const { settings } = sanitizeSettings(prev, {})
    expect(settings.foryou.enabled).toBe(false)
    expect(settings.foryou.dailyCap).toBe(5)
  })

  it('clamps thresholds, cap, mode, folder and embed endpoint', () => {
    const { settings, warnings } = sanitizeSettings(defaultSettings(), {
      foryou: {
        mode: 'bogus',
        bookmarkThreshold: 0.5,
        hideThreshold: 0.8,
        dailyCap: 0,
        minGapMs: 50,
        destination: { kind: 'folder', folder: 'timeline:@x' },
        embed: { endpoint: 'https://evil.example/v1', model: 'other' },
      },
    })
    // 非法 mode 时保留 base 的默认值（M3 起为 hybrid）
    expect(settings.foryou.mode).toBe('hybrid')
    expect(settings.foryou.bookmarkThreshold).toBe(0.5)
    // hide 0.8 >= bookmark 0.5 -> pulled below the bookmark threshold
    expect(settings.foryou.hideThreshold).toBeLessThan(0.5)
    expect(settings.foryou.dailyCap).toBe(1)
    expect(settings.foryou.minGapMs).toBe(1000)
    expect(settings.foryou.destination.folder).toBe('auto-foryou')
    expect(settings.foryou.embed.endpoint).toBe('http://127.0.0.1:1234/v1')
    expect(settings.foryou.embed.model).toBe('other')
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('accepts a loopback embed endpoint and a folder destination', () => {
    const { settings, warnings } = sanitizeSettings(defaultSettings(), {
      foryou: {
        mode: 'hybrid',
        destination: { kind: 'folder', folder: 'my-foryou' },
        embed: { endpoint: 'http://localhost:1234/v1' },
      },
    })
    expect(settings.foryou.mode).toBe('hybrid')
    expect(settings.foryou.destination).toEqual({ kind: 'folder', folder: 'my-foryou' })
    expect(settings.foryou.embed.endpoint).toBe('http://localhost:1234/v1')
    expect(warnings).toEqual([])
  })

  it('sanitizes topics: dedupes keywords, caps 30 topics / 50 keywords', () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: `t${i}`,
      label: `T${i}`,
      weight: 1,
      keywords: ['AI', 'ai', '人工智能'],
    }))
    const { settings } = sanitizeSettings(defaultSettings(), { foryou: { topics: many } })
    expect(settings.foryou.topics).toHaveLength(30)
    expect(settings.foryou.topics[0].keywords).toEqual(['AI', '人工智能'])
  })
})

describe('foryou topics text format', () => {
  it('round-trips topics through text', () => {
    const text = 'AI/技术 | 1 | 人工智能, 大模型\n生活 | 0.5 | 旅行, 美食'
    const parsed = parseTopicsText(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.topics).toHaveLength(2)
    expect(parsed.topics[0].label).toBe('AI/技术')
    expect(parsed.topics[0].keywords).toEqual(['人工智能', '大模型'])
    expect(parsed.topics[1].weight).toBe(0.5)
    expect(topicsToText(parsed.topics)).toBe(text)
  })

  it('skips blanks and comments, defaults weight to 1', () => {
    const parsed = parseTopicsText('# 注释\n\n幽默 | 搞笑, 段子')
    expect(parsed.topics).toHaveLength(1)
    expect(parsed.topics[0].weight).toBe(1)
  })
})

describe('foryou dispatch', () => {
  beforeEach(async () => {
    installChrome()
    await clearAll()
  })

  it('scores a batch: topic hit bookmarks, no hit hides, invalid items skipped', async () => {
    await seedState([{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }])
    const result = await callDispatch(
      {
        type: 'FORYOU_SCORE',
        items: [
          { tweetId: '1', handle: 'alice', text: '人工智能与大模型', followed: true },
          { tweetId: '2', handle: 'bob', text: '今天天气真好' },
          { tweetId: '', handle: 'carol', text: '人工智能' },
          { tweetId: '4', handle: '', text: '人工智能' },
        ],
      },
      INTERNAL,
    )
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results![0]).toMatchObject({ tweetId: '1', decision: 'bookmark' })
    // 0.55*1 + 0.25*0.3 (followed) + 0.20*0.5 = 0.725
    expect(result.results![0].final).toBeCloseTo(0.725, 6)
    expect(result.results![1]).toMatchObject({ tweetId: '2', decision: 'hide' })
    expect(result.results![1].final).toBeCloseTo(0.1, 6)
  })

  it('vetoes a strike-flagged author even with a high score', async () => {
    const state = freshState(NOW)
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    for (const tweetId of ['10', '11', '12']) {
      applyMark(state, { tag: 'Spam', handle: 'spammer', tweetId, textSnippet: 'buy followers' }, NOW)
    }
    holder.data['xsl'] = state
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '20', handle: 'spammer', text: '人工智能与大模型', followed: true }] },
      INTERNAL,
    )
    expect(result.results![0].decision).toBe('hide')
  })

  it('does not veto a whitelisted author', async () => {
    const state = freshState(NOW)
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    for (const tweetId of ['10', '11', '12']) {
      applyMark(state, { tag: 'Spam', handle: 'spammer', tweetId, textSnippet: 'buy followers' }, NOW)
    }
    setWhitelist(state, { userId: 'h:spammer', handle: 'spammer', whitelist: true }, NOW)
    holder.data['xsl'] = state
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '20', handle: 'spammer', text: '人工智能与大模型', followed: true }] },
      INTERNAL,
    )
    expect(result.results![0].decision).toBe('bookmark')
  })

  it('rejects FORYOU_SCORE from an unrelated sender', async () => {
    await seedState()
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '1', handle: 'alice', text: 'hi' }] },
      { url: 'https://evil.example/' },
    )
    expect(result.ok).toBe(false)
  })

  it('returns library tags for the topics import button', async () => {
    await db.posts.bulkPut([post('1', ['AI/技术', '工具教程']), post('2', ['生活', 'AI/技术'])])
    const result = await callDispatch({ type: 'FORYOU_TAGS' }, INTERNAL)
    expect(result.ok).toBe(true)
    expect(result.tags).toContain('AI/技术')
    expect(result.tags).toContain('工具教程')
    expect(result.tags).toContain('生活')
  })
})

describe('foryou vector scoring in dispatch (M3)', () => {
  const originalFetch = globalThis.fetch

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await db.foryouProfile.clear()
  })

  beforeEach(async () => {
    installChrome()
    await clearAll()
  })

  async function seedProfile() {
    await db.foryouProfile.put({
      key: 'profile',
      dim: 2,
      model: 'bge-m3',
      endpoint: 'http://127.0.0.1:1234/v1',
      globalCentroid: [1, 0],
      tagCentroids: { AI: [1, 0] },
      negCentroid: null,
      negCount: 0,
      topAuthors: ['alice'],
      medianLikes: 10,
      medianViews: 100,
      sampleSize: 100,
      holdoutIds: ['99'],
      builtAt: NOW,
      msTaken: 100,
    })
  }

  function mockEmbeddingFetch(vector: number[]) {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ data: [{ embedding: vector }] }),
      } as unknown as Response
    }) as unknown as typeof fetch
    return calls
  }

  it('blends the vector score in hybrid mode when a profile is built', async () => {
    await seedProfile()
    const state = freshState(NOW)
    state.settings.foryou.mode = 'hybrid'
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    holder.data['xsl'] = state
    const calls = mockEmbeddingFetch([1, 0])
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '1', handle: 'alice', text: '人工智能与大模型', followed: true }] },
      INTERNAL,
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/embeddings')
    // rule 0.55*1 + 0.25*(0.3 followed + 0.4 top-author) + 0.20*0.5 = 0.825;
    // vector 1.0 (identical to centroid) → hybrid 0.5*0.825 + 0.5*1 = 0.9125
    expect(result.results![0].rule).toBeCloseTo(0.825, 6)
    expect(result.results![0].vector).toBeCloseTo(1, 6)
    // v2 hybrid formula: max(0.92*1, 0.45*0.825 + 0.55*1) = 0.92125
    expect(result.results![0].final).toBeCloseTo(0.92125, 6)
    expect(result.results![0].decision).toBe('bookmark')
    expect((result as { vectorAvailable?: boolean }).vectorAvailable).toBe(true)
  })

  it('degrades to rule scoring in hybrid mode when no profile is built', async () => {
    const state = freshState(NOW)
    state.settings.foryou.mode = 'hybrid'
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    holder.data['xsl'] = state
    const calls = mockEmbeddingFetch([1, 0])
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '1', handle: 'alice', text: '人工智能与大模型', followed: true }] },
      INTERNAL,
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(0)
    expect(result.results![0].vector).toBeNull()
    expect(result.results![0].final).toBeCloseTo(0.725, 6)
  })

  it('degrades to rule scoring when the embedding endpoint is down', async () => {
    await seedProfile()
    const state = freshState(NOW)
    state.settings.foryou.mode = 'hybrid'
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    holder.data['xsl'] = state
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const result = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '1', handle: 'alice', text: '人工智能与大模型', followed: true }] },
      INTERNAL,
    )
    expect(result.ok).toBe(true)
    expect(result.results![0].vector).toBeNull()
    // 画像已建，规则分含常收藏作者加分：0.55 + 0.25×(0.3+0.4) + 0.20×0.5 = 0.825
    expect(result.results![0].rule).toBeCloseTo(0.825, 6)
    expect(result.results![0].final).toBeCloseTo(0.825, 6)
    expect((result as { vectorError?: string }).vectorError).toBeTruthy()
  })
})
