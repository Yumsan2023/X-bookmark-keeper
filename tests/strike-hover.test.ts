import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, freshState, normalizeState, sanitizeSettings } from '@/strike/lib/pure.js'
import {
  PARTNERSHIP_HOURLY_CAP,
  PARTNERSHIP_MIN_GAP_MS,
  PARTNERSHIP_READ_OPS,
  collectPartnershipSample,
  collectUserTweetPage,
  describeHoverCard,
  formatPartnershipLine,
  heuristicPaidText,
  isPaidPartnershipLabel,
  lookupPartnershipCache,
  pageReachedWindowEnd,
  partnershipFromError,
  rememberPartnership,
  reservePartnershipSlot,
  runPartnershipStats,
  summarizePartnershipSample,
} from '@/strike/lib/partnership.js'

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function stamp(ms: number) {
  return new Date(ms).toUTCString()
}

function tweet(partial: {
  id: string
  at: number
  userId?: string
  disclosure?: string | null
  disclosurePresent?: boolean
  reply?: boolean
  retweet?: boolean
  text?: string
  extra?: Record<string, unknown>
}) {
  const userId = partial.userId || '42'
  const node: Record<string, unknown> = {
    __typename: 'Tweet',
    rest_id: partial.id,
    legacy: {
      id_str: partial.id,
      created_at: stamp(partial.at),
      full_text: partial.text ?? 'hello',
      user_id_str: userId,
      ...(partial.reply ? { in_reply_to_status_id_str: '9' } : {}),
      ...(partial.retweet ? { retweeted_status_result: { result: { rest_id: '1' } } } : {}),
    },
    core: { user_results: { result: { rest_id: userId, legacy: { screen_name: 'ada' } } } },
    ...(partial.extra || {}),
  }
  if (partial.disclosurePresent !== false) node.disclosure_type = partial.disclosure ?? null
  return node
}

