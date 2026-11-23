import { describe, expect, it } from 'vitest'
import { blend, cosine, decide, engagementScore, scoreCandidate, scoreRule, scoreVector } from '@/foryou/score'
import type { ForYouProfileRow, ForYouScoreContext, ForYouScoreInput } from '@/foryou/types'

const profile = (over: Partial<ForYouProfileRow> = {}): ForYouProfileRow => ({
  key: 'profile',
  dim: 2,
  model: 'bge-m3',
  endpoint: 'http://127.0.0.1:1234/v1',
  globalCentroid: [1, 0],
  tagCentroids: { AI: [1, 0] },
  negCentroid: null,
  negCount: 0,
  topAuthors: [],
  medianLikes: null,
  medianViews: null,
  sampleSize: 100,
  holdoutIds: [],
  builtAt: 1,
  msTaken: 1,
  ...over,
})

const baseInput = (over: Partial<ForYouScoreInput> = {}): ForYouScoreInput => ({
  tweetId: '1',
  handle: 'alice',
  text: 'hello world',
  followed: null,
  ...over,
})

const baseCtx = (over: Partial<ForYouScoreContext> = {}): ForYouScoreContext => ({
  topics: [],
  topAuthors: null,
  medianLikes: null,
  whitelist: false,
  ...over,
})

const opts = { mode: 'rule' as const, bookmarkThreshold: 0.7, hideThreshold: 0.15, strikeVeto: false }

describe('foryou rule scoring', () => {
  it('scores 0.10 with no topics, no author bonus, neutral engagement', () => {
    // 0.55*0 + 0.25*0 + 0.20*0.5 = 0.10
    const { score } = scoreRule(baseInput(), baseCtx())
    expect(score).toBeCloseTo(0.1, 6)
    expect(scoreCandidate(baseInput(), baseCtx(), opts).decision).toBe('hide')
  })

  it('matches one CJK keyword, saturates at two hits', () => {
    const ctx = baseCtx({
      topics: [{ id: 'ai', label: 'AI/技术', weight: 1, keywords: ['人工智能', '大模型'] }],
    })
    const one = scoreRule(baseInput({ text: '人工智能改变世界' }), ctx)
    // topic 0.5 * 0.55 + engagement 0.1 = 0.375
    expect(one.score).toBeCloseTo(0.375, 6)
    expect(one.hitTopicIds).toEqual(['ai'])
    const two = scoreRule(baseInput({ text: '人工智能与大模型' }), ctx)
    // topic 1 * 0.55 + 0.1 = 0.65
    expect(two.score).toBeCloseTo(0.65, 6)
  })

  it('matches ASCII keywords by token, not substring', () => {
    const ctx = baseCtx({
      topics: [{ id: 'ai', label: 'AI', weight: 1, keywords: ['ai'] }],
    })
    expect(scoreRule(baseInput({ text: 'said the model' }), ctx).hitTopicIds).toEqual([])
    expect(scoreRule(baseInput({ text: 'AI agents are coming' }), ctx).hitTopicIds).toEqual(['ai'])
    expect(scoreRule(baseInput({ text: 'an AI-first workflow' }), ctx).hitTopicIds).toEqual(['ai'])
  })

  it('matches multi-word keywords by word boundary', () => {
    const ctx = baseCtx({
      topics: [{ id: 'ml', label: 'ML', weight: 1, keywords: ['machine learning'] }],
    })
    expect(scoreRule(baseInput({ text: 'machine learning basics' }), ctx).hitTopicIds).toEqual(['ml'])
    expect(scoreRule(baseInput({ text: 'machines learn fast' }), ctx).hitTopicIds).toEqual([])
  })

  it('takes the max topic score and applies the weight', () => {
    const ctx = baseCtx({
      topics: [
        { id: 'low', label: 'Low', weight: 0.5, keywords: ['猫'] },
        { id: 'high', label: 'High', weight: 2, keywords: ['狗'] },
      ],
    })
    const { score, hitTopicIds } = scoreRule(baseInput({ text: '猫和狗' }), ctx)
    // topic max(0.5*0.5, 2*0.5)=1 * 0.55 + 0.1 = 0.65
    expect(score).toBeCloseTo(0.65, 6)
    expect(hitTopicIds).toEqual(['low', 'high'])
  })

  it('ignores quoted text for scoring only when absent, includes it when present', () => {
    const ctx = baseCtx({
      topics: [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能'] }],
    })
    const withQuote = scoreRule(baseInput({ text: '转一个', quotedText: '人工智能报告' }), ctx)
    expect(withQuote.hitTopicIds).toEqual(['ai'])
  })

  it('adds author bonuses and caps at 0.90', () => {
    const ctx = baseCtx({ whitelist: true, topAuthors: new Set(['alice']) })
    const { score, reasons } = scoreRule(baseInput({ followed: true }), ctx)
    // author min(0.3+0.4+0.2, 0.9)=0.9 * 0.25 + 0.1 = 0.325
    expect(score).toBeCloseTo(0.325, 6)
    expect(reasons).toContain('followed')
    expect(reasons).toContain('top-author')
    expect(reasons).toContain('whitelist')
  })

  it('scores engagement neutral when likes or median are missing', () => {
    expect(engagementScore(null, 100)).toBe(0.5)
    expect(engagementScore(100, null)).toBe(0.5)
    expect(engagementScore(100, 0)).toBe(0.5)
    expect(engagementScore(-5, 100)).toBe(0.5)
  })

  it('scores engagement on the log ratio when both are present', () => {
    // log10(1+999)/log10(1+99) = 3/2 -> clamped to 1
    expect(engagementScore(999, 99)).toBeCloseTo(1, 6)
    // log10(1+9)/log10(1+99) = 1/2
    expect(engagementScore(9, 99)).toBeCloseTo(0.5, 6)
  })

  it('decides on the 0.70 / 0.15 boundaries', () => {
    expect(decide(0.7, opts)).toBe('bookmark')
    expect(decide(0.6999, opts)).toBe('leave')
    expect(decide(0.15, opts)).toBe('hide')
    expect(decide(0.1501, opts)).toBe('leave')
    expect(decide(0.5, opts)).toBe('leave')
  })

  it('forces hide on a strike veto even above the bookmark threshold', () => {
    expect(decide(0.99, { ...opts, strikeVeto: true })).toBe('hide')
  })

  it('bookmarks at a full house: two topic hits + followed + whitelist', () => {
    const ctx = baseCtx({
      topics: [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }],
      whitelist: true,
    })
    const result = scoreCandidate(baseInput({ text: '人工智能与大模型', followed: true }), ctx, opts)
    // 0.55*1 + 0.25*0.5 + 0.20*0.5 = 0.775
    expect(result.final).toBeCloseTo(0.775, 6)
    expect(result.decision).toBe('bookmark')
    expect(result.rule).toBeCloseTo(0.775, 6)
    expect(result.vector).toBeNull()
  })
})

