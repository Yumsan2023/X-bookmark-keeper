import { describe, expect, it } from 'vitest'
import {
  applyDislikeFeedback,
  applyLikeFeedback,
  pruneExpiredVetoes,
  topFeedbackTokens,
  upsertAuthorVeto,
  upsertKeywordVetoes,
} from '@/foryou/feedback'
import { isFeedbackVetoed, scoreCandidate } from '@/foryou/score'
import type { ForYouProfileRow } from '@/foryou/types'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

function profile(over: Partial<ForYouProfileRow> = {}): ForYouProfileRow {
  return {
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
    ...over,
  }
}

describe('topFeedbackTokens', () => {
  it('prefers the user-configured topic keywords over tokenizer fragments', () => {
    // 分词器会把「人工智能」切成「人工」「智能」——拿这种 2 字碎片做 veto
    // 会误伤一大片，所以话题关键词（用户原词）优先。
    const tokens = topFeedbackTokens('人工智能 大模型 人工智能 大模型 散步', 3, ['人工智能', '大模型'])
    expect(tokens).toEqual(['人工智能', '大模型', '散步'])
  })

  it('falls back to tokenized words by frequency, single chars dropped', () => {
    const tokens = topFeedbackTokens('hello world hello')
    expect(tokens).toEqual(['hello', 'world'])
  })

  it('returns [] for empty text', () => {
    expect(topFeedbackTokens('')).toEqual([])
  })
})

describe('centroid feedback updates', () => {
  it('like moves the global centroid toward the feedback vector', () => {
    const next = applyLikeFeedback(profile(), [0, 1])
    // 权重 100：新质心 ≈ 归一化([100, 1])，x 仍占主导，y 变正。
    expect(next.globalCentroid[0]).toBeCloseTo(100 / Math.hypot(100, 1), 6)
    expect(next.globalCentroid[1]).toBeCloseTo(1 / Math.hypot(100, 1), 6)
    expect(next.likeCount).toBe(1)
    expect(next.tagCentroids).toEqual({})
  })

  it('like with a mismatched embedding dimension leaves the profile alone', () => {
    const p = profile()
    expect(applyLikeFeedback(p, [1, 0, 0])).toBe(p)
  })

  it('first dislike sets the negative centroid, second averages it', () => {
    const first = applyDislikeFeedback(profile(), [0, 1])
    expect(first.negCentroid).toEqual([0, 1])
    expect(first.negCount).toBe(1)
    const second = applyDislikeFeedback(first, [1, 0])
    // 均值 [0.5, 0.5] 再归一化。
    expect(second.negCentroid![0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(second.negCentroid![1]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(second.negCount).toBe(2)
  })

  it('dislike does not touch the global centroid', () => {
    const next = applyDislikeFeedback(profile(), [0, 1])
    expect(next.globalCentroid).toEqual([1, 0])
  })
})

describe('veto bookkeeping', () => {
  it('prunes expired vetoes and keeps live ones', () => {
    const kept = pruneExpiredVetoes(
      [
        { handle: 'a', until: NOW + DAY },
        { handle: 'b', until: NOW - 1 },
      ],
      NOW,
    )
    expect(kept).toEqual([{ handle: 'a', until: NOW + DAY }])
  })

  it('upserting the same author renews instead of duplicating', () => {
    const out = upsertAuthorVeto([{ handle: 'alice', until: NOW }], 'Alice', NOW + DAY)
    expect(out).toEqual([{ handle: 'alice', until: NOW + DAY }])
  })

  it('upserting keywords dedupes case-insensitively and skips short tokens', () => {
    const out = upsertKeywordVetoes([{ keyword: 'ai', until: NOW }], ['AI', '大模型', 'x'], NOW + DAY)
    expect(out).toEqual([
      { keyword: 'ai', until: NOW + DAY },
      { keyword: '大模型', until: NOW + DAY },
    ])
  })
})

describe('feedback veto penalty in scoring', () => {
  const ctx = {
    topics: [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能', '大模型'] }],
    topAuthors: null,
    medianLikes: null,
    whitelist: false,
    authorVetoes: [{ handle: 'alice', until: NOW + DAY }],
    keywordVetoes: [{ keyword: '大模型', until: NOW + DAY }],
    now: NOW,
  }
  const opts = { mode: 'rule' as const, bookmarkThreshold: 0.7, hideThreshold: 0.15, strikeVeto: false }

  it('vetoed author loses 0.3 from the rule score', () => {
    const input = { tweetId: '1', handle: 'alice', text: '今天天气真好', followed: null as boolean | null }
    expect(isFeedbackVetoed(input, ctx, NOW)).toBe(true)
    const scored = scoreCandidate(input, ctx, opts)
    // 无话题、无作者加分：规则分本应 0.20×0.5=0.10，扣 0.3 后 clamp 到 0。
    expect(scored.rule).toBeCloseTo(0, 6)
    expect(scored.reasons).toContain('feedback-veto')
  })

  it('vetoed keyword loses 0.3 from both rule and vector scores', () => {
    const input = { tweetId: '2', handle: 'bob', text: '人工智能 大模型', followed: null as boolean | null }
    const scored = scoreCandidate(input, ctx, opts, 0.9)
    // 规则分本应 0.65，扣 0.3 → 0.35；向量分 0.9 扣 0.3 → 0.6；
    // rule 模式 final 取规则分 0.35。
    expect(scored.rule).toBeCloseTo(0.35, 6)
    expect(scored.vector).toBeCloseTo(0.6, 6)
    expect(scored.final).toBeCloseTo(0.35, 6)
  })

  it('expired vetoes do not penalize', () => {
    const expired = { ...ctx, authorVetoes: [{ handle: 'alice', until: NOW - 1 }], keywordVetoes: [] }
    const input = { tweetId: '3', handle: 'alice', text: '今天天气真好', followed: null as boolean | null }
    expect(isFeedbackVetoed(input, expired, NOW)).toBe(false)
    expect(scoreCandidate(input, expired, opts).rule).toBeCloseTo(0.1, 6)
  })

  it('strike veto still forces hide even without a feedback veto', () => {
    const input = { tweetId: '4', handle: 'carol', text: '人工智能 大模型', followed: null as boolean | null }
    const scored = scoreCandidate(input, ctx, { ...opts, strikeVeto: true })
    expect(scored.decision).toBe('hide')
  })
})
