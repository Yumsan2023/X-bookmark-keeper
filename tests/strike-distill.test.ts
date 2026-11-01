import { describe, expect, it } from 'vitest'
import {
  addDistilledRules,
  contentHash,
  defaultSettings,
  distillSuggestion,
  freshState,
  interpretAiLabel,
  matchRules,
  suggestPackId,
} from '@/strike/lib/pure.js'

type DistillResult = { ok: boolean; rules: Array<{ type: string; target: string; value: string }> }
type AddResult = {
  ok: boolean
  error?: string
  count?: number
  duplicate?: boolean
  added?: Array<{ type: string; value: string }>
  duplicates?: unknown[]
}

const distill = (input: Record<string, unknown>) => distillSuggestion(input) as DistillResult
const add = (state: ReturnType<typeof freshState>, input: Record<string, unknown>) =>
  addDistilledRules(state, input) as AddResult

function packState() {
  const state = freshState(1)
  state.settings.keywordPacks = [{ id: 'pack-custom', name: 'Custom', enabled: true, suggestTag: 'Spam', patterns: [] }]
  state.settings.ai.enabled = false
  state.settings.ai.apiKey = ''
  return state
}

function untouched(state: ReturnType<typeof freshState>) {
  return {
    ledger: JSON.stringify(state.ledger),
    tweets: JSON.stringify(state.tweets),
    log: JSON.stringify(state.log),
    undo: JSON.stringify(state.undo),
    queue: JSON.stringify(state.queue),
    aiCache: JSON.stringify(state.aiCache),
  }
}