describe('foryou blend', () => {
  it('falls back to rule when the vector is missing, in any mode', () => {
    expect(blend(0.6, null, 'rule').final).toBeCloseTo(0.6, 6)
    expect(blend(0.6, null, 'hybrid').final).toBeCloseTo(0.6, 6)
    expect(blend(0.6, null, 'vector').final).toBeCloseTo(0.6, 6)
    expect(blend(null, null, 'rule').final).toBe(0)
  })

  it('uses the vector directly in vector mode and averages in hybrid mode', () => {
    expect(blend(0.6, 0.8, 'vector').final).toBeCloseTo(0.8, 6)
    expect(blend(0.6, 0.8, 'hybrid').final).toBeCloseTo(0.7, 6)
    expect(blend(0.6, 0.8, 'rule').final).toBeCloseTo(0.6, 6)
  })
})

describe('foryou cosine', () => {
  it('returns 1 for identical vectors, 0 for orthogonal, 0 for empty or zero', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1, 6)
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 2], [1])).toBe(0)
  })
})

describe('foryou vector scoring (M3)', () => {
  it('maps an identical embedding to 1 and an orthogonal one low', () => {
    // sim_blend = 0.6*1 + 0.4*1 = 1 → (1-0.30)/0.45 = 1.55 → clamped to 1
    expect(scoreVector([1, 0], profile())?.score).toBeCloseTo(1, 6)
    // sim_blend = 0 → (0-0.30)/0.45 < 0 → clamped to 0
    expect(scoreVector([0, 1], profile())?.score).toBeCloseTo(0, 6)
  })

  it('blends global and tag similarity, and subtracts the negative centroid', () => {
    // global [1,0] vs [0.6,0.8]: sim_global 0.6; tag centroid [0,1]: sim_tag 0.8
    // sim_blend = 0.6*0.6 + 0.4*0.8 = 0.68 → (0.68-0.30)/0.45 = 0.844
    const p = profile({ tagCentroids: { AI: [0, 1] } })
    expect(scoreVector([0.6, 0.8], p)?.score).toBeCloseTo(0.8444, 3)
    expect(scoreVector([0.6, 0.8], p)?.simGlobal).toBeCloseTo(0.6, 6)
    expect(scoreVector([0.6, 0.8], p)?.simTag).toBeCloseTo(0.8, 6)
    // neg centroid identical to the embedding: sim_neg 1 → sim_blend 0.68-0.3 = 0.38 → 0.178
    const withNeg = profile({ tagCentroids: { AI: [0, 1] }, negCentroid: [0.6, 0.8], negCount: 3 })
    expect(scoreVector([0.6, 0.8], withNeg)?.score).toBeCloseTo(0.1778, 3)
  })

  it('returns null without a profile, with a dimension mismatch, or with no tag centroids', () => {
    expect(scoreVector([1, 0], null)).toBeNull()
    expect(scoreVector([1, 0, 0], profile())).toBeNull()
    expect(scoreVector([1, 0], profile({ globalCentroid: [] }))).toBeNull()
    // no tag centroids: sim_tag 0, sim_blend = 0.6 → (0.6-0.30)/0.45 = 0.667
    expect(scoreVector([1, 0], profile({ tagCentroids: {} }))?.score).toBeCloseTo(0.6667, 3)
  })

  it('scoreCandidate blends the vector in hybrid/vector mode and degrades without it', () => {
    const hybrid = { mode: 'hybrid' as const, bookmarkThreshold: 0.7, hideThreshold: 0.15, strikeVeto: false }
    // rule 0.10 (no topics) + vector 1.0 → hybrid 0.55 → leave
    const mixed = scoreCandidate(baseInput(), baseCtx(), hybrid, 1)
    expect(mixed.vector).toBeCloseTo(1, 6)
    expect(mixed.final).toBeCloseTo(0.55, 6)
    expect(mixed.decision).toBe('leave')
    const vectorOnly = scoreCandidate(baseInput(), baseCtx(), { ...hybrid, mode: 'vector' }, 1)
    expect(vectorOnly.final).toBeCloseTo(1, 6)
    expect(vectorOnly.decision).toBe('bookmark')
    // vector null → hybrid degrades to rule
    expect(scoreCandidate(baseInput(), baseCtx(), hybrid, null).final).toBeCloseTo(0.1, 6)
  })
})
