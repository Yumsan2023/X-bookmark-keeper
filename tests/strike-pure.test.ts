import { describe, expect, it } from 'vitest'
import {
  applyMark,
  defaultSettings,
  exportData,
  freshState,
  matchMenuLabel,
  matchRules,
  sanitizeSettings,
} from '@/strike/lib/pure.js'

const mark = (state: ReturnType<typeof freshState>, tweetId: string, handle = 'spammer') =>
  applyMark(state, { tag: 'Spam', handle, tweetId, textSnippet: 'buy followers' }, 1_700_000_000_000)

describe('strike ledger pure logic', () => {
  it('does not count a keyword hit until the user marks, and counts one post once', () => {
    const state = freshState(1)
    const before = JSON.stringify(state.ledger)
    const hit = matchRules(state.settings.keywordPacks, { text: 'telegram t.me/scam', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(JSON.stringify(state.ledger)).toBe(before)

    const first = mark(state, '100')
    expect(first.ok).toBe(true)
    expect(first.already).toBe(false)
    expect(first.threshold?.count).toBe(1)
    expect(first.threshold?.crossed).toBe(false)
    const again = mark(state, '100')
    expect(again.already).toBe(true)
    expect(again.threshold).toBeNull()
    const ledger = state.ledger as Record<string, { tags: { name: string; count: number }[] }>
    expect(ledger[first.userId].tags.find((row) => row.name === 'Spam')?.count).toBe(1)
  })

  it('crosses the default threshold only on the Nth confirmed mark', () => {
    const state = freshState(1)
    mark(state, '101')
    mark(state, '102')
    const third = mark(state, '103')
    expect(third.threshold?.crossed).toBe(true)
    expect(third.threshold?.n).toBe(3)
    expect(third.threshold?.suggest.hide).toBe(true)
    expect(third.threshold?.suggest.block).toBe(false)
  })

  it('refuses mute-word menu rows and accepts a mute row for that handle', () => {
    expect(matchMenuLabel('Mute words', 'mute', 'spammer')).toBe(false)
    expect(matchMenuLabel('Mute @spammer', 'mute', 'spammer')).toBe(true)
    expect(matchMenuLabel('Mute @other', 'mute', 'spammer')).toBe(false)
    expect(matchMenuLabel('屏蔽 @spammer', 'block', 'spammer')).toBe(true)
  })

  it('keeps the API key out of export and enforces the menu gap floor', () => {
    const state = freshState(1)
    state.settings.ai.apiKey = 'sk-secret'
    const exported = exportData(state)
    expect(exported.settings.ai.apiKey).toBe('')
    expect(exported.settings.ai.hasApiKey).toBe(true)
    const sanitized = sanitizeSettings(defaultSettings(), { rateLimitMs: 50, enablePlatformActions: true, blockOnThreshold: true })
    expect(sanitized.settings.rateLimitMs).toBeGreaterThanOrEqual(1000)
    expect(sanitized.settings.enablePlatformActions).toBe(true)
    expect(sanitized.settings.blockOnThreshold).toBe(true)
  })

  it('shows the Mark bar by default, and sanitize keeps a Mark bar choice', () => {
    expect(defaultSettings().markBarEnabled).toBe(true)
    const off = sanitizeSettings(defaultSettings(), { markBarEnabled: false })
    expect(off.settings.markBarEnabled).toBe(false)
    const bad = sanitizeSettings(defaultSettings(), { markBarEnabled: 'yes' })
    expect(bad.settings.markBarEnabled).toBe(true)
  })
})