function page(tweets: unknown[], cursor?: string, pin?: unknown) {
  const entries = tweets.map((node) => ({
    entryId: `tweet-${(node as { rest_id: string }).rest_id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', tweet_results: { result: node } },
    },
  }))
  if (cursor) {
    entries.push({
      entryId: 'cursor-bottom',
      content: {
        entryType: 'TimelineTimelineCursor',
        cursorType: 'Bottom',
        value: cursor,
      },
    } as unknown as (typeof entries)[number])
  }
  const instructions: unknown[] = []
  if (pin) {
    instructions.push({
      type: 'TimelinePinEntry',
      entry: { content: { itemContent: { tweet_results: { result: pin } } } },
    })
  }
  instructions.push({ type: 'TimelineAddEntries', entries })
  return { data: { user: { result: { timeline_v2: { timeline: { instructions } } } } } }
}

function userPayload(id = '42', screen = 'ada') {
  return { data: { user: { result: { rest_id: id, legacy: { screen_name: screen } } } } }
}

describe('paid partnership sample', () => {
  it('counts PaidPartnership on original posts and ignores replies, reposts, and older posts', () => {
    const items = [
      { tweet: tweet({ id: '1', at: NOW - 2 * DAY, disclosure: 'PaidPartnership' }) },
      { tweet: tweet({ id: '2', at: NOW - 3 * DAY, disclosure: null }) },
      { tweet: tweet({ id: '3', at: NOW - DAY, disclosure: 'NoDisclosure', reply: true }) },
      { tweet: tweet({ id: '4', at: NOW - DAY, disclosure: 'PaidPartnership', retweet: true }) },
      { tweet: tweet({ id: '5', at: NOW - 40 * DAY, disclosure: 'PaidPartnership' }) },
      { tweet: tweet({ id: '6', at: NOW - DAY, disclosure: null, userId: '7' }) },
    ]
    const summary = summarizePartnershipSample(items, { now: NOW, userId: '42', handle: 'ada' })
    expect(summary).toMatchObject({
      status: 'ok',
      source: 'disclosure',
      uncertain: false,
      originalCount: 2,
      paidCount: 1,
      ratio: 0.5,
    })
    expect(formatPartnershipLine({ ratioEnabled: true, partnership: summary }, 'zh').text)
      .toBe('付费合作占比：50%（1/2，近约 30 天原创）')
  })

  it('treats an explicit empty disclosure as a real 0%', () => {
    const items = [
      { tweet: tweet({ id: '1', at: NOW - DAY, disclosure: null }) },
      { tweet: tweet({ id: '2', at: NOW - 2 * DAY, disclosure: 'NoDisclosure' }) },
    ]
    const summary = summarizePartnershipSample(items, { now: NOW, userId: '42', handle: 'ada' })
    expect(summary).toMatchObject({ status: 'ok', source: 'disclosure', paidCount: 0, ratio: 0, uncertain: false })
    expect(formatPartnershipLine({ ratioEnabled: true, partnership: summary }, 'zh').text)
      .toContain('0%（0/2')
  })

  it('does not invent 0% when the response has no partnership field', () => {
    const items = [
      { tweet: tweet({ id: '1', at: NOW - DAY, disclosurePresent: false, extra: { quick_promote_eligibility: { eligibility: 'Eligible' } } }) },
      { tweet: tweet({ id: '2', at: NOW - 2 * DAY, disclosurePresent: false, text: 'a normal post about partnerships later in the text\nPaid partnership' }) },
    ]
    const summary = summarizePartnershipSample(items, { now: NOW, userId: '42', handle: 'ada' })
    expect(summary.status).toBe('unavailable')
    expect(summary.reason).toBe('field-missing')
    expect(summary.ratio).toBeNull()
    expect(summary.paidCount).toBe(0)
    const line = formatPartnershipLine({ ratioEnabled: true, partnership: summary }, 'zh')
    expect(line.text).toContain('暂无法统计')
    expect(line.text).not.toContain('0%')
  })

  it('reads the legacy ext disclosure field and a payload label', () => {
    const ext = tweet({
      id: '1',
      at: NOW - DAY,
      disclosurePresent: false,
      extra: { ext: { disclosureType: { r: { ok: { disclosureType: 'PaidPartnership' } } } } },
    })
    const plain = tweet({
      id: '2',
      at: NOW - 2 * DAY,
      disclosurePresent: false,
      extra: { ext: { disclosureType: { r: { ok: { disclosureType: 'NoDisclosure' } } } } },
    })
    const fromExt = summarizePartnershipSample([{ tweet: ext }, { tweet: plain }], { now: NOW, userId: '42', handle: 'ada' })
    expect(fromExt).toMatchObject({ status: 'ok', source: 'disclosure', paidCount: 1, originalCount: 2, uncertain: false })

    const labeled = tweet({
      id: '3',
      at: NOW - DAY,
      disclosurePresent: false,
      extra: { socialContext: { text: '付费合作' } },
    })
    const other = tweet({ id: '4', at: NOW - DAY, disclosurePresent: false })
    const fromLabel = summarizePartnershipSample([{ tweet: labeled }, { tweet: other }], { now: NOW, userId: '42', handle: 'ada' })
    expect(fromLabel).toMatchObject({ status: 'ok', source: 'label', uncertain: true, paidCount: 1, originalCount: 2 })
    expect(formatPartnershipLine({ ratioEnabled: true, partnership: fromLabel }, 'zh').text).toContain('可能不完整')
  })

  it('marks a first-line text heuristic as uncertain and ignores a zero heuristic', () => {
    expect(heuristicPaidText('Paid partnership\nrest of the post')).toBe(true)
    expect(heuristicPaidText('#ad code')).toBe(true)
    expect(heuristicPaidText('hello\nPaid partnership')).toBe(false)
    expect(isPaidPartnershipLabel('Paid partnership')).toBe(true)
    expect(isPaidPartnershipLabel('not a paid partnership post')).toBe(false)

    const hit = summarizePartnershipSample([
      { tweet: tweet({ id: '1', at: NOW - DAY, disclosurePresent: false, text: '付费合作' }) },
      { tweet: tweet({ id: '2', at: NOW - DAY, disclosurePresent: false, text: 'ordinary' }) },
    ], { now: NOW, userId: '42', handle: 'ada' })
    expect(hit).toMatchObject({ status: 'ok', source: 'heuristic', uncertain: true, paidCount: 1, originalCount: 2 })
    expect(formatPartnershipLine({ ratioEnabled: true, partnership: hit }, 'en').text).toMatch(/uncertain/i)

    const miss = summarizePartnershipSample([
      { tweet: tweet({ id: '3', at: NOW - DAY, disclosurePresent: false, text: 'ordinary' }) },
    ], { now: NOW, userId: '42', handle: 'ada' })
    expect(miss.status).toBe('unavailable')
    expect(miss.ratio).toBeNull()
  })

  it('stops at the window, keeps an in-window pin, and marks a short sample as truncated', async () => {
    const fresh = tweet({ id: '10', at: NOW - DAY, disclosure: null })
    const older = tweet({ id: '11', at: NOW - 40 * DAY, disclosure: 'PaidPartnership' })
    const pin = tweet({ id: '12', at: NOW - 2 * DAY, disclosure: 'PaidPartnership' })
    const calls: string[] = []
    const api = {
      getUserByScreenName: vi.fn(async (name: string) => {
        calls.push(`name:${name}`)
        return userPayload()
      }),
      getUserTweets: vi.fn(async (_id: string, cursor?: string) => {
        calls.push(`tweets:${cursor || 'first'}`)
        if (!cursor) return page([fresh], 'next', pin)
        return page([older])
      }),
    }
    const summary = await collectPartnershipSample(api, { handle: 'ada', now: NOW, pageGapMs: 0, sleep: async () => {} })
    expect(summary).toMatchObject({
      status: 'ok',
      source: 'disclosure',
      originalCount: 2,
      paidCount: 1,
      truncated: false,
      userId: '42',
    })
    expect(calls).toEqual(['name:ada', 'tweets:first', 'tweets:next'])
    expect(api.getUserTweets).toHaveBeenCalledTimes(2)

    const capped = await collectPartnershipSample({
      getUserByScreenName: async () => userPayload('7', 'bob'),
      getUserTweets: async (_id: string, cursor?: string) => page([
        tweet({ id: cursor ? '31' : '30', at: NOW - DAY, disclosure: null, userId: '7' }),
      ], 'more'),
    }, { handle: 'bob', now: NOW, pageCap: 2, pageGapMs: 0, sleep: async () => {} })
    expect(capped.truncated).toBe(true)
    expect(capped.originalCount).toBe(2)
    expect(formatPartnershipLine({ ratioEnabled: true, partnership: capped }, 'zh').text).toContain('未翻完')
  })

  it('does not let an old pin end the window early', () => {
    const parsed = collectUserTweetPage(page(
      [tweet({ id: '10', at: NOW - DAY, disclosure: null })],
      'next',
      tweet({ id: '9', at: NOW - 90 * DAY, disclosure: null }),
    ))
    expect(parsed.recognized).toBe(true)
    expect(parsed.cursor).toBe('next')
    expect(pageReachedWindowEnd(parsed.items, NOW - 30 * DAY)).toBe(false)
  })

  it('says the timeline shape is unrecognized instead of inventing a ratio', async () => {
    const summary = await collectPartnershipSample({
      getUserByScreenName: async () => userPayload(),
      getUserTweets: async () => ({ data: { unrelated: true } }),
    }, { handle: 'ada', now: NOW })
    expect(summary).toMatchObject({ status: 'unavailable', reason: 'unrecognized', ratio: null, userId: '42' })
    expect(collectUserTweetPage({}).recognized).toBe(false)
  })

  it('uses only the read operations and skips a cached numeric id', async () => {
    expect([...PARTNERSHIP_READ_OPS]).toEqual(['UserByScreenName', 'UserTweets'])
    const api = {
      getUserByScreenName: vi.fn(async () => userPayload()),
      getUserTweets: vi.fn(async () => page([tweet({ id: '1', at: NOW - DAY, disclosure: null })])),
    }
    const guarded = new Proxy(api, {
      get(target, prop) {
        if (prop !== 'getUserByScreenName' && prop !== 'getUserTweets') throw new Error(`unexpected op ${String(prop)}`)
        return target[prop as 'getUserByScreenName']
      },
    })
    await collectPartnershipSample(guarded, { handle: 'ada', knownUserId: '42', now: NOW })
    expect(api.getUserByScreenName).not.toHaveBeenCalled()
    expect(api.getUserTweets).toHaveBeenCalledWith('42', undefined, 40)
  })
})

describe('partnership cache and rate limit', () => {
  it('caches by handle and day, and does not refetch inside the ttl', async () => {
    const api = {
      getUserByScreenName: vi.fn(async () => userPayload()),
      getUserTweets: vi.fn(async () => page([tweet({ id: '1', at: NOW - DAY, disclosure: null })])),
    }
    const first = await runPartnershipStats({
      handle: 'ada',
      settings: { hoverCardEnabled: true, partnershipRatioEnabled: true },
      now: NOW,
      api,
      pageGapMs: 0,
    })
    expect(first.fetched).toBe(true)
    expect(first.partnership).toMatchObject({ status: 'ok', ratio: 0 })
    const second = await runPartnershipStats({
      handle: '@Ada',
      settings: { hoverCardEnabled: true, partnershipRatioEnabled: true },
      now: NOW + 60_000,
      cache: first.cache,
      api,
      pageGapMs: 0,
    })
    expect(second.cached).toBe(true)
    expect(second.fetched).toBe(false)
    expect(api.getUserTweets).toHaveBeenCalledTimes(1)

    const nextDay = lookupPartnershipCache(first.cache, 'ada', NOW + DAY)
    expect(nextDay).toBeNull()
  })

  it('stays off the network when the ratio setting is off, and rate-limits a second account', async () => {
    const api = {
      getUserByScreenName: vi.fn(async () => userPayload()),
      getUserTweets: vi.fn(async () => page([tweet({ id: '1', at: NOW - DAY, disclosure: null })])),
    }
    const off = await runPartnershipStats({
      handle: 'ada',
      settings: { hoverCardEnabled: true, partnershipRatioEnabled: false },
      now: NOW,
      api,
    })
    expect(off.fetched).toBe(false)
    expect(off.partnership).toMatchObject({ status: 'off', reason: 'ratio' })
    expect(api.getUserTweets).not.toHaveBeenCalled()

    const cardOff = await runPartnershipStats({
      handle: 'ada',
      settings: { hoverCardEnabled: false, partnershipRatioEnabled: true },
      now: NOW,
      api,
    })
    expect(cardOff.partnership).toMatchObject({ status: 'off', reason: 'card' })

    const first = await runPartnershipStats({
      handle: 'ada',
      settings: { partnershipRatioEnabled: true },
      now: NOW,
      api,
      pageGapMs: 0,
    })
    const second = await runPartnershipStats({
      handle: 'bob',
      settings: { partnershipRatioEnabled: true },
      now: NOW + 500,
      cache: first.cache,
      api,
      pageGapMs: 0,
    })
    expect(second.fetched).toBe(false)
    expect(second.partnership).toMatchObject({ status: 'rate', reason: 'gap' })
    expect(api.getUserByScreenName).toHaveBeenCalledTimes(1)
  })

  it('caps hourly fetches and remembers auth failures without treating them as 0%', async () => {
    let budget = { hourStart: NOW, count: 0, nextAllowed: 0 }
    for (let i = 0; i < PARTNERSHIP_HOURLY_CAP; i += 1) {
      const slot = reservePartnershipSlot(budget, NOW + i * PARTNERSHIP_MIN_GAP_MS)
      expect(slot.ok).toBe(true)
      budget = slot.budget
    }
    const blocked = reservePartnershipSlot(budget, NOW + PARTNERSHIP_HOURLY_CAP * PARTNERSHIP_MIN_GAP_MS)
    expect(blocked).toMatchObject({ ok: false, reason: 'hourly' })

    const api = {
      getUserByScreenName: vi.fn(async () => {
        const error = new Error('no auth') as Error & { code: string }
        error.code = 'auth'
        throw error
      }),
      getUserTweets: vi.fn(),
    }
    const failed = await runPartnershipStats({
      handle: 'ada',
      settings: { partnershipRatioEnabled: true },
      now: NOW,
      api,
      pageGapMs: 0,
    })
    expect(failed.partnership.reason).toBe('auth')
    expect(failed.partnership.ratio).toBeNull()
    expect(partnershipFromError({ code: 'rate_limit' }, 'ada').status).toBe('rate')
    const again = await runPartnershipStats({
      handle: 'ada',
      settings: { partnershipRatioEnabled: true },
      now: NOW + PARTNERSHIP_MIN_GAP_MS,
      cache: failed.cache,
      api,
      pageGapMs: 0,
    })
    expect(again.cached).toBe(true)
    expect(api.getUserByScreenName).toHaveBeenCalledTimes(1)
    expect(api.getUserTweets).not.toHaveBeenCalled()
    expect(rememberPartnership(failed.cache, failed.partnership, NOW).entries).not.toEqual({})
  })

  it('refuses a reserved path and does not call the api', async () => {
    const api = { getUserByScreenName: vi.fn(), getUserTweets: vi.fn() }
    const result = await runPartnershipStats({
      handle: 'home',
      settings: { partnershipRatioEnabled: true },
      now: NOW,
      api,
    })
    expect(result).toMatchObject({ ok: false, error: 'no-handle', fetched: false })
    expect(api.getUserTweets).not.toHaveBeenCalled()
  })
})

describe('hover card model', () => {
  it('shows the ledger, flags, and follow state without any enqueue action', () => {
    const card = describeHoverCard({
      handle: 'Ada',
      displayName: 'Ada Lovelace',
      lang: 'zh',
      liveFollowed: true,
      settings: { libraryChipFromStrikes: true, libraryChipThreshold: 2 },
      record: {
        handle: 'ada',
        whitelist: true,
        followed: false,
        authorFlags: { marketing: true, spam: false },
        counts: { Spam: 2, Marketing: 1 },
      },
      ratioEnabled: false,
      visiblePaid: true,
    })
    expect(card?.readOnly).toBe(true)
    expect(card?.title).toBe('@Ada')
    expect(card?.subtitle).toBe('Ada Lovelace')
    const lines = card?.rows.map((row) => row.text).join('\n')
    expect(lines).toContain('账本：垃圾×2 · 营销×1')
    expect(lines).toContain('作者标记：常垃圾 · 常营销')
    expect(lines).toContain('已关注 · 在白名单')
    expect(lines).toContain('付费合作占比：未开启')
    expect(lines).toContain('本条可见「付费合作」标记')
    expect(card?.footnote).toContain('不会记账')
    expect(card).not.toHaveProperty('mute')
    expect(card).not.toHaveProperty('block')
    expect(card).not.toHaveProperty('queue')
    expect(JSON.stringify(card)).not.toMatch(/enqueue|mute|block/i)
  })

  it('says whitelist and follow are unknown when the ledger has no row', () => {
    const card = describeHoverCard({ handle: 'bob', lang: 'en', ratioEnabled: true, loading: true })
    const lines = card?.rows.map((row) => row.text).join('\n')
    expect(lines).toContain('Ledger: no spam or marketing marks')
    expect(lines).toContain('Follow state unknown · Whitelist unknown')
    expect(lines).toContain('loading')
    expect(card?.rows.some((row) => row.text.includes('Author flags'))).toBe(false)
  })

  it('keeps the new settings opt-in for the network and on for the card', () => {
    expect(defaultSettings().hoverCardEnabled).toBe(true)
    expect(defaultSettings().partnershipRatioEnabled).toBe(false)
    expect(freshState(1).settings.partnershipRatioEnabled).toBe(false)
    const saved = sanitizeSettings(defaultSettings(), { hoverCardEnabled: false, partnershipRatioEnabled: true })
    expect(saved.settings.hoverCardEnabled).toBe(false)
    expect(saved.settings.partnershipRatioEnabled).toBe(true)
    const junk = sanitizeSettings(defaultSettings(), { partnershipRatioEnabled: 'yes' as unknown as boolean })
    expect(junk.settings.partnershipRatioEnabled).toBe(false)
    const legacy = normalizeState({ settings: { language: 'zh' } }, 2)
    expect(legacy.settings.hoverCardEnabled).toBe(true)
    expect(legacy.settings.partnershipRatioEnabled).toBe(false)
    const stored = normalizeState({ settings: { hoverCardEnabled: false, partnershipRatioEnabled: true } }, 2)
    expect(stored.settings.hoverCardEnabled).toBe(false)
    expect(stored.settings.partnershipRatioEnabled).toBe(true)
  })
})
