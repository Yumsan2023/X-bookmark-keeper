/** Original body size. Zoom is `uiFontSize / UI_FONT_BASE`, so 14 leaves the layout unchanged. */
export const UI_FONT_BASE = 14

/** Discrete text sizes offered in Settings. */
export const UI_FONT_STEPS = [13, 14, 15, 16, 18, 20] as const

export const DEFAULT_UI_FONT = 15

export function clampUiFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_UI_FONT
  let best: number = UI_FONT_STEPS[0]
  let bestDist = Infinity
  for (const step of UI_FONT_STEPS) {
    const dist = Math.abs(step - n)
    if (dist < bestDist) {
      best = step
      bestDist = dist
    }
  }
  return best
}

/** Chrome `zoom` on the document element. Scales px fonts, cards, and shadow DOM together. */
export function uiFontZoom(value: unknown): number {
  return clampUiFontSize(value) / UI_FONT_BASE
}

export function applyUiFontSize(value: unknown): void {
  if (typeof document === 'undefined') return
  const zoom = uiFontZoom(value)
  document.documentElement.style.zoom = String(zoom)
  document.documentElement.style.setProperty('--ui-zoom', String(zoom))
}
