import { describe, expect, it } from 'vitest'
import { mergeSettings } from '@/shared/storage'
import { DEFAULT_UI_FONT, clampUiFontSize, uiFontZoom } from '@/shared/ui-font'

describe('ui font size', () => {
  it('defaults one step above the original 14px body and snaps odd values', () => {
    expect(mergeSettings(undefined).uiFontSize).toBe(DEFAULT_UI_FONT)
    expect(mergeSettings({}).uiFontSize).toBe(15)
    expect(mergeSettings({ uiFontSize: 14 }).uiFontSize).toBe(14)
    expect(mergeSettings({ uiFontSize: 17 }).uiFontSize).toBe(16)
    expect(mergeSettings({ uiFontSize: 99 }).uiFontSize).toBe(20)
    expect(clampUiFontSize('nope')).toBe(15)
    expect(uiFontZoom(14)).toBe(1)
    expect(uiFontZoom(15)).toBeCloseTo(15 / 14)
  })
})
