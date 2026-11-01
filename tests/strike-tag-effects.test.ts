import { describe, expect, it } from 'vitest'
import dict from '@/strike/i18n.json'
import {
  authorLinkSettings,
  bookmarkOutlineClass,
  decorateTagChips,
  foldAccent,
  libraryAuthorDecor,
  tagEffectFor,
} from '@/strike/lib/author-flags.js'
import {
  applyMark,
  commentScanDecision,
  communityListDecision,
  defaultSettings,
  foldReasonSummary,
  freshState,
  importData,
  normalizeState,
  sanitizeSettings,
  timelineChrome,
} from '@/strike/lib/pure.js'

const chips = [
  { name: 'Spam', tone: 'spam', count: 2, text: '垃圾×2', more: false },
  { name: 'Marketing', tone: 'marketing', count: 1, text: '营销×1', more: false },
  { name: 'Promo', tone: 'custom', count: 4, text: 'Promo×4', more: false },
  { name: '', tone: 'more', count: 1, text: '+1', more: true },
]

function marked(effects?: Record<string, string>) {
  const state = freshState(1)
  state.settings.enablePlatformActions = true
  state.settings.muteOnThreshold = true
  state.settings.blockOnThreshold = true
  state.settings.actionMode = 'auto'
  state.settings.hideOnThreshold = true
  if (effects) state.settings.tagEffects = effects
  let last: ReturnType<typeof applyMark> | null = null
  for (const id of ['a1', 'a2', 'a3']) {
    last = applyMark(state, {
      tag: 'Spam',
      handle: 'spammer',
      userId: '9',
      tweetId: id,
      textSnippet: 'x',
      followed: false,
    }, 10)
  }
  const account = (state.ledger as Record<string, { tags: { name: string; count: number }[] }>)['9']
  return {
    count: account.tags.find((row) => row.name === 'Spam')?.count,
    crossed: last?.threshold?.crossed,
    hide: last?.threshold?.suggest?.hide,
    mute: last?.threshold?.suggest?.mute,
    block: last?.threshold?.suggest?.block,
    queue: state.queue.length,
    hidden: Object.keys(state.hidden).length,
  }
}

