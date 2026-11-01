import { describe, expect, it } from 'vitest'
import {
  addKeywordToPack,
  aiSuggestionDismissed,
  applyFalsePositive,
  applyMark,
  autoPlatformAllowed,
  commentScanDecision,
  distillException,
  exportData,
  falsePositivePlan,
  freshState,
  importData,
  matchRules,
  normalizeState,
  sanitizeSettings,
  suggestionHash,
  undoVeto,
} from '@/strike/lib/pure.js'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

type Ledger = Record<string, { whitelist?: boolean; followed?: boolean | null; tags: { name: string; count: number }[] }>
type Reason = { pattern: string; cooled?: boolean }
type Veto = {
  id: string
  kind: string
  until: number
  pattern: string
  packId: string
  phrase: string
  phraseScope: string
  handle: string
  hash: string
  source: string
}

const frozen = (state: ReturnType<typeof freshState>) => ({
  ledger: JSON.stringify(state.ledger),
  tweets: JSON.stringify(state.tweets),
  queue: JSON.stringify(state.queue),
  hidden: JSON.stringify(state.hidden),
  packs: JSON.stringify(state.settings.keywordPacks),
})

function customState() {
  const state = freshState(NOW)
  state.settings.keywordPacks = [
    {
      id: 'pack-a',
      name: '甲',
      enabled: true,
      suggestTag: 'Spam',
      patterns: [
        { type: 'keyword', target: 'text', value: '空投' },
        { type: 'keyword', target: 'text', value: 'airdrop' },
      ],
    },
    {
      id: 'pack-b',
      name: '乙',
      enabled: true,
      suggestTag: 'Marketing',
      patterns: [{ type: 'keyword', target: 'text', value: 'seed phrase' }],
    },
  ]
  state.settings.enablePlatformActions = true
  state.settings.muteOnThreshold = true
  state.settings.blockOnThreshold = true
  state.settings.actionMode = 'auto'
  return state
}

const vetoesOf = (state: ReturnType<typeof freshState>) => state.vetoes as Veto[]

