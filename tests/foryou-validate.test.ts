import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeThresholdRows,
  median,
  percentile,
  suggestThresholds,
} from '@/foryou/validate'
import { validateJob } from '@/foryou/runner'
import { defaultForYouSettings, type ForYouProfileRow, type ForYouValidationRow } from '@/foryou/types'

const NOW = 1_700_000_000_000

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
    holdoutIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12'],
    builtAt: NOW,
    msTaken: 10,
    ...over,
  }
}

function settings() {
  const s = defaultForYouSettings()
  s.mode = 'rule'
  s.topics = [{ id: 'ai', label: 'AI', weight: 1, keywords: ['人工智能'] }]
  return s
}

describe('computeThresholdRows', () => {
  // 正样本 10 条：8 条 0.9、2 条 0.1；负样本 10 条：1 条 0.9、9 条 0.1。
  const pos = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1]
  const neg = [0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]

  it('computes precision/recall/F1 and hide kill rate per combo', () => {
    const rows = computeThresholdRows(pos, neg)
    expect(rows).toHaveLength(4 * 3)
    const r = rows.find((x) => x.bookmark === 0.5 && x.hide === 0.15)!
    // TP=8, FP=1 → P=8/9, R=0.8, F1=2·(8/9)·0.8/(8/9+0.8)；hide 误杀=2/10=0.2
    expect(r.precision).toBeCloseTo(8 / 9, 6)
    expect(r.recall).toBeCloseTo(0.8, 6)
    expect(r.f1).toBeCloseTo((2 * (8 / 9) * 0.8) / (8 / 9 + 0.8), 6)
    expect(r.hideKillRate).toBeCloseTo(0.2, 6)
  })

  it('returns 0 precision/recall/F1 when nothing is predicted bookmark', () => {
    const rows = computeThresholdRows([0.1], [0.1])
    const r = rows.find((x) => x.bookmark === 0.8)!
    expect(r.precision).toBe(0)
    expect(r.recall).toBe(0)
    expect(r.f1).toBe(0)
  })

  it('suggests the max-F1 combo under the 5% hide-kill cap', () => {
    const rows = computeThresholdRows(pos, neg)
    // hide 0.15 时误杀 0.2（超标），hide 0.25/0.35 时误杀仍 0.2——
    // 这里所有组合都不满足 <5%，所以不建议。
    expect(suggestThresholds(rows)).toBeNull()
  })

  it('suggests max F1 when a combo satisfies the cap, ties prefer higher recall', () => {
    const cleanPos = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8, 0.8]
    const cleanNeg = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]
    const rows = computeThresholdRows(cleanPos, cleanNeg)
    const s = suggestThresholds(rows)
    expect(s).toEqual({ bookmark: 0.5, hide: 0.15 })
  })
})

describe('median / percentile', () => {
  it('median and p10 of the positives distribution', () => {
    expect(median([0.1, 0.9, 0.5])).toBeCloseTo(0.5, 6)
    expect(median([])).toBeNull()
    expect(percentile([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], 10)).toBeCloseTo(0.2, 6)
    expect(percentile([], 10)).toBeNull()
  })
})

describe('validateJob', () => {
  beforeEach(() => {
    // validateJob 的注入路径不碰 chrome / 真实 Dexie（saveFn 捕获行）。
  })

  function sample(id: string, text: string) {
    return { tweet_id: id, text, screen_name: 'alice' }
  }

  it('rule mode: scores samples and persists a suggested threshold', async () => {
    const saved: ForYouValidationRow[] = []
    // 正样本命中 2 个关键词 → 话题满分，rule = 0.55 + 0.20×0.5 = 0.65；
    // 负样本无命中，rule = 0.10。bookmark 0.5/0.6 时 P=R=F1=1，误杀 0。
    // 注意：负样本要 ≥100 条，否则按设计 §3.4 降级为仅正样本分布报告。
    const pos = Array.from({ length: 120 }, (_, i) => sample(`p${i}`, '人工智能 大模型'))
    const neg = Array.from({ length: 120 }, (_, i) => sample(`n${i}`, '今天天气真好去散步'))
    const { validation, degraded } = await validateJob({
      mode: 'rule',
      settingsFn: async () => settings(),
      profileFn: async () => undefined,
      loadPositivesFn: async () => pos,
      loadNegativesFn: async () => neg,
      saveFn: async (row) => {
        saved.push(row)
      },
      now: () => NOW,
    })
    expect(degraded).toBe(false)
    expect(validation.nPos).toBe(120)
    expect(validation.nNeg).toBe(120)
    expect(validation.thresholds).toHaveLength(12)
    // 正样本含关键词得分高、负样本低 → 应有建议阈值且误杀率 <5%。
    expect(validation.suggested).toEqual({ bookmark: 0.5, hide: 0.15 })
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(`v-${NOW}`)
  })

  it('degrades to positives-only when negatives are under 100', async () => {
    const saved: ForYouValidationRow[] = []
    const pos = Array.from({ length: 12 }, (_, i) => sample(`p${i}`, '人工智能与大模型'))
    const { validation, degraded } = await validateJob({
      mode: 'rule',
      settingsFn: async () => settings(),
      profileFn: async () => undefined,
      loadPositivesFn: async () => pos,
      loadNegativesFn: async () => [sample('n0', '散步')],
      saveFn: async (row) => {
        saved.push(row)
      },
      now: () => NOW,
    })
    expect(degraded).toBe(true)
    expect(validation.suggested).toBeNull()
    expect(validation.thresholds).toEqual([])
    expect(validation.posMedian).not.toBeNull()
    expect(validation.posP10).not.toBeNull()
    expect(validation.notes).toMatch(/负样本只有 1 条/)
  })

  it('hybrid mode without a profile falls back to rule mode', async () => {
    const pos = Array.from({ length: 12 }, (_, i) => sample(`p${i}`, '人工智能'))
    const { validation } = await validateJob({
      mode: 'hybrid',
      settingsFn: async () => ({ ...settings(), mode: 'hybrid' as const }),
      profileFn: async () => undefined,
      loadPositivesFn: async () => pos,
      loadNegativesFn: async () => Array.from({ length: 12 }, (_, i) => sample(`n${i}`, '散步')),
      saveFn: async () => {},
      now: () => NOW,
    })
    expect(validation.mode).toBe('rule')
    expect(validation.notes).toMatch(/退回规则版/)
  })

  it('hybrid mode without enough holdout throws instead of leaking train data', async () => {
    await expect(
      validateJob({
        mode: 'hybrid',
        settingsFn: async () => ({ ...settings(), mode: 'hybrid' as const }),
        profileFn: async () => profile({ holdoutIds: ['only-one'] }),
        saveFn: async () => {},
        now: () => NOW,
      }),
    ).rejects.toThrow(/holdout/)
  })

  it('aborts when the signal is cancelled before scoring', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      validateJob({
        mode: 'rule',
        settingsFn: async () => settings(),
        profileFn: async () => undefined,
        loadPositivesFn: async () => Array.from({ length: 12 }, (_, i) => sample(`p${i}`, '人工智能')),
        loadNegativesFn: async () => [],
        signal: ctrl.signal,
        saveFn: async () => {},
        now: () => NOW,
      }),
    ).rejects.toThrow(/取消/)
  })
})