describe('tag effects', () => {
  it('defaults to the existing colored chip and stores only a real choice', () => {
    expect(defaultSettings().tagEffects).toEqual({})
    expect(tagEffectFor(defaultSettings(), 'Spam')).toBe('chip')
    expect(tagEffectFor({}, 'Marketing')).toBe('chip')
    expect(freshState(1).settings.tagEffects).toEqual({})

    const saved = sanitizeSettings(defaultSettings(), {
      tagEffects: {
        spam: 'outline',
        Marketing: 'chip',
        Promo: 'fold',
        Ghost: 'none',
        Spam: 'rainbow',
      },
      customTags: ['Promo'],
    })
    expect(saved.settings.tagEffects).toEqual({ Spam: 'outline', Promo: 'fold' })
    expect(saved.settings.customTags).toEqual(['Promo'])
    expect(saved.settings.defaultThreshold).toBe(3)
    expect(saved.settings.actionMode).toBe('confirm')

    const cleared = sanitizeSettings(saved.settings, { tagEffects: { Spam: 'none' } })
    expect(cleared.settings.tagEffects).toEqual({ Spam: 'none' })

    const kept = sanitizeSettings(saved.settings, { language: 'zh' })
    expect(kept.settings.tagEffects).toEqual({ Spam: 'outline', Promo: 'fold' })

    const dropped = sanitizeSettings(saved.settings, { customTags: [], tagEffects: saved.settings.tagEffects })
    expect(dropped.settings.tagEffects).toEqual({ Spam: 'outline' })

    const legacy = normalizeState({ settings: { language: 'en' } }, 2)
    expect(legacy.settings.tagEffects).toEqual({})
    expect(legacy.settings.foldReasonEnabled).toBe(true)
  })

  it('paints chips, a single card edge, and a fold accent without touching the ledger', () => {
    const state = freshState(4)
    const before = JSON.stringify({ ledger: state.ledger, queue: state.queue, hidden: state.hidden, settings: state.settings })
    const view = timelineChrome({ counts: { Spam: 2, Marketing: 1, Promo: 4, Extra: 1 } }, { lang: 'zh' })
    const settings = {
      tagEffects: { Spam: 'outline', Marketing: 'none', Promo: 'fold' },
      customTags: ['Promo'],
    }
    const painted = decorateTagChips(view.chips, settings)
    expect(painted.chips.map((chip) => `${chip.name}:${chip.effect}`)).toEqual([
      'Spam:outline',
      'Marketing:none',
      'Promo:fold',
      'Extra:chip',
    ])
    expect(painted.outline).toBe('spam')
    expect(painted.chips[0].tone).toBe('spam')
    expect(foldAccent(settings, 'Promo')).toBe('custom')
    expect(foldAccent(settings, 'Spam')).toBe('')
    expect(foldAccent(settings, 'Marketing')).toBe('')

    const marketingEdge = decorateTagChips(chips, { tagEffects: { Marketing: 'outline', Promo: 'outline' } })
    expect(marketingEdge.outline).toBe('marketing')
    const customEdge = decorateTagChips(
      chips.filter((chip) => chip.name !== 'Spam' && chip.name !== 'Marketing'),
      { tagEffects: { Promo: 'outline' } },
    )
    expect(customEdge.outline).toBe('custom')
    expect(JSON.stringify({ ledger: state.ledger, queue: state.queue, hidden: state.hidden, settings: state.settings })).toBe(before)
  })

  it('colors the collapse bar from the reason tag, not from a community hit', () => {
    const keyword = foldReasonSummary({
      reasons: [{ pattern: '加微信', patternType: 'keyword', packName: '营销', suggestTag: 'Marketing' }],
    })
    expect(keyword).toMatchObject({ source: 'keyword', tag: 'Marketing' })
    expect(foldAccent({ tagEffects: { Marketing: 'fold' } }, keyword?.tag)).toBe('marketing')

    const ai = foldReasonSummary({ aiLabel: 'Spam' })
    expect(ai).toMatchObject({ source: 'ai', tag: 'Spam' })

    const fromChip = foldReasonSummary({
      tags: [
        { name: 'Promo', text: 'Promo×2' },
        { name: '', text: '+1', more: true },
      ],
    })
    expect(fromChip).toMatchObject({ source: 'tag', tag: 'Promo' })
    expect(foldAccent({ tagEffects: { Promo: 'fold' }, customTags: ['Promo'] }, fromChip?.tag)).toBe('custom')

    const community = foldReasonSummary({
      reasons: [{ pattern: '加群', packName: '示例', listName: '示例名单', community: true, suggestTag: 'Spam' }],
    })
    expect(community).toMatchObject({ source: 'community', tag: '' })
    expect(foldAccent({ tagEffects: { Spam: 'fold' } }, community?.tag)).toBe('')
  })

  it('shares Spam and Marketing effects with bookmark chips', () => {
    const settings = { tagEffects: { Spam: 'none', Marketing: 'outline' } }
    expect(authorLinkSettings(settings).tagEffects).toEqual({ Spam: 'none', Marketing: 'outline' })
    const both = libraryAuthorDecor({ spam: true, marketing: true }, settings)
    expect(both).toMatchObject({ spamEffect: 'none', marketingEffect: 'outline', outline: 'marketing' })
    expect(bookmarkOutlineClass({ spam: true, marketing: true }, settings)).toBe('fx-outline-marketing')
    expect(libraryAuthorDecor({ spam: true, marketing: true }, { tagEffects: { Spam: 'outline', Marketing: 'outline' } }).outline).toBe('spam')
    expect(bookmarkOutlineClass({ spam: true }, { tagEffects: { Spam: 'fold' } })).toBe('')
    expect(libraryAuthorDecor({ spam: false, marketing: false }, settings).outline).toBe('')
  })

  it('does not change strikes, queue suggestions, comment folds, or community folds', () => {
    expect(marked({ Spam: 'none', Marketing: 'fold', Promo: 'outline' })).toEqual(marked())
    const comment = {
      surface: 'reply' as const,
      enabled: true,
      mode: 'fold' as const,
      matched: true,
      followed: false,
      whitelist: false,
    }
    expect(commentScanDecision(comment)).toEqual(commentScanDecision(comment))
    expect(commentScanDecision({ ...comment, whitelist: true }).fold).toBe(false)
    const list = communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      whitelist: false,
      followed: true,
      surface: 'timeline',
    })
    expect(list).toMatchObject({ fold: false, recordStrike: false, queueMute: false, queueBlock: false })
  })

  it('round-trips through export-shaped import and keeps the copy local to settings', () => {
    const state = freshState(8)
    state.settings = sanitizeSettings(state.settings, {
      tagEffects: { Spam: 'fold', Marketing: 'outline' },
      customTags: ['Later'],
    }).settings
    const next = freshState(9)
    const imported = importData(next, { settings: state.settings, ledger: {} }, { settings: true, mode: 'replace' }, 9)
    expect(imported.ok).toBe(true)
    expect(next.settings.tagEffects).toEqual({ Spam: 'fold', Marketing: 'outline' })
    expect(next.settings.customTags).toEqual(['Later'])
    expect(next.ledger).toEqual({})
    expect(next.queue).toEqual([])
  })

  it('has an option label for every effect in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const bag = dict[lang] as Record<string, string>
      expect(bag.tagEffectsTitle.length).toBeGreaterThan(1)
      expect(bag.tagEffectsHelp.length).toBeGreaterThan(40)
      expect(bag.tagEffectFor).toContain('{tag}')
      expect(bag.tagEffect_chip.length).toBeGreaterThan(1)
      expect(bag.tagEffect_none.length).toBeGreaterThan(1)
      expect(bag.tagEffect_outline.length).toBeGreaterThan(1)
      expect(bag.tagEffect_fold.length).toBeGreaterThan(1)
    }
    expect(dict.zh.tagEffect_none).toContain('无特殊效果')
    expect(dict.zh.tagEffectsHelp).toMatch(/不改记账/)
    expect(dict.en.tagEffectsHelp).toMatch(/Display only/)
  })
})