describe('false positive veto and anti-distill', () => {
  it('cools the matched keyword without touching a confirmed strike or the queue', () => {
    const state = customState()
    state.settings.vetoCooldownDays = 7
    const marked = applyMark(state, {
      tag: 'Spam',
      handle: 'alice',
      tweetId: '200',
      textSnippet: '空投说明',
      followed: true,
    }, NOW) as { ok: boolean; userId: string }
    expect(marked.ok).toBe(true)
    ;(state.ledger as Ledger)[marked.userId].whitelist = true
    const before = frozen(state)
    const count = (state.ledger as Ledger)[marked.userId].tags.find((row) => row.name === 'Spam')?.count

    const plan = falsePositivePlan({
      packs: state.settings.keywordPacks,
      cooldownDays: state.settings.vetoCooldownDays,
      source: 'suspect',
      text: '项目路线图今天更新，不是空投',
      handle: 'alice',
    }, NOW)
    expect(plan.items.map((item) => item.pattern)).toContain('空投')
    expect(plan.phrase).toBe('项目路线图今天更新')
    expect(plan.until).toBe(NOW + 7 * DAY)

    const saved = applyFalsePositive(state, {
      source: 'suspect',
      text: '项目路线图今天更新，不是空投',
      handle: 'alice',
      tweetId: '200',
      items: plan.items.filter((item) => item.pattern === '空投'),
      exception: true,
      phraseScope: 'author',
    }, NOW) as { ok: boolean; count: number; phrase: string }
    expect(saved.ok).toBe(true)
    expect(saved.count).toBe(1)
    expect(saved.phrase).toBe('项目路线图今天更新')
    expect(frozen(state)).toEqual(before)
    expect((state.ledger as Ledger)[marked.userId].tags.find((row) => row.name === 'Spam')?.count).toBe(count)
    expect((state.ledger as Ledger)[marked.userId].whitelist).toBe(true)
    expect((state.ledger as Ledger)[marked.userId].followed).toBe(true)
    expect(state.queue).toEqual([])
    expect(autoPlatformAllowed(state.settings, { whitelist: false, followed: false }, 'mute', 'suspect')).toBe(false)
    expect(autoPlatformAllowed(state.settings, { whitelist: true, followed: false }, 'block', 'threshold')).toBe(false)
    expect(state.settings.keywordPacks[0].patterns.map((pattern) => pattern.value)).toEqual(['空投', 'airdrop'])

    const cooled = matchRules(state.settings.keywordPacks, {
      text: '又一个空投',
      handle: 'bob',
      bio: '',
      vetoes: state.vetoes,
      now: NOW + DAY,
    })
    expect(cooled.suspect).toBe(false)

    const both = matchRules(state.settings.keywordPacks, {
      text: '空投 seed phrase',
      handle: 'bob',
      bio: '',
      vetoes: state.vetoes,
      now: NOW + DAY,
    })
    expect(both.suspect).toBe(true)
    const reasons = both.reasons as Reason[]
    expect(reasons.map((reason) => reason.pattern).sort()).toEqual(['seed phrase', '空投'])
    expect(reasons.find((reason) => reason.pattern === '空投')?.cooled).toBe(true)
    expect(reasons.find((reason) => reason.pattern === 'seed phrase')?.cooled).toBeUndefined()

    const later = matchRules(state.settings.keywordPacks, {
      text: '又一个空投',
      handle: 'bob',
      bio: '',
      vetoes: state.vetoes,
      now: NOW + 8 * DAY,
    })
    expect(later.suspect).toBe(true)
  })

  it('keeps a zero-day veto until undo, and an exception only for that author and phrase', () => {
    const state = customState()
    state.settings.vetoCooldownDays = 0
    const marked = applyMark(state, { tag: 'Spam', handle: 'alice', tweetId: '201', textSnippet: '空投' }, NOW) as { userId: string }
    const saved = applyFalsePositive(state, {
      source: 'suspect',
      text: '项目路线图今天更新，不是空投',
      handle: 'alice',
      tweetId: '201',
      items: [{ packId: 'pack-a', pattern: '空投', patternType: 'keyword', target: 'text' }],
      exception: true,
      phraseScope: 'author',
    }, NOW) as { ok: boolean }
    expect(saved.ok).toBe(true)
    expect((state.ledger as Ledger)[marked.userId].tags[0].count).toBe(1)

    const far = matchRules(state.settings.keywordPacks, {
      text: '空投 seed phrase',
      handle: 'alice',
      bio: '',
      vetoes: state.vetoes,
      now: NOW + 400 * DAY,
    })
    expect(far.reasons.map((reason) => reason.pattern)).toEqual(['seed phrase'])

    const rule = vetoesOf(state).find((item) => item.kind === 'rule')
    const exception = vetoesOf(state).find((item) => item.kind === 'exception')
    expect(rule?.until).toBe(0)
    expect(exception?.phrase).toBe('项目路线图今天更新')
    expect(exception?.phraseScope).toBe('author')
    expect(undoVeto(state, { id: rule?.id }).ok).toBe(true)
    expect((state.ledger as Ledger)[marked.userId].tags[0].count).toBe(1)

    const allowed = matchRules(state.settings.keywordPacks, {
      text: '项目路线图今天更新，不是空投',
      handle: 'alice',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    })
    expect(allowed.suspect).toBe(false)
    const otherAuthor = matchRules(state.settings.keywordPacks, {
      text: '项目路线图今天更新，不是空投',
      handle: 'bob',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    })
    expect(otherAuthor.suspect).toBe(true)
    const noPhrase = matchRules(state.settings.keywordPacks, {
      text: '空投活动',
      handle: 'alice',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    })
    expect(noPhrase.suspect).toBe(true)
    expect(noPhrase.reasons[0].pattern).toBe('空投')

    state.settings.keywordPacks[0].patterns.push({ type: 'keyword', target: 'text', value: '博彩' })
    const otherWord = matchRules(state.settings.keywordPacks, {
      text: '博彩 项目路线图今天更新',
      handle: 'alice',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    })
    expect(otherWord.suspect).toBe(true)
    expect(otherWord.reasons.map((reason) => reason.pattern)).toContain('博彩')

    expect(undoVeto(state, { id: exception?.id }).ok).toBe(true)
    expect(matchRules(state.settings.keywordPacks, {
      text: '项目路线图今天更新，不是空投',
      handle: 'alice',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    }).suspect).toBe(true)
    expect(undoVeto(state, { id: 'missing' })).toEqual({ ok: false, error: 'no-veto' })
    expect((state.ledger as Ledger)[marked.userId].tags[0].count).toBe(1)
    expect(state.queue).toEqual([])
  })

  it('refuses an invented pattern and still folds a reply only while the keyword matches', () => {
    const state = customState()
    const before = frozen(state)
    const skipped = applyFalsePositive(state, {
      source: 'suspect',
      text: 'hello roadmap',
      handle: 'alice',
      items: [{ packId: 'pack-a', pattern: 'not-in-post', patternType: 'keyword', target: 'text' }],
    }, NOW) as { ok: boolean; error?: string }
    expect(skipped).toEqual({ ok: false, error: 'empty-veto' })
    expect(state.vetoes).toEqual([])
    expect(frozen(state)).toEqual(before)

    const live = matchRules(state.settings.keywordPacks, { text: '领取空投', handle: 'spammer', bio: '' })
    expect(commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: live.suspect,
      whitelist: false,
      followed: false,
    })).toMatchObject({ fold: true, queueMute: false, queueBlock: false })

    applyFalsePositive(state, {
      source: 'suspect',
      text: '领取空投',
      handle: 'spammer',
      items: [{ packId: 'pack-a', pattern: '空投', patternType: 'keyword', target: 'text' }],
    }, NOW)
    const quiet = matchRules(state.settings.keywordPacks, {
      text: '领取空投',
      handle: 'spammer',
      bio: '',
      vetoes: state.vetoes,
      now: NOW,
    })
    expect(commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: quiet.suspect,
      whitelist: true,
      followed: true,
    })).toMatchObject({ fold: false, suspect: false, queueMute: false, queueBlock: false })
    expect(frozen(state).ledger).toBe(before.ledger)
  })

  it('anti-distills an AI suggestion into a local veto and can dismiss that suggestion', () => {
    const state = customState()
    state.settings.keywordPacks[0].patterns = []
    const marked = applyMark(state, { tag: 'Marketing', handle: 'alice', tweetId: '300', textSnippet: 'roadmap' }, NOW) as { userId: string }
    const text = 'claim your airdrop now'
    const saved = applyFalsePositive(state, {
      source: 'ai',
      label: 'Spam',
      reason: 'airdrop bait',
      text,
      handle: 'alice',
      keywords: ['airdrop', 'invented-bait'],
    }, NOW) as { ok: boolean; count: number; hash: string }
    expect(saved.ok).toBe(true)
    expect(saved.count).toBe(1)
    expect(vetoesOf(state).some((item) => item.pattern === 'invented-bait')).toBe(false)
    expect(vetoesOf(state).find((item) => item.pattern === 'airdrop')?.packId).toBe('')
    expect((state.ledger as Ledger)[marked.userId].tags[0].count).toBe(1)
    expect(state.settings.keywordPacks[0].patterns).toEqual([])

    addKeywordToPack(state, { packId: 'pack-a', value: 'airdrop', target: 'text' })
    expect(matchRules(state.settings.keywordPacks, {
      text: 'another AIRDROP post',
      handle: 'bob',
      bio: '',
      vetoes: state.vetoes,
      now: NOW + DAY,
    }).suspect).toBe(false)

    const hash = suggestionHash({ handle: 'alice', text, bio: '' })
    expect(saved.hash).toBe(hash)
    expect(aiSuggestionDismissed(state.vetoes, hash, NOW + DAY)).toBe(true)
    expect(aiSuggestionDismissed(state.vetoes, hash, NOW + 20 * DAY)).toBe(false)

    const none = applyFalsePositive(state, {
      source: 'ai',
      label: 'Spam',
      text: 'hello there',
      handle: 'alice',
      keywords: ['not-in-the-post'],
    }, NOW) as { ok: boolean; count: number }
    expect(none.ok).toBe(true)
    expect(none.count).toBe(0)
    expect(vetoesOf(state).some((item) => item.kind === 'ai' && item.source === 'ai')).toBe(true)
    expect((state.ledger as Ledger)[marked.userId].tags[0].count).toBe(1)
  })

  it('refreshes one veto, caps the list, and round-trips through normalize and import', () => {
    const state = customState()
    state.settings.vetoCooldownDays = 14
    const first = applyFalsePositive(state, {
      source: 'suspect',
      text: 'airdrop today',
      handle: 'alice',
      items: [{ packId: 'pack-a', pattern: 'airdrop', patternType: 'keyword', target: 'text' }],
    }, NOW) as { added: { id: string }[] }
    state.settings.vetoCooldownDays = 3
    applyFalsePositive(state, {
      source: 'suspect',
      text: 'airdrop today',
      handle: 'alice',
      items: [{ packId: 'pack-a', pattern: 'airdrop', patternType: 'keyword', target: 'text' }],
    }, NOW + 5000)
    const rules = vetoesOf(state).filter((item) => item.kind === 'rule' && item.pattern.toLowerCase() === 'airdrop')
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe(first.added[0].id)
    expect(rules[0].until).toBe(NOW + 5000 + 3 * DAY)

    for (let i = 0; i < 45; i += 1) {
      const word = `zz${i}zz`
      state.settings.keywordPacks[0].patterns.push({ type: 'keyword', target: 'text', value: word })
      applyFalsePositive(state, {
        source: 'suspect',
        text: `see ${word} here`,
        handle: 'alice',
        items: [{ packId: 'pack-a', pattern: word, patternType: 'keyword', target: 'text' }],
      }, NOW + i)
    }
    expect(state.vetoes.length).toBeLessThanOrEqual(40)
    expect(vetoesOf(state).some((item) => item.pattern === 'zz44zz')).toBe(true)

    const normalized = normalizeState(state, NOW)
    expect(normalized.vetoes.length).toBe(state.vetoes.length)
    expect(matchRules(normalized.settings.keywordPacks, {
      text: 'see zz44zz here',
      handle: 'alice',
      bio: '',
      vetoes: normalized.vetoes,
      now: NOW,
    }).suspect).toBe(false)

    const marked = applyMark(state, { tag: 'Spam', handle: 'alice', tweetId: '404', textSnippet: 'kept' }, NOW) as { userId: string }
    const count = (state.ledger as Ledger)[marked.userId].tags.find((row) => row.name === 'Spam')?.count
    const exported = exportData(state) as { vetoes: unknown[]; ledger: Record<string, { tags: { count: number }[] }> }
    expect(exported.vetoes.length).toBeGreaterThan(0)
    const other = freshState(NOW)
    applyMark(other, { tag: 'Spam', handle: 'carol', tweetId: '405', textSnippet: 'stay' }, NOW)
    const imported = importData(other, exported, { mode: 'merge', settings: true }, NOW) as { ok: boolean }
    expect(imported.ok).toBe(true)
    expect(other.vetoes.length).toBeGreaterThan(0)
    expect((other.ledger as Ledger)[marked.userId].tags.find((row) => row.name === 'Spam')?.count).toBe(count)
    const carol = Object.values(other.ledger as Ledger).find((account) => account.tags.some((tag) => tag.count >= 1))
    expect(carol).toBeTruthy()

    const clamped = sanitizeSettings(freshState(NOW).settings, { vetoCooldownDays: 900 })
    expect(clamped.settings.vetoCooldownDays).toBe(365)
    expect(sanitizeSettings(freshState(NOW).settings, { vetoCooldownDays: 0 }).settings.vetoCooldownDays).toBe(0)
    expect(freshState(NOW).settings.vetoCooldownDays).toBe(14)
  })

  it('distills an allowlist phrase that occurs in the post and is not the spam keyword', () => {
    const packs = customState().settings.keywordPacks
    const zh = distillException({
      text: '项目路线图今天更新，不是空投',
      blocked: ['空投'],
      packs,
    })
    expect(zh.phrase).toBe('项目路线图今天更新')
    expect(zh.phrase.includes('空投')).toBe(false)

    const en = distillException({
      text: 'airdrop? no, this is the roadmap update',
      blocked: ['airdrop'],
      packs,
    })
    expect(en.phrase).toBe('the roadmap update')
    expect(en.phrase.toLowerCase().includes('airdrop')).toBe(false)

    const missing = distillException({ text: 'airdrop', blocked: ['airdrop'], packs })
    expect(missing.phrase).toBe('')
    expect(distillException({ text: 'totally fine note', blocked: ['airdrop'], packs: [] }).phrase.length).toBeGreaterThan(1)
  })
})
