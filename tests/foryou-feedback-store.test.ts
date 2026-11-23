import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { dispatch } from '@/strike/lib/store.js'
import { freshState } from '@/strike/lib/pure.js'
import { db } from '@/db/db'
import { clearAll } from '@/db/posts'

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

type AnyResult = Record<string, unknown> & { ok?: boolean; error?: string }

async function callDispatch(message: Record<string, unknown>, sender: Record<string, unknown>): Promise<AnyResult> {
  return (await dispatch(message, sender)) as unknown as AnyResult
}

async function seedProfile() {
  await db.foryouProfile.put({
    key: 'profile',
    dim: 2,
    model: 'bge-m3',
    endpoint: 'http://127.0.0.1:1234/v1',
    globalCentroid: [1, 0],
    tagCentroids: {},
    negCentroid: null,
    negCount: 0,
    topAuthors: [],
    medianLikes: null,
    medianViews: null,
    sampleSize: 100,
    holdoutIds: [],
    builtAt: NOW,
    msTaken: 10,
  })
}

describe('FORYOU_FEEDBACK dispatch (M4)', () => {
  beforeEach(async () => {
    installChrome()
    await clearAll()
    await db.foryouProfile.clear()
    await db.foryouDecisions.clear()
    await db.foryouValidations.clear()
    const state = freshState(NOW)
    state.settings.foryou.enabled = true
    state.settings.foryou.vetoCooldownDays = 14
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    holder.data['xsl'] = state
  })

  it('dislike records feedback, updates the negative centroid, and writes vetoes', async () => {
    await seedProfile()
    await db.foryouDecisions.put({
      tweet_id: '42',
      at: NOW,
      rule: 0.8,
      vector: 0.9,
      final: 0.85,
      decision: 'bookmark',
      reasons: [],
      destination: 'auto-foryou',
      status: 'bookmarked',
      vectorCache: [0, 1],
      handle: 'alice',
      textSnippet: '人工智能 大模型 散步',
    })
    const res = await callDispatch(
      { type: 'FORYOU_FEEDBACK', tweetId: '42', kind: 'dislike', handle: 'alice', text: '人工智能 大模型 散步' },
      INTERNAL,
    )
    expect(res.ok).toBe(true)
    expect(res.profileUpdated).toBe(true)
    expect(res.vetoed).toBe(true)

    const profile = await db.foryouProfile.get('profile')
    expect(profile?.negCentroid).toEqual([0, 1])
    expect(profile?.negCount).toBe(1)
    // dislike 不取消收藏：决策行仍是 bookmarked，只是多了 feedback。
    const row = await db.foryouDecisions.get('42')
    expect(row?.feedback).toBe('dislike')
    expect(row?.status).toBe('bookmarked')

    const editor = await callDispatch({ type: 'GET_EDITOR' }, INTERNAL)
    const fy = (editor.settings as { foryou: { authorVetoes: { handle: string; until: number }[]; keywordVetoes: { keyword: string; until: number }[] } }).foryou
    expect(fy.authorVetoes.map((v) => v.handle)).toContain('alice')
    expect(fy.keywordVetoes.map((v) => v.keyword)).toContain('人工智能')
  })

  it('a vetoed author scores 0.3 lower on the next FORYOU_SCORE', async () => {
    await seedProfile()
    await db.foryouDecisions.put({
      tweet_id: '42',
      at: NOW,
      rule: 0.8,
      vector: null,
      final: 0.85,
      decision: 'bookmark',
      reasons: [],
      destination: '',
      status: 'bookmarked',
      handle: 'alice',
      textSnippet: '人工智能 大模型',
    })
    await callDispatch(
      { type: 'FORYOU_FEEDBACK', tweetId: '42', kind: 'dislike', handle: 'alice', text: '人工智能 大模型' },
      INTERNAL,
    )
    const res = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '43', handle: 'alice', text: '人工智能 大模型', followed: false }] },
      INTERNAL,
    )
    const scored = (res.results as { rule: number; final: number }[])[0]
    // 话题满分 rule 本应 0.65（0.55 + 0.20×0.5），作者 veto 扣 0.3 → 0.35。
    expect(scored.rule).toBeCloseTo(0.35, 6)
    expect(scored.final).toBeCloseTo(0.35, 6)
  })

  it('like without a profile still records feedback but does not update a centroid', async () => {
    const res = await callDispatch(
      { type: 'FORYOU_FEEDBACK', tweetId: '7', kind: 'like', handle: 'bob', text: '人工智能' },
      INTERNAL,
    )
    expect(res.ok).toBe(true)
    expect(res.profileUpdated).toBe(false)
    expect(res.vetoed).toBe(false)
    const row = await db.foryouDecisions.get('7')
    expect(row?.feedback).toBe('like')
  })

  it('rejects feedback with a bad kind or missing tweetId', async () => {
    expect((await callDispatch({ type: 'FORYOU_FEEDBACK', tweetId: '1', kind: 'meh' }, INTERNAL)).ok).toBe(false)
    expect((await callDispatch({ type: 'FORYOU_FEEDBACK', kind: 'like' }, INTERNAL)).ok).toBe(false)
  })

  it('rejects feedback from an unrelated sender', async () => {
    const res = await callDispatch(
      { type: 'FORYOU_FEEDBACK', tweetId: '1', kind: 'like' },
      { url: 'https://evil.example/' },
    )
    expect(res.ok).toBe(false)
  })
})

