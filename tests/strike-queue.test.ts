import { describe, expect, it } from 'vitest'
import {
  ACTION_JITTER_MIN_MS,
  ACTION_JITTER_SPAN_MS,
  BACKOFF_STEPS_MS,
  QUEUE_ATTEMPTS,
  applyActions,
  applyMark,
  applyUndo,
  autoPlatformAllowed,
  backoffDelayMs,
  beginAction,
  clearQueue,
  enqueue,
  finishAction,
  freshState,
  isRateLimitSignal,
  nextActionDelayMs,
  normalizeState,
  peekAction,
  processorHold,
  queueDashboard,
  retryFailed,
  setQueuePaused,
  setWhitelist,
} from '@/strike/lib/pure.js'

const NOW = 1_700_000_000_000

type QItem = {
  id: string
  type: string
  handle: string
  status: string
  source: string
  attempts: number
  lastError: string
}

type State = {
  settings: {
    actionMode: string
    enablePlatformActions: boolean
    muteOnThreshold: boolean
    blockOnThreshold: boolean
    hideOnThreshold: boolean
    dailyCap: number
    rateLimitMs: number
  }
  ledger: Record<string, { whitelist?: boolean; followed?: boolean | null }>
  hidden: Record<string, unknown>
  queue: QItem[]
  rate: {
    day: string
    count: number
    nextAllowed: number
    paused: boolean
    backoffUntil: number
    lastError: string
    rateStrikes: number
  }
}

function newState() {
  return freshState(NOW) as unknown as State
}

function ready(state: State, mode: 'auto' | 'confirm' | 'prompt-only' = 'auto') {
  state.settings.actionMode = mode
  state.settings.enablePlatformActions = true
  state.settings.muteOnThreshold = true
  state.settings.blockOnThreshold = true
  state.settings.hideOnThreshold = true
  state.settings.dailyCap = 20
  state.settings.rateLimitMs = 1200
}

function account(state: State, handle: string, followed?: boolean) {
  const input: { tag: string; handle: string; tweetId: string; textSnippet: string; followed?: boolean } = {
    tag: 'Spam',
    handle,
    tweetId: `${handle}1`,
    textSnippet: 'spam one',
  }
  if (followed === true || followed === false) input.followed = followed
  applyMark(state, { ...input, tweetId: `${handle.slice(0, 8)}1` }, NOW)
  applyMark(state, { ...input, tweetId: `${handle.slice(0, 8)}2` }, NOW + 1)
  return applyMark(state, { ...input, tweetId: `${handle.slice(0, 8)}3` }, NOW + 2)
}

