import { describe, expect, it } from 'vitest'
import {
  commentScanDecision,
  defaultKeywordPacks,
  defaultSettings,
  foldReasonSummary,
  freshState,
  matchRules,
  normalizeState,
  sanitizeSettings,
} from '@/strike/lib/pure.js'

describe('collapse bar reason', () => {
  it('defaults to showing a reason and keeps that choice across sanitize', () => {
    expect(defaultSettings().foldReasonEnabled).toBe(true)
    expect(freshState(1).settings.foldReasonEnabled).toBe(true)

    const untouched = sanitizeSettings(defaultSettings(), {})
    expect(untouched.settings.foldReasonEnabled).toBe(true)

    const off = sanitizeSettings(defaultSettings(), { foldReasonEnabled: false })
    expect(off.settings.foldReasonEnabled).toBe(false)
    expect(off.settings.commentScanEnabled).toBe(false)
    expect(off.settings.commentHitMode).toBe('fold')
    expect(off.settings.defaultThreshold).toBe(3)

    const ignored = sanitizeSettings(defaultSettings(), { foldReasonEnabled: 'no' as unknown as boolean })
    expect(ignored.settings.foldReasonEnabled).toBe(true)

    const loaded = normalizeState({ settings: { language: 'zh', foldReasonEnabled: false } }, 2)
    expect(loaded.settings.foldReasonEnabled).toBe(false)
    const legacy = normalizeState({ settings: { language: 'en', commentScanEnabled: true } }, 2)
    expect(legacy.settings.foldReasonEnabled).toBe(true)
    expect(legacy.settings.commentScanEnabled).toBe(true)
  })

  it('names the main keyword and collapses the rest, without striking or queueing', () => {
    const state = freshState(1)
    const before = JSON.stringify({ ledger: state.ledger, queue: state.queue, hidden: state.hidden, vetoes: state.vetoes })
    const hit = matchRules(defaultKeywordPacks(), { text: '加微信 领资料 空投', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.reasons.length).toBeGreaterThan(1)
    expect(hit.reasons.every((reason) => reason.patternType === 'keyword' || reason.patternType === 'regex')).toBe(true)

    const summary = foldReasonSummary({ reasons: hit.reasons, aiLabel: 'Marketing' })
    expect(summary?.source).toBe('keyword')
    expect(summary?.pattern).toBe('空投')
    expect(summary?.extra).toBe(hit.reasons.length - 1 + 1)
    expect(summary?.aiLabel).toBe('Marketing')
    expect(`${summary?.pattern} +${summary?.extra}`.length).toBeLessThan(24)

    const folded = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: hit.suspect,
      followed: false,
      whitelist: false,
    })
    expect(folded).toMatchObject({ fold: true, queueMute: false, queueBlock: false, confirmStrike: true })
    expect(commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: true,
      whitelist: false,
    }).fold).toBe(false)
    expect(commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: true,
    }).fold).toBe(false)
    expect(JSON.stringify({ ledger: state.ledger, queue: state.queue, hidden: state.hidden, vetoes: state.vetoes })).toBe(before)
  })

  it('prefers a firm readable word over a long regex and a cooled hit', () => {
    const summary = foldReasonSummary({
      reasons: [
        {
          pattern: '(?i)t\\.me/[a-z0-9_]{3,}',
          patternType: 'regex',
          packName: '联系方式',
          suggestTag: 'Spam',
        },
        {
          pattern: '加微信',
          patternType: 'keyword',
          packName: '营销引流',
          suggestTag: 'Marketing',
        },
        {
          pattern: '空投',
          patternType: 'keyword',
          packName: '垃圾',
          suggestTag: 'Spam',
          cooled: true,
        },
      ],
    })
    expect(summary).toMatchObject({ source: 'keyword', pattern: '加微信', extra: 2, aiLabel: '' })
    expect(summary?.pattern.length).toBeLessThanOrEqual(18)
  })

  it('shows a short rule and packs patterns that would fill the row', () => {
    const short = foldReasonSummary({
      reasons: [{ pattern: '(?i)t\\.me/abc', patternType: 'regex', packName: '联系方式', suggestTag: 'Spam' }],
    })
    expect(short).toMatchObject({ source: 'regex', pattern: 't\\.me/abc', extra: 0 })
    expect(short?.pattern.length).toBeLessThanOrEqual(18)

    const packed = foldReasonSummary({
      reasons: [
        { pattern: '(?i)(微信|薇信|vx|v信)\\s*[:：]?\\s*[a-z0-9_-]{4,}', patternType: 'regex', packName: '联系方式', suggestTag: 'Spam' },
        { pattern: `(?i)bit\\.ly/${'x'.repeat(24)}`, patternType: 'regex', packName: '短链', suggestTag: 'Spam' },
      ],
      aiLabel: 'none',
    })
    expect(packed).toMatchObject({ source: 'pack', pattern: '', extra: 2, aiLabel: '' })
  })

  it('falls back to the existing AI label, then to tag chip text', () => {
    expect(foldReasonSummary({ aiLabel: 'Spam' })).toMatchObject({ source: 'ai', aiLabel: 'Spam', extra: 0, pattern: '' })
    expect(foldReasonSummary({ aiLabel: 'none' })).toBeNull()
    expect(foldReasonSummary({
      tags: [
        { name: 'Spam', text: '垃圾×3' },
        { name: 'Marketing', text: '营销×1' },
        { name: '', text: '+1', more: true },
      ],
    })).toMatchObject({ source: 'tag', tagText: '垃圾×3', extra: 1 })
  })

  it('hides the reason text when the option is off and still returns nothing for an empty card', () => {
    const reasons = [{ pattern: '空投', patternType: 'keyword', packName: '垃圾', suggestTag: 'Spam' }]
    expect(foldReasonSummary({ enabled: false, reasons, aiLabel: 'Spam', tags: [{ text: '垃圾×1' }] })).toBeNull()
    expect(foldReasonSummary({})).toBeNull()
    expect(foldReasonSummary({ reasons: [{ pattern: '  ', packName: '' }] })).toBeNull()
  })
})