describe('FORYOU_APPLY_VALIDATION dispatch (M4)', () => {
  beforeEach(async () => {
    installChrome()
    await clearAll()
    await db.foryouValidations.clear()
    const state = freshState(NOW)
    holder.data['xsl'] = state
  })

  it('applies the suggested thresholds to settings', async () => {
    await db.foryouValidations.put({
      id: 'v-1',
      at: NOW,
      mode: 'rule',
      nPos: 10,
      nNeg: 10,
      thresholds: [],
      suggested: { bookmark: 0.6, hide: 0.25 },
      degraded: false,
      posMedian: 0.5,
      posP10: 0.2,
      notes: '',
    })
    const res = await callDispatch({ type: 'FORYOU_APPLY_VALIDATION', id: 'v-1' }, INTERNAL)
    expect(res.ok).toBe(true)
    expect(res.bookmarkThreshold).toBe(0.6)
    expect(res.hideThreshold).toBe(0.25)
  })

  it('refuses when there is no suggestion (degraded report)', async () => {
    await db.foryouValidations.put({
      id: 'v-2',
      at: NOW,
      mode: 'rule',
      nPos: 10,
      nNeg: 1,
      thresholds: [],
      suggested: null,
      degraded: true,
      posMedian: 0.5,
      posP10: 0.2,
      notes: '负样本不足',
    })
    const res = await callDispatch({ type: 'FORYOU_APPLY_VALIDATION', id: 'v-2' }, INTERNAL)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('no-suggestion')
  })

  it('refuses an unknown validation id and a non-editor sender', async () => {
    expect((await callDispatch({ type: 'FORYOU_APPLY_VALIDATION', id: 'v-nope' }, INTERNAL)).ok).toBe(false)
    await db.foryouValidations.put({
      id: 'v-3',
      at: NOW,
      mode: 'rule',
      nPos: 10,
      nNeg: 10,
      thresholds: [],
      suggested: { bookmark: 0.6, hide: 0.25 },
      degraded: false,
      posMedian: 0.5,
      posP10: 0.2,
      notes: '',
    })
    const res = await callDispatch({ type: 'FORYOU_APPLY_VALIDATION', id: 'v-3' }, { url: 'https://x.com/home' })
    expect(res.ok).toBe(false)
  })
})

describe('FORYOU_SCORE records decisions for the panel (M4)', () => {
  beforeEach(async () => {
    installChrome()
    await clearAll()
    await db.foryouDecisions.clear()
    const state = freshState(NOW)
    state.settings.foryou.enabled = true
    state.settings.foryou.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }]
    holder.data['xsl'] = state
  })

  it('writes a decision row with handle and text snippet', async () => {
    const res = await callDispatch(
      { type: 'FORYOU_SCORE', items: [{ tweetId: '9', handle: 'alice', text: '人工智能 大模型', followed: true }] },
      INTERNAL,
    )
    expect(res.ok).toBe(true)
    const row = await db.foryouDecisions.get('9')
    expect(row?.handle).toBe('alice')
    expect(row?.textSnippet).toBe('人工智能 大模型')
    expect(row?.decision).toBe('bookmark')
    expect(row?.final).toBeCloseTo(0.65 + 0.25 * 0.3, 6)
  })
})