describe('mute/block queue', () => {
  it('spaces menu actions by the configured floor plus at least one second of jitter', () => {
    expect(nextActionDelayMs(1000, 0)).toBe(2000)
    expect(nextActionDelayMs(1200, () => 0)).toBe(1200 + ACTION_JITTER_MIN_MS)
    expect(nextActionDelayMs(50, 0)).toBe(1000 + ACTION_JITTER_MIN_MS)
    expect(nextActionDelayMs(1000, 1)).toBe(1000 + ACTION_JITTER_MIN_MS + ACTION_JITTER_SPAN_MS)
    expect(ACTION_JITTER_MIN_MS).toBeGreaterThanOrEqual(1000)
    expect(backoffDelayMs(1)).toBe(BACKOFF_STEPS_MS[0])
    expect(backoffDelayMs(9)).toBe(BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1])
  })

  it('recognizes rate-limit notices and ignores ordinary menu failures', () => {
    expect(isRateLimitSignal('HTTP 429')).toBe(true)
    expect(isRateLimitSignal('Rate limit exceeded')).toBe(true)
    expect(isRateLimitSignal('Too many requests, try again later')).toBe(true)
    expect(isRateLimitSignal('操作过于频繁，请稍后再试')).toBe(true)
    expect(isRateLimitSignal('no-item')).toBe(false)
    expect(isRateLimitSignal('Mute @spammer')).toBe(false)
    expect(isRateLimitSignal('Something went wrong')).toBe(false)
  })

  it('enqueues auto mute/block instead of running them, and refuses whitelist, following, and non-auto modes', () => {
    const state = newState()
    ready(state, 'auto')
    const marked = account(state, 'spammer', false)
    expect(marked.threshold?.suggest.mute).toBe(true)
    expect(marked.threshold?.suggest.block).toBe(true)
    const queued = applyActions(state, {
      userId: marked.userId,
      handle: 'spammer',
      hide: true,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 3)
    expect(queued.ok).toBe(true)
    expect(queued.done).toEqual(['hide', 'mute', 'block'])
    expect(state.queue).toHaveLength(2)
    expect(state.queue.map((item) => item.type)).toEqual(['mute', 'block'])
    expect(state.queue.every((item) => item.status === 'pending' && item.source === 'auto')).toBe(true)

    const again = enqueue(state, { handle: 'spammer', type: 'mute', source: 'auto' }, NOW + 4)
    expect(again.duplicate).toBe(true)
    expect(state.queue).toHaveLength(2)

    const listed = newState()
    ready(listed, 'auto')
    const followed = account(listed, 'friend', true)
    const skippedFollow = applyActions(listed, {
      userId: followed.userId,
      handle: 'friend',
      hide: true,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 3)
    expect(skippedFollow).toMatchObject({ ok: false, error: 'following' })
    expect(listed.queue).toHaveLength(0)
    expect(listed.hidden).toEqual({})

    const safe = newState()
    ready(safe, 'auto')
    const markedSafe = account(safe, 'spammer', false)
    setWhitelist(safe, { userId: markedSafe.userId, handle: 'spammer', whitelist: true }, NOW + 3)
    const skippedList = applyActions(safe, {
      userId: markedSafe.userId,
      handle: 'spammer',
      hide: true,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 4)
    expect(skippedList).toMatchObject({ ok: false, error: 'whitelist' })
    expect(safe.queue).toHaveLength(0)

    const unknown = newState()
    ready(unknown, 'auto')
    const markedUnknown = account(unknown, 'maybeuser')
    expect(autoPlatformAllowed(unknown.settings, unknown.ledger[markedUnknown.userId], 'mute')).toBe(false)
    const unknownResult = applyActions(unknown, {
      userId: markedUnknown.userId,
      handle: 'maybeuser',
      hide: true,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 3)
    expect(unknownResult.done).toEqual(['hide'])
    expect(unknown.queue).toHaveLength(0)

    for (const mode of ['confirm', 'prompt-only'] as const) {
      const held = newState()
      ready(held, mode)
      const row = account(held, 'spammer', false)
      const refused = applyActions(held, {
        userId: row.userId,
        handle: 'spammer',
        hide: true,
        mute: true,
        block: true,
        reason: 'threshold-auto',
      }, NOW + 3)
      expect(refused).toMatchObject({ ok: false, error: 'not-auto' })
      expect(held.queue).toHaveLength(0)
      expect(held.hidden).toEqual({})
    }
  })

  it('lets the user queue mute/block explicitly, including after a confirm, without dropping that request', () => {
    const state = newState()
    ready(state, 'confirm')
    const marked = account(state, 'spammer', false)
    setWhitelist(state, { userId: marked.userId, handle: 'spammer', whitelist: true }, NOW + 3)
    const queued = applyActions(state, {
      userId: marked.userId,
      handle: 'spammer',
      mute: true,
      reason: 'manual',
    }, NOW + 4)
    expect(queued.ok).toBe(true)
    expect(state.queue).toHaveLength(1)
    expect(state.queue[0].source).toBe('manual')
    const begun = beginAction(state, state.queue[0].id, NOW + 4)
    expect(begun.ok).toBe(true)
    expect(state.queue[0].status).toBe('inflight')
  })

  it('drops an automatic queue item if the account is whitelisted before the click', () => {
    const state = newState()
    ready(state, 'auto')
    const marked = account(state, 'spammer', false)
    applyActions(state, {
      userId: marked.userId,
      handle: 'spammer',
      mute: true,
      reason: 'threshold-auto',
    }, NOW + 3)
    setWhitelist(state, { userId: marked.userId, handle: 'spammer', whitelist: true }, NOW + 4)
    const begun = beginAction(state, state.queue[0].id, NOW + 5)
    expect(begun).toMatchObject({ ok: false, error: 'whitelist', changed: true })
    expect(state.queue).toHaveLength(0)
  })

  it('holds the processor for jitter, the daily cap, backoff, and pause', () => {
    const state = newState()
    ready(state, 'confirm')
    state.settings.dailyCap = 5
    const first = enqueue(state, { handle: 'spammer', type: 'mute', source: 'manual' }, NOW)
    const begun = beginAction(state, first.item.id, NOW)
    expect(begun.ok).toBe(true)
    const gap = state.rate.nextAllowed - NOW
    expect(gap).toBeGreaterThanOrEqual(1200 + ACTION_JITTER_MIN_MS)
    expect(gap).toBeLessThanOrEqual(1200 + ACTION_JITTER_MIN_MS + ACTION_JITTER_SPAN_MS)

    const second = enqueue(state, { handle: 'otheracct', type: 'block', source: 'manual' }, NOW + 1)
    const early = beginAction(state, second.item.id, NOW + 10)
    expect(early).toMatchObject({ ok: false, error: 'rate' })
    expect(state.rate.count).toBe(1)

    finishAction(state, { id: first.item.id, ok: true }, NOW + 20)
    state.rate.nextAllowed = 0
    state.rate.count = state.settings.dailyCap
    const capped = beginAction(state, second.item.id, NOW + 20)
    expect(capped).toMatchObject({ ok: false, error: 'daily-cap' })
    expect(state.rate.count).toBe(state.settings.dailyCap)
    expect(state.queue.map((item) => item.handle)).toEqual(['otheracct'])

    state.rate.count = 0
    const limited = beginAction(state, second.item.id, NOW + 30)
    expect(limited.ok).toBe(true)
    const failed = finishAction(state, {
      id: second.item.id,
      ok: false,
      error: '429 Too many requests',
      rateLimited: true,
    }, NOW + 40)
    expect(failed.rateLimited).toBe(true)
    expect(state.rate.backoffUntil).toBe(NOW + 40 + BACKOFF_STEPS_MS[0])
    expect(state.queue[0].status).toBe('pending')
    expect(queueDashboard(state, NOW + 40).lastError).toContain('429')
    expect(processorHold(state, NOW + 50).hold).toBe('backoff')
    const during = beginAction(state, second.item.id, NOW + 50)
    expect(during).toMatchObject({ ok: false, error: 'backoff' })

    setQueuePaused(state, true, NOW + 60)
    expect(processorHold(state, state.rate.backoffUntil).hold).toBe('paused')
    const paused = beginAction(state, second.item.id, state.rate.backoffUntil)
    expect(paused).toMatchObject({ ok: false, error: 'paused' })
    setQueuePaused(state, false, NOW + 70)
    const resumed = beginAction(state, second.item.id, state.rate.backoffUntil)
    expect(resumed.ok).toBe(true)
    finishAction(state, { id: second.item.id, ok: true }, state.rate.backoffUntil + 10)
    expect(state.rate.rateStrikes).toBe(0)
    expect(state.rate.backoffUntil).toBe(0)
    expect(state.rate.lastError).toBe('')
    expect(state.queue).toHaveLength(0)
  })

  it('retries failed items, clears pending without dropping failures, and prefers a visible handle', () => {
    const state = newState()
    ready(state, 'confirm')
    const mute = enqueue(state, { handle: 'spammer', type: 'mute', source: 'manual' }, NOW)
    const block = enqueue(state, { handle: 'otheracct', type: 'block', source: 'manual' }, NOW)
    expect(peekAction(state, NOW)?.handle).toBe('spammer')
    expect(peekAction(state, NOW, { handles: ['otheracct'] })?.id).toBe(block.item.id)
    expect(peekAction(state, NOW, { handles: [] })).toBeNull()

    let t = NOW
    for (let i = 0; i < QUEUE_ATTEMPTS; i += 1) {
      const begun = beginAction(state, mute.item.id, t)
      expect(begun.ok).toBe(true)
      finishAction(state, { id: mute.item.id, ok: false, error: 'no-item' }, t + 5)
      t = state.rate.nextAllowed
    }
    expect(state.queue.find((item) => item.id === mute.item.id)?.status).toBe('failed')
    expect(queueDashboard(state, t).failedItems.map((item: { handle: string }) => item.handle)).toEqual(['spammer'])
    expect(clearQueue(state, 'pending').removed).toBe(1)
    expect(state.queue).toHaveLength(1)
    expect(retryFailed(state).retried).toBe(1)
    expect(state.queue[0].status).toBe('pending')
    expect(clearQueue(state, 'failed').removed).toBe(0)
    expect(clearQueue(state, 'pending').removed).toBe(1)
    expect(state.queue).toHaveLength(0)
    expect(processorHold(state, t).hold).toBeNull()
  })

  it('keeps pause, backoff, and queue source across normalize, and undoes a menu action through the queue', () => {
    const state = newState()
    ready(state, 'confirm')
    const queued = enqueue(state, { handle: 'spammer', type: 'mute', source: 'manual' }, NOW)
    beginAction(state, queued.item.id, NOW)
    finishAction(state, { id: queued.item.id, ok: true }, NOW + 5)
    const undone = applyUndo(state, NOW + 6)
    expect(undone.ok).toBe(true)
    expect(state.queue[0]).toMatchObject({ type: 'unmute', source: 'undo', handle: 'spammer' })

    state.rate.paused = true
    state.rate.backoffUntil = NOW + 5000
    state.rate.lastError = '429'
    state.rate.rateStrikes = 2
    const restored = normalizeState(state, NOW + 7) as unknown as State
    expect(restored.rate.paused).toBe(true)
    expect(restored.rate.backoffUntil).toBe(NOW + 5000)
    expect(restored.rate.rateStrikes).toBe(2)
    expect(restored.queue[0].source).toBe('undo')

    const legacy = structuredClone(newState()) as {
      rate: { paused?: boolean; day: string; count: number; nextAllowed: number }
      queue: unknown[]
    }
    delete legacy.rate.paused
    legacy.queue = [{
      id: 'q-old',
      type: 'block',
      userId: 'h:spammer',
      handle: 'spammer',
      status: 'pending',
      attempts: 1,
      createdAt: NOW,
    }]
    const upgraded = normalizeState(legacy, NOW) as unknown as State
    expect(upgraded.rate.paused).toBe(false)
    expect(upgraded.rate.backoffUntil).toBe(0)
    expect(upgraded.queue[0].source).toBe('auto')
  })
})
