import { describe, expect, it } from 'vitest'
import {
  addKeywordToPack,
  defaultKeywordPacks,
  freshState,
  keywordMenuPlan,
  matchRules,
  normalizeState,
  packsToText,
  parseKeywordPackText,
  recordRuleHits,
} from '@/strike/lib/pure.js'

type KeywordAdd = { ok: boolean; duplicate?: boolean; error?: string; value?: string }
type HitRow = { handle: string; tweetId: string }

const addKeyword = (state: ReturnType<typeof freshState>, input: { packId: string; value: string; target?: string }) =>
  addKeywordToPack(state, input) as KeywordAdd

describe('keyword packs', () => {
  it('adds a selected word without a strike, then only the suspect chip matches', () => {
    const state = freshState(1)
    state.settings.keywordPacks = [{ id: 'pack-custom', name: 'Custom', enabled: true, suggestTag: 'Spam', patterns: [] }]
    const before = JSON.stringify(state.ledger)
    const added = addKeyword(state, { packId: 'pack-custom', value: '  hello-kit  ', target: 'text' })
    expect(added.ok).toBe(true)
    expect(added.duplicate).toBe(false)
    expect(state.settings.keywordPacks[0].patterns).toEqual([{ type: 'keyword', target: 'text', value: 'hello-kit' }])
    expect(JSON.stringify(state.ledger)).toBe(before)

    const again = addKeyword(state, { packId: 'pack-custom', value: 'Hello-Kit', target: 'text' })
    expect(again.duplicate).toBe(true)
    expect(state.settings.keywordPacks[0].patterns).toHaveLength(1)

    const hit = matchRules(state.settings.keywordPacks, { text: 'see hello-kit today', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.reasons[0].pattern).toBe('hello-kit')
    expect(hit.tags).toEqual(['Spam'])
    const handleOnly = matchRules(state.settings.keywordPacks, { text: '', handle: 'hello-kit', bio: '' })
    expect(handleOnly.suspect).toBe(false)
    expect(JSON.stringify(state.ledger)).toBe(before)
    expect(state.ledger).toEqual({})
  })

  it('keeps a slashy selection as a literal keyword', () => {
    const state = freshState(1)
    state.settings.keywordPacks = [{ id: 'pack-custom', name: 'Custom', enabled: true, suggestTag: '', patterns: [] }]
    const added = addKeyword(state, { packId: 'pack-custom', value: '/sale/i', target: 'text' })
    expect(added.ok).toBe(true)
    expect(state.settings.keywordPacks[0].patterns[0]).toEqual({ type: 'keyword', target: 'text', value: '/sale/i' })
    expect(matchRules(state.settings.keywordPacks, { text: 'big sale today', handle: 'a', bio: '' }).suspect).toBe(false)
    expect(matchRules(state.settings.keywordPacks, { text: 'code /sale/i here', handle: 'a', bio: '' }).suspect).toBe(true)
  })

  it('rejects empty, punctuation, overlong words, and a missing pack', () => {
    const state = freshState(1)
    expect(addKeyword(state, { packId: 'pack-spam-en', value: '   ' }).ok).toBe(false)
    expect(addKeyword(state, { packId: 'pack-spam-en', value: '!!!' }).error).toBe('keyword-plain')
    expect(addKeyword(state, { packId: 'pack-spam-en', value: '赌' }).ok).toBe(true)
    expect(addKeyword(state, { packId: 'missing', value: 'hello' }).error).toBe('no-pack')
    expect(addKeyword(state, { packId: 'pack-spam-en', value: 'x'.repeat(81) }).error).toBe('keyword-long')
    const full = freshState(1)
    full.settings.keywordPacks = [{
      id: 'p',
      name: 'P',
      enabled: true,
      suggestTag: 'Spam',
      patterns: Array.from({ length: 80 }, (_, i) => ({ type: 'keyword', target: 'text', value: `w${i}` })),
    }]
    expect(addKeyword(full, { packId: 'p', value: 'extra' }).error).toBe('pack-full')
    expect(full.ledger).toEqual({})
  })

  it('round-trips packs as text, including a disabled pack and regex', () => {
    const parsed = parseKeywordPackText(packsToText(defaultKeywordPacks()))
    expect(parsed.ok).toBe(true)
    expect(parsed.warnings).toEqual([])
    expect(parsed.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      enabled: pack.enabled,
      suggestTag: pack.suggestTag,
      patterns: pack.patterns,
    }))).toEqual(defaultKeywordPacks())
    const hit = matchRules(parsed.packs, { text: 'telegram t.me/scam', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    const state = freshState(1)
    expect(JSON.stringify(state.ledger)).toBe('{}')
  })

  it('imports a headerless word list as one pack and drops a bad regex', () => {
    const parsed = parseKeywordPackText('# notes\n刷单\n\n网赌\n')
    expect(parsed.packs).toHaveLength(1)
    expect(parsed.packs[0].name).toBe('Imported')
    expect(parsed.packs[0].patterns.map((pattern) => pattern.value)).toEqual(['刷单', '网赌'])
    const bad = parseKeywordPackText('[Try]\nenabled: true\nsuggest: Marketing\n/[/ \nhello\n')
    expect(bad.packs[0].suggestTag).toBe('Marketing')
    expect(bad.packs[0].patterns.map((pattern) => pattern.value)).toEqual(['hello'])
    expect(bad.warnings.length).toBeGreaterThan(0)
    expect(parseKeywordPackText('')).toEqual({ ok: true, packs: [], warnings: [] })
    expect(parseKeywordPackText('x'.repeat(100_001)).ok).toBe(false)
  })

  it('records an optional hit log and never increments strikes', () => {
    const state = freshState(5)
    state.settings.keywordPacks = [{ id: 'pack-custom', name: 'Custom', enabled: true, suggestTag: 'Spam', patterns: [{ type: 'keyword', target: 'text', value: 'hello-kit' }] }]
    const matched = matchRules(state.settings.keywordPacks, { text: 'hello-kit', handle: 'spammer', bio: '' })
    const off = recordRuleHits(state, {
      hits: [{ ...matched.reasons[0], handle: 'spammer', tweetId: '55', snippet: 'hello-kit please' }],
    }, 5)
    expect(off.recorded).toBe(0)
    expect(state.hitLog).toEqual([])
    expect(state.ledger).toEqual({})

    state.settings.hitHistory = true
    const on = recordRuleHits(state, {
      hits: [{ ...matched.reasons[0], handle: '@spammer', tweetId: '55', snippet: 'hello-kit please' }],
    }, 9)
    expect(on.recorded).toBe(1)
    const rows = () => state.hitLog as HitRow[]
    expect(rows()).toHaveLength(1)
    expect(rows()[0].handle).toBe('spammer')
    expect(state.ledger).toEqual({})
    const dup = recordRuleHits(state, {
      hits: [{ ...matched.reasons[0], handle: 'spammer', tweetId: '55', snippet: 'again' }],
    }, 10)
    expect(dup.recorded).toBe(0)
    expect(rows()).toHaveLength(1)

    for (let n = 0; n < 50; n += 1) {
      recordRuleHits(state, {
        hits: [{ packId: 'pack-custom', packName: 'Custom', pattern: 'hello-kit', target: 'text', handle: 'spammer', tweetId: `t${n}`, snippet: 'x' }],
      }, 20 + n)
    }
    expect(rows()).toHaveLength(40)
    expect(rows()[0].tweetId).toBe('t49')
    expect(state.ledger).toEqual({})

    const restored = normalizeState({ ...state, settings: state.settings, hitLog: state.hitLog })
    expect(restored.hitLog).toHaveLength(40)
    expect(restored.settings.hitHistory).toBe(true)
    expect(restored.ledger).toEqual({})
  })

  it('builds a selection submenu for each pack', () => {
    const plan = keywordMenuPlan(defaultKeywordPacks(), 'zh')
    expect(plan.parentTitle).toBe('把选中文字加入关键词包')
    expect(plan.items[0]).toMatchObject({ id: 'xsl-kw:pack-spam-zh', packId: 'pack-spam-zh' })
    const off = plan.items.find((item) => item.packId === 'pack-handle')
    expect(off?.title).toContain('已停用')
    expect(keywordMenuPlan(defaultKeywordPacks(), 'en').parentTitle).toBe('Add selection to keyword pack')
    const named = keywordMenuPlan([{ id: 'pack-sale', name: '100%s off', enabled: true }], 'en')
    expect(named.items[0].title).not.toContain('%')
  })
})
