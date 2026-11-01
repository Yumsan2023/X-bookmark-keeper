import { describe, expect, it } from 'vitest'
import {
  applyActions,
  applyMark,
  applyUndo,
  autoPlatformAllowed,
  commentScanDecision,
  commentStrikePlatform,
  communityListDecision,
  defaultKeywordPacks,
  foldReasonSummary,
  freshState,
  matchCommunityLists,
  matchRules,
  normalizeState,
  packsToText,
  parseKeywordPackText,
  ruleEnqueueGate,
  sanitizeSettings,
  setWhitelist,
} from '@/strike/lib/pure.js'

const NOW = 1_700_000_000_000

type Pack = {
  id: string
  name: string
  enabled: boolean
  suggestTag: string
  patterns: Array<{ type: string; target: string; value: string; enqueue?: boolean }>
}

type TagRow = { name: string; count: number; queueSkipped?: number }
type Ledger = {
  settings: {
    actionMode: string
    enablePlatformActions: boolean
    muteOnThreshold: boolean
    blockOnThreshold: boolean
    hideOnThreshold: boolean
    tagThresholds: Record<string, number>
    keywordPacks: Pack[]
  }
  ledger: Record<string, { tags: TagRow[] }>
  queue: Array<{ type: string }>
  hidden: Record<string, unknown>
}

function state() {
  const next = freshState(NOW) as unknown as Ledger
  next.settings.actionMode = 'auto'
  next.settings.enablePlatformActions = true
  next.settings.muteOnThreshold = true
  next.settings.blockOnThreshold = true
  next.settings.hideOnThreshold = true
  next.settings.tagThresholds = { Spam: 3, Marketing: 3 }
  return next
}

function packs(patterns: Pack['patterns'][]): Pack[] {
  return patterns.map((rows, index) => ({
    id: `p${index}`,
    name: `Pack ${index}`,
    enabled: true,
    suggestTag: 'Spam',
    patterns: rows,
  }))
}

function mark(ledger: Ledger, tweetId: string, now: number, queueEligible?: boolean) {
  return applyMark(ledger, {
    tag: 'Spam',
    handle: 'spammer',
    tweetId,
    textSnippet: 'spam',
    followed: false,
    source: 'rule',
    ...(queueEligible === false ? { queueEligible: false } : {}),
  }, now)
}

