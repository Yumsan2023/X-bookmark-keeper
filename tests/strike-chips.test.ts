import { describe, expect, it } from 'vitest'
import dict from '@/strike/i18n.json'
import { autoPlatformAllowed, timelineChrome } from '@/strike/lib/pure.js'

const platformOn = {
  enablePlatformActions: true,
  muteOnThreshold: true,
  blockOnThreshold: true,
}

describe('timeline protect badge and tag chips', () => {
  it('paints Protected / 已关注保护 for a followed account and does not describe an enqueue', () => {
    const zh = timelineChrome({ followed: true, counts: { Spam: 2 } }, { lang: 'zh' })
    expect(zh.protect).toMatchObject({ reason: 'following', text: '已关注保护', titleKey: 'protectFollowing' })
    expect(zh.chips.map((chip) => chip.text)).toEqual(['垃圾×2'])
    expect(zh).not.toHaveProperty('mute')
    expect(zh).not.toHaveProperty('block')

    const en = timelineChrome({ followed: true }, { lang: 'en' })
    expect(en.protect).toMatchObject({ reason: 'following', text: 'Protected', titleKey: 'protectFollowing' })
    expect(en.chips).toEqual([])
  })

  it('uses 白名单保护 when the account is whitelisted but not followed', () => {
    const view = timelineChrome({ whitelist: true, followed: false, counts: {} }, { lang: 'zh' })
    expect(view.protect).toMatchObject({ reason: 'whitelist', text: '白名单保护', titleKey: 'protectWhitelist' })
    const en = timelineChrome({ whitelist: true, followed: false }, { lang: 'en' })
    expect(en.protect).toMatchObject({ text: 'Protected', reason: 'whitelist', titleKey: 'protectWhitelist' })
  })

  it('keeps the followed badge when the account is both followed and whitelisted', () => {
    const view = timelineChrome({ whitelist: true, followed: true, counts: { Marketing: 1 } }, { lang: 'zh' })
    expect(view.protect).toMatchObject({ reason: 'both', text: '已关注保护', titleKey: 'protectBoth' })
    expect(view.chips).toEqual([
      { name: 'Marketing', tone: 'marketing', count: 1, text: '营销×1', more: false },
    ])
  })

  it('lets the live follow state override the stored flag', () => {
    expect(timelineChrome({ followed: true, whitelist: false }, { followed: false }).protect).toBeNull()
    expect(timelineChrome({ followed: false, whitelist: false }, { followed: true, lang: 'en' }).protect)
      .toMatchObject({ reason: 'following', text: 'Protected' })
    expect(timelineChrome({ followed: true, whitelist: true }, { followed: false, lang: 'zh' }).protect)
      .toMatchObject({ reason: 'whitelist', text: '白名单保护' })
  })

  it('shows no protect badge when follow state is unknown and the account is not whitelisted', () => {
    expect(timelineChrome({ followed: null, whitelist: false }, { lang: 'en' }).protect).toBeNull()
    expect(timelineChrome({}, {}).protect).toBeNull()
  })

  it('formats compact chips, drops empty counts, and caps the row', () => {
    const account = {
      counts: { Spam: 2, Marketing: 1, Alpha: 3, Beta: 4, Gamma: 5, Delta: 6, Empty: 0, Bad: Number.NaN, '!!!': 9 },
    }
    const view = timelineChrome(account, { lang: 'en', limit: 4 })
    expect(view.chips.map((chip) => chip.text)).toEqual(['Spam×2', 'Marketing×1', 'Delta×6', 'Gamma×5', '+2'])
    expect(view.chips.at(-1)).toMatchObject({ more: true, tone: 'more', count: 2, name: '' })
    expect(view.chips[0]).toMatchObject({ name: 'Spam', tone: 'spam', count: 2, more: false })
    expect(account.counts).toMatchObject({ Spam: 2, Empty: 0 })
  })

  it('merges aliases onto Spam and Marketing before painting', () => {
    const view = timelineChrome({ counts: { spam: 1, Spam: 1, MARKETING: 2, Promo: 4 } }, { lang: 'zh' })
    expect(view.chips.map((chip) => chip.text)).toEqual(['垃圾×2', '营销×2', 'Promo×4'])
  })

  it('has a tooltip string for every protect reason', () => {
    for (const lang of ['zh', 'en'] as const) {
      const bag = dict[lang]
      expect(bag.protectFollowing).toMatch(/静音|mute/i)
      expect(bag.protectWhitelist).toMatch(/白名单|whitelist/i)
      expect(bag.protectBoth.length).toBeGreaterThan(8)
      expect(bag.chipOpen.length).toBeGreaterThan(4)
      expect(bag.chipMore).toContain('{count}')
    }
  })

  it('still refuses auto mute and block for the accounts the badge marks as protected', () => {
    expect(autoPlatformAllowed(platformOn, { whitelist: true, followed: false }, 'mute')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: true }, 'block')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: true, followed: true }, 'mute')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: null }, 'mute')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: false }, 'mute')).toBe(true)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: false }, 'block')).toBe(true)
  })
})