describe('distill AI suggestion into keyword rules', () => {
  it('keeps AI off by default and does not put a key in settings', () => {
    const ai = defaultSettings().ai
    expect(ai.enabled).toBe(false)
    expect(ai.autoSuggestSuspects).toBe(false)
    expect(ai.apiKey).toBe('')
    expect(ai.hasApiKey).toBe(false)
  })

  it('distills literal keywords that occur in the post and drops invented ones', () => {
    const result = distill({
      label: 'Spam',
      text: 'Claim your airdrop at t.me/SpamGroup today #FreeMint',
      bio: '',
      handle: 'spammer',
      reason: 'airdrop scam',
      keywords: ['airdrop', 'not in the post', 'the'],
    })
    expect(result.rules).toEqual([
      { type: 'regex', target: 'text', value: '(?i)t\\.me/SpamGroup' },
      { type: 'keyword', target: 'text', value: 'airdrop' },
      { type: 'keyword', target: 'text', value: 'FreeMint' },
    ])
  })

  it('uses a quoted reason span and a tight contact or income pattern', () => {
    const quoted = distill({
      label: 'Marketing',
      text: '限时优惠，私信领取课程',
      reason: '引流话术「私信领取」',
      keywords: [],
    })
    expect(quoted.rules).toEqual([{ type: 'keyword', target: 'text', value: '私信领取' }])

    const contact = distill({
      label: 'Spam',
      text: '加我微信:abc_12',
      reason: '',
    })
    expect(contact.rules).toEqual([{ type: 'keyword', target: 'text', value: '微信:abc_12' }])

    const income = distill({
      label: 'Spam',
      text: '日入5000 稳赚',
      reason: '',
    })
    expect(income.rules).toEqual([{ type: 'regex', target: 'text', value: '日[入赚]\\s*[0-9０-９千万]+' }])

    const dm = distill({
      label: 'Marketing',
      text: 'please DM me for signals',
      reason: 'lead gen',
    })
    expect(dm.rules).toEqual([{ type: 'regex', target: 'text', value: '(?i)\\b(dm|pm)\\s+me\\b' }])
  })

  it('keeps a multi-word phrase from the reason when the post contains it', () => {
    const result = distill({
      label: 'Marketing',
      text: 'grab the promo code today',
      reason: 'Use the promo code',
    })
    expect(result.rules).toEqual([{ type: 'keyword', target: 'text', value: 'the promo code' }])
  })

  it('refuses none, the whole handle, and phrases that are not in the post', () => {
    expect(distill({ label: 'none', text: 'airdrop', keywords: ['airdrop'] }).rules).toEqual([])
    expect(distill({ label: null, text: 'airdrop' }).rules).toEqual([])
    expect(distill({
      label: 'Spam',
      handle: 'freeairdrop',
      text: 'hello',
      keywords: ['freeairdrop'],
    }).rules).toEqual([])
    const hashParts = ['freeairdrop', '', 'hello']
    const hash = contentHash(hashParts)
    distill({ label: 'Spam', text: 'x'.repeat(80), keywords: ['x'.repeat(50)] })
    expect(contentHash(hashParts)).toBe(hash)
    expect(distill({
      label: 'Spam',
      text: 'supercalifragilistic sale extra words here',
      keywords: ['supercalifragilistic sale extra words here'],
    }).rules).toEqual([])
  })

  it('caps the list and prefers the field where the literal occurs', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const capped = distill({ label: 'Spam', text: words.join(' '), keywords: words })
    expect(capped.rules).toHaveLength(6)
    expect(capped.rules.map((rule) => rule.value)).toEqual(words.slice(0, 6))

    const bio = distill({ label: 'Spam', text: 'hello', bio: 'https://t.me/OnlyBio', reason: '' })
    expect(bio.rules).toEqual([{ type: 'regex', target: 'bio', value: '(?i)t\\.me/OnlyBio' }])
  })

  it('writes the confirmed subset into the chosen pack and never a strike', () => {
    const state = packState()
    const before = untouched(state)
    const input = {
      packId: 'pack-custom',
      label: 'Spam',
      text: 'claim your airdrop now',
      reason: 'airdrop',
      keywords: ['airdrop'],
      rules: [
        { type: 'regex', target: 'text', value: '(?i).*' },
        { type: 'keyword', target: 'text', value: 'airdrop' },
        { type: 'keyword', target: 'text', value: 'invented-bait' },
      ],
    }
    const saved = add(state, input)
    expect(saved.ok).toBe(true)
    expect(saved.count).toBe(1)
    expect(state.settings.keywordPacks[0].patterns).toEqual([{ type: 'keyword', target: 'text', value: 'airdrop' }])
    expect(untouched(state)).toEqual(before)
    expect(state.settings.ai.enabled).toBe(false)
    expect(state.settings.ai.apiKey).toBe('')

    const hit = matchRules(state.settings.keywordPacks, { text: 'another AIRDROP post', handle: 'a', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.tags).toEqual(['Spam'])
    expect(state.ledger).toEqual({})

    const again = add(state, input)
    expect(again.duplicate).toBe(true)
    expect(again.count).toBe(0)
    expect(state.settings.keywordPacks[0].patterns).toHaveLength(1)
    expect(untouched(state)).toEqual(before)
  })

  it('adds every distilled rule in one call, and an empty selection writes nothing', () => {
    const state = packState()
    const source = {
      packId: 'pack-custom',
      label: 'Spam',
      text: 'Claim your airdrop at t.me/SpamGroup',
      keywords: ['airdrop'],
    }
    const saved = add(state, source)
    expect(saved.ok).toBe(true)
    expect(saved.count).toBe(2)
    expect(state.ledger).toEqual({})
    expect(matchRules(state.settings.keywordPacks, { text: 'see t.me/SpamGroup', handle: 'a', bio: '' }).suspect).toBe(true)

    const skipped = add(packState(), { ...source, rules: [] })
    expect(skipped).toEqual({ ok: false, error: 'empty-keyword' })
    expect(add(packState(), { ...source, packId: 'missing' }).error).toBe('no-pack')
  })

  it('stops at a full pack without touching the ledger', () => {
    const state = packState()
    state.settings.keywordPacks[0].patterns = Array.from({ length: 80 }, (_, i) => ({
      type: 'keyword',
      target: 'text',
      value: `w${i}`,
    }))
    const saved = add(state, {
      packId: 'pack-custom',
      label: 'Spam',
      text: 'airdrop today',
      keywords: ['airdrop'],
      rules: [{ type: 'keyword', target: 'text', value: 'airdrop' }],
    })
    expect(saved.error).toBe('pack-full')
    expect(state.settings.keywordPacks[0].patterns).toHaveLength(80)
    expect(state.ledger).toEqual({})
  })

  it('picks an enabled pack whose suggested tag matches the AI label', () => {
    const packs = [
      { id: 'off', name: 'Off', enabled: false, suggestTag: 'Marketing' },
      { id: 'spam', name: 'Spam', enabled: true, suggestTag: 'Spam' },
      { id: 'mkt', name: 'Mkt', enabled: true, suggestTag: 'Marketing' },
    ]
    expect(suggestPackId(packs, 'Marketing')).toBe('mkt')
    expect(suggestPackId(packs, 'Spam')).toBe('spam')
    expect(suggestPackId([{ id: 'off', enabled: false, suggestTag: 'Marketing' }], 'Marketing')).toBe('off')
  })

  it('reads model keywords and ignores model regex objects', () => {
    const parsed = interpretAiLabel('{"label":"spam","reason":"bait","keywords":["airdrop","x",{"type":"regex","value":"(?i).*"},{"type":"keyword","value":"seed phrase"}]}')
    expect(parsed).toMatchObject({ label: 'Spam', verdict: 'tag', reason: 'bait' })
    expect(parsed.keywords).toEqual(['airdrop', 'seed phrase'])
    expect(interpretAiLabel('{"label":"none","reason":"ok"}')).toMatchObject({ label: null, verdict: 'none', keywords: [] })
    expect(interpretAiLabel('nope').keywords).toEqual([])
  })
})