describe('per-rule enqueue switch', () => {
  it('keeps the default: a hit can yellow-flag and still count toward mute/block', () => {
    const hit = matchRules(defaultKeywordPacks(), { text: '加微信 领资料', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.queueEligible).toBe(true)
    expect(hit.reasons.every((reason) => reason.enqueue === true)).toBe(true)

    const ledger = state()
    mark(ledger, 'aa1', NOW)
    mark(ledger, 'aa2', NOW + 1)
    const third = mark(ledger, 'aa3', NOW + 2)
    expect(third.threshold?.crossed).toBe(true)
    expect(third.threshold?.suggest.mute).toBe(true)
    expect(third.threshold?.suggest.block).toBe(true)
    const queued = applyActions(ledger, {
      userId: third.userId,
      handle: 'spammer',
      hide: true,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 3)
    expect(queued.done).toEqual(['hide', 'mute', 'block'])
    expect(ledger.queue).toHaveLength(2)
  })

  it('still yellow-flags and folds when enqueue is off, and does not queue from that hit alone', () => {
    const rules = packs([[
      { type: 'keyword', target: 'text', value: '空投', enqueue: false },
    ]])
    const hit = matchRules(rules, { text: '今天空投', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.queueEligible).toBe(false)
    expect(hit.reasons[0]).toMatchObject({ pattern: '空投', enqueue: false })
    expect(commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: hit.suspect,
      followed: false,
      whitelist: false,
    })).toMatchObject({ suspect: true, fold: true, queueMute: false, queueBlock: false })
    expect(foldReasonSummary({ reasons: hit.reasons })?.pattern).toBe('空投')

    const ledger = state()
    mark(ledger, 'bb1', NOW, false)
    mark(ledger, 'bb2', NOW + 1, false)
    const third = mark(ledger, 'bb3', NOW + 2, false)
    expect(third.threshold?.count).toBe(3)
    expect(third.threshold?.crossed).toBe(true)
    expect(third.threshold?.suggest.hide).toBe(true)
    expect(third.threshold?.suggest.mute).toBe(false)
    expect(third.threshold?.suggest.block).toBe(false)
    expect(third.threshold?.blockedByRule).toBe(true)
    const gated = ruleEnqueueGate(third.threshold, 'rule', false)
    expect(gated.blockedByRule).toBe(true)
    expect(gated.threshold?.suggest?.mute).toBe(false)
    const applied = applyActions(ledger, {
      userId: third.userId,
      handle: 'spammer',
      hide: true,
      mute: false,
      block: false,
      reason: 'threshold-auto',
    }, NOW + 3)
    expect(applied.done).toEqual(['hide'])
    expect(ledger.queue).toEqual([])
    expect(ledger.hidden[third.userId!]).toBeTruthy()
  })

  it('queues when another enqueue-allowed rule hits and its own strikes fill the threshold', () => {
    const off = packs([[{ type: 'keyword', target: 'text', value: '空投', enqueue: false }]])
    const both = packs([[
      { type: 'keyword', target: 'text', value: '空投', enqueue: false },
      { type: 'keyword', target: 'text', value: '加微信' },
    ]])
    expect(matchRules(off, { text: '只有空投', handle: 'spammer', bio: '' }).queueEligible).toBe(false)
    const mixed = matchRules(both, { text: '空投 加微信', handle: 'spammer', bio: '' })
    expect(mixed.suspect).toBe(true)
    expect(mixed.queueEligible).toBe(true)

    const ledger = state()
    mark(ledger, 'cc1', NOW, false)
    mark(ledger, 'cc2', NOW + 1, false)
    const stillOff = mark(ledger, 'cc3', NOW + 2, false)
    expect(stillOff.threshold?.suggest.mute).toBe(false)
    expect(ledger.queue).toEqual([])

    mark(ledger, 'cc4', NOW + 3)
    mark(ledger, 'cc5', NOW + 4)
    const filled = mark(ledger, 'cc6', NOW + 5)
    expect(filled.threshold?.queueCrossed).toBe(true)
    expect(filled.threshold?.suggest.mute).toBe(true)
    expect(filled.threshold?.suggest.block).toBe(true)
    const queued = applyActions(ledger, {
      userId: filled.userId,
      handle: 'spammer',
      hide: false,
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 6)
    expect(queued.done).toEqual(['mute', 'block'])
    expect(ledger.queue.map((item) => item.type)).toEqual(['mute', 'block'])
  })

  it('does not queue a manual path change: user, shortcut, and AI marks still count', () => {
    const ledger = state()
    const marked = applyMark(ledger, {
      tag: 'Spam',
      handle: 'spammer',
      tweetId: 'user1',
      textSnippet: 'by hand',
      followed: false,
      source: 'user',
    }, NOW)
    expect(ruleEnqueueGate(marked.threshold, 'user', false).threshold?.suggest?.mute).toBe(marked.threshold?.suggest?.mute)
    mark(ledger, 'user2', NOW + 1)
    const third = mark(ledger, 'user3', NOW + 2)
    expect(third.threshold?.suggest.mute).toBe(true)
  })

  it('leaves whitelist, following, unknown follow, comments, and community lists alone', () => {
    const ledger = state()
    mark(ledger, 'wl1', NOW)
    setWhitelist(ledger, { handle: 'spammer', whitelist: true }, NOW + 1)
    mark(ledger, 'wl2', NOW + 2)
    const listed = mark(ledger, 'wl3', NOW + 3)
    expect(listed.threshold?.suggest.mute).toBe(false)
    expect(listed.threshold?.suggest.block).toBe(false)
    expect(applyActions(ledger, {
      userId: listed.userId,
      handle: 'spammer',
      mute: true,
      block: true,
      reason: 'threshold-auto',
    }, NOW + 4).ok).toBe(false)
    expect(ledger.queue).toEqual([])

    const followed = state()
    const friend = applyMark(followed, {
      tag: 'Spam',
      handle: 'friend',
      tweetId: 'fr3',
      textSnippet: 'spam',
      followed: true,
      source: 'rule',
    }, NOW)
    applyMark(followed, { tag: 'Spam', handle: 'friend', tweetId: 'fr1', textSnippet: 'a', followed: true }, NOW + 1)
    const friendThird = applyMark(followed, {
      tag: 'Spam',
      handle: 'friend',
      tweetId: 'fr2',
      textSnippet: 'b',
      followed: true,
    }, NOW + 2)
    expect(friend.threshold?.suggest.mute).toBe(false)
    expect(friendThird.threshold?.suggest.mute).toBe(true)
    expect(autoPlatformAllowed(followed.settings, { followed: true, whitelist: false }, 'mute', 'keyword')).toBe(false)

    const unknown = state()
    applyMark(unknown, { tag: 'Spam', handle: 'ghost', tweetId: 'gh1', textSnippet: 'a' }, NOW)
    applyMark(unknown, { tag: 'Spam', handle: 'ghost', tweetId: 'gh2', textSnippet: 'b' }, NOW + 1)
    const ghost = applyMark(unknown, { tag: 'Spam', handle: 'ghost', tweetId: 'gh3', textSnippet: 'c' }, NOW + 2)
    expect(ghost.threshold?.suggest.mute).toBe(false)
    expect(ghost.threshold?.suggest.block).toBe(false)

    const comment = commentStrikePlatform(friendThird.threshold, 'reply', 'rule')
    const ruled = ruleEnqueueGate(comment.threshold, 'rule', true)
    expect(ruled.threshold?.suggest?.mute).toBe(false)
    expect(ruled.threshold?.suggest?.block).toBe(false)

    const community = matchCommunityLists([{
      id: 'list',
      name: '示例名单',
      enabled: true,
      handles: ['spam_bot'],
      keywords: ['加群领资料'],
    }], { enabled: true, text: '加群领资料', handle: 'spam_bot', bio: '' })
    expect(community).toMatchObject({ recordStrike: false, queueMute: false, queueBlock: false, suspect: true })
    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: false,
      surface: 'timeline',
    })).toMatchObject({ fold: true, recordStrike: false, queueMute: false, queueBlock: false })
  })

  it('persists enqueue:false on one rule or a whole pack, and ignores a cooled rule that would have queued', () => {
    const saved = sanitizeSettings(freshState(NOW).settings, {
      keywordPacks: [{
        id: 'custom',
        name: 'Custom',
        enabled: true,
        suggestTag: 'Spam',
        patterns: [
          { type: 'keyword', target: 'text', value: '空投', enqueue: false },
          { type: 'keyword', target: 'text', value: '加微信', enqueue: true },
          { type: 'regex', target: 'text', value: '(?i)t\\.me/[a-z0-9_]{3,}', enqueue: false },
        ],
      }],
    }).settings
    const stored = (patterns: Array<{ enqueue?: boolean }>) => patterns.map((pattern) => pattern.enqueue)
    expect(stored(saved.keywordPacks[0].patterns as Array<{ enqueue?: boolean }>)).toEqual([false, undefined, false])
    const restored = normalizeState({ settings: saved }, NOW)
    expect(stored(restored.settings.keywordPacks[0].patterns as Array<{ enqueue?: boolean }>)).toEqual([false, undefined, false])

    const text = packsToText(saved.keywordPacks)
    expect(text).toContain('空投 {enqueue:false}')
    expect(text).not.toContain('加微信 {enqueue:false}')
    const parsed = parseKeywordPackText(text)
    const rows = (patterns: Array<{ value: string; enqueue?: boolean }>) => patterns.map((pattern) => ({
      value: pattern.value,
      enqueue: pattern.enqueue,
    }))
    expect(rows(parsed.packs[0].patterns as Array<{ value: string; enqueue?: boolean }>)).toEqual([
      { value: '空投', enqueue: false },
      { value: '加微信', enqueue: undefined },
      { value: '(?i)t\\.me/[a-z0-9_]{3,}', enqueue: false },
    ])

    const whole = parseKeywordPackText('[Quiet]\nenabled: true\nsuggest: Spam\nenqueue: false\n空投\n加微信 {enqueue:true}\n')
    expect(rows(whole.packs[0].patterns as Array<{ value: string; enqueue?: boolean }>)).toEqual([
      { value: '空投', enqueue: false },
      { value: '加微信', enqueue: undefined },
    ])
    expect(packsToText(whole.packs)).toContain('enqueue: false')

    const cooled = matchRules(saved.keywordPacks, {
      text: '空投 加微信',
      handle: 'spammer',
      bio: '',
      now: NOW,
      vetoes: [{
        kind: 'rule',
        until: NOW + 86_400_000,
        packId: 'custom',
        pattern: '加微信',
        patternType: 'keyword',
        target: 'text',
      }],
    })
    expect(cooled.suspect).toBe(true)
    expect(cooled.queueEligible).toBe(false)
  })

  it('undoes an enqueue-off strike without leaving the queue count stuck', () => {
    const ledger = state()
    mark(ledger, 'ud1', NOW, false)
    mark(ledger, 'ud2', NOW + 1, false)
    mark(ledger, 'ud3', NOW + 2, false)
    applyUndo(ledger, NOW + 3)
    const row = Object.values(ledger.ledger)[0]?.tags.find((tag) => tag.name === 'Spam')
    expect(row?.count).toBe(2)
    expect(row?.queueSkipped).toBe(2)
    const third = mark(ledger, 'ud4', NOW + 4)
    mark(ledger, 'ud5', NOW + 5)
    const filled = mark(ledger, 'ud6', NOW + 6)
    expect(third.threshold?.suggest.mute).toBe(false)
    expect(filled.threshold?.queueCrossed).toBe(true)
    expect(filled.threshold?.suggest.mute).toBe(true)
  })
})
