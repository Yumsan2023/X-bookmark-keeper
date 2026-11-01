import { describe, expect, it } from 'vitest'
import {
  allowedCommunityUrl,
  applyFalsePositive,
  communityListDecision,
  communityPermissionOrigin,
  defaultSettings,
  foldReasonSummary,
  freshState,
  importCommunityList,
  matchCommunityLists,
  matchRules,
  normalizeState,
  parseCommunityList,
  recordRuleHits,
  removeCommunityList,
  sanitizeSettings,
  setCommunityListEnabled,
  strikeReasonFromMatch,
  upsertCommunitySubscription,
} from '@/strike/lib/pure.js'

const SAMPLE = {
  format: 'x-toolkit-community-list',
  version: 1,
  name: '示例名单',
  handles: ['spam_bot', '@Spam_Bot'],
  keywords: ['加群领资料', '加群领资料', 'a'],
}

function sampleList(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cl_demo',
    name: '示例名单',
    enabled: true,
    handles: ['spam_bot'],
    keywords: ['特制暗号'],
    ...overrides,
  }
}

describe('community lists', () => {
  it('stays off until imported and enabled, and ignores a bad mode', () => {
    expect(defaultSettings().communityListsEnabled).toBe(false)
    expect(defaultSettings().communityListMode).toBe('yellow')
    expect(defaultSettings().communityLists).toEqual([])
    expect(freshState(1).settings.communityListsEnabled).toBe(false)

    const legacy = normalizeState({ settings: { language: 'zh', commentScanEnabled: true } }, 2)
    expect(legacy.settings.communityListsEnabled).toBe(false)
    expect(legacy.settings.communityListMode).toBe('yellow')
    expect(legacy.settings.communityLists).toEqual([])
    expect(legacy.settings.commentScanEnabled).toBe(true)

    const sanitized = sanitizeSettings(defaultSettings(), {
      communityListsEnabled: true,
      communityListMode: 'block',
      enablePlatformActions: false,
      communityLists: [{
        id: 'cl_demo',
        name: '示例',
        enabled: true,
        source: 'url',
        url: 'https://user:pass@example.com/secret.json',
        handles: ['@Spam_Bot', 'not a handle', 'spam_bot'],
        keywords: ['特制暗号', '特制暗号', 'a', '日入'],
        error: 'http-404',
        fetchedAt: 10,
        updatedAt: 11,
      }, {
        id: 'cl_js',
        name: '脚本',
        url: 'javascript:alert(1)',
        keywords: ['只剩这个'],
      }],
    })
    expect(sanitized.settings.communityListsEnabled).toBe(true)
    expect(sanitized.settings.communityListMode).toBe('yellow')
    expect(sanitized.settings.enablePlatformActions).toBe(false)
    expect(sanitized.settings.muteOnThreshold).toBe(false)
    expect(sanitized.settings.blockOnThreshold).toBe(false)
    expect(sanitized.settings.communityLists[0]).toMatchObject({
      id: 'cl_demo',
      source: 'local',
      url: '',
      handles: ['Spam_Bot'],
      keywords: ['特制暗号', '日入'],
      error: 'http-404',
    })
    expect(sanitized.settings.communityLists[1]).toMatchObject({
      keywords: ['只剩这个'],
      url: '',
      source: 'local',
    })
  })

  it('parses the JSON object and the plain-text form', () => {
    const json = parseCommunityList(JSON.stringify(SAMPLE))
    expect(json.ok).toBe(true)
    if (!json.ok) return
    expect(json.name).toBe('示例名单')
    expect(json.handles).toEqual(['spam_bot'])
    expect(json.keywords).toEqual(['加群领资料'])

    const text = parseCommunityList('# name: 示例名单\n@Spam_Bot\n@spam_bot\n加群领资料\n# 注释\nhttps://example.com/skip\n')
    expect(text.ok).toBe(true)
    if (!text.ok) return
    expect(text).toMatchObject({ name: '示例名单', handles: ['Spam_Bot'], keywords: ['加群领资料'] })

    const lines = parseCommunityList(JSON.stringify(['@spam_bot', '日入']))
    expect(lines.ok).toBe(true)
    if (!lines.ok) return
    expect(lines.handles).toEqual(['spam_bot'])
    expect(lines.keywords).toEqual(['日入'])

    expect(parseCommunityList('').ok).toBe(false)
    expect(parseCommunityList('{').error).toBe('fileBad')
    expect(parseCommunityList(JSON.stringify({ format: 'x-strike-ledger', keywords: ['加群领资料'] })).error).toBe('fileBad')
    expect(parseCommunityList('x'.repeat(512_001)).error).toBe('too-large')

    const words = Array.from({ length: 1501 }, (_, index) => `w${String(index).padStart(4, '0')}`)
    const capped = parseCommunityList(JSON.stringify({
      format: 'x-toolkit-community-list',
      version: 1,
      name: '大名单',
      keywords: words,
    }))
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(capped.keywords).toHaveLength(1500)
    expect(capped.warnings?.[0]).toContain('1500')
  })

  it('imports locally without enabling, striking, or queueing', () => {
    const state = freshState(1)
    const before = JSON.stringify({
      ledger: state.ledger,
      queue: state.queue,
      hidden: state.hidden,
      tweets: state.tweets,
      vetoes: state.vetoes,
    })
    const imported = importCommunityList(state, { text: JSON.stringify(SAMPLE) }, 5)
    expect(imported.ok).toBe(true)
    expect(state.settings.communityListsEnabled).toBe(false)
    expect(state.settings.communityLists).toHaveLength(1)
    expect(state.settings.communityLists[0].source).toBe('local')
    expect(JSON.stringify({
      ledger: state.ledger,
      queue: state.queue,
      hidden: state.hidden,
      tweets: state.tweets,
      vetoes: state.vetoes,
    })).toBe(before)

    for (let index = 0; index < 5; index += 1) {
      expect(importCommunityList(state, { text: `# name: 名单${index}\n词条${index}号` }, index).ok).toBe(true)
    }
    expect(importCommunityList(state, { text: '# name: 超出\n额外词条' }, 9)).toMatchObject({ ok: false, error: 'list-full' })
    expect(state.queue).toEqual([])
    expect(state.ledger).toEqual({})
  })

  it('keeps the cached list when a subscription fetch fails', () => {
    const state = freshState(1)
    const url = 'https://example.com/list.json'
    const body = JSON.stringify({
      format: 'x-toolkit-community-list',
      version: 1,
      name: '远端名单',
      handles: ['spam_bot'],
      keywords: ['加群领资料'],
    })
    expect(upsertCommunitySubscription(state, { url, fetched: { ok: false, error: 'http-500' } }, 5).ok).toBe(false)
    expect(state.settings.communityLists).toEqual([])
    expect(state.settings.communityListsEnabled).toBe(false)

    const saved = upsertCommunitySubscription(state, { url, fetched: { ok: true, body } }, 6)
    expect(saved.ok).toBe(true)
    expect(saved.kept).toBe(false)
    expect(state.settings.communityLists).toHaveLength(1)
    expect(state.settings.communityLists[0].keywords).toEqual(['加群领资料'])
    expect(state.settings.communityLists[0].fetchedAt).toBe(6)

    const failed = upsertCommunitySubscription(state, { url, fetched: { ok: false, error: 'timeout' } }, 7)
    expect(failed).toMatchObject({ ok: true, kept: true, error: 'timeout' })
    expect(state.settings.communityLists).toHaveLength(1)
    expect(state.settings.communityLists[0].keywords).toEqual(['加群领资料'])
    expect(state.settings.communityLists[0].handles).toEqual(['spam_bot'])
    expect(state.settings.communityLists[0].fetchedAt).toBe(6)
    expect(state.queue).toEqual([])

    const broken = upsertCommunitySubscription(state, { url, fetched: { ok: true, body: '{' } }, 8)
    expect(broken.kept).toBe(true)
    expect(state.settings.communityLists[0].keywords).toEqual(['加群领资料'])

    expect(allowedCommunityUrl('https://example.com/a.json')).toBe('https://example.com/a.json')
    expect(allowedCommunityUrl('http://127.0.0.1:8080/list.txt')).toContain('127.0.0.1')
    expect(allowedCommunityUrl('http://example.com/list.json')).toBe('')
    expect(allowedCommunityUrl('javascript:alert(1)')).toBe('')
    expect(allowedCommunityUrl('https://user:pass@example.com/a')).toBe('')
    expect(communityPermissionOrigin('https://example.com/a.json')).toBe('https://example.com/*')
    expect(communityPermissionOrigin('javascript:alert(1)')).toBe('')
  })

  it('matches handles and literal words only while the switch is on', () => {
    const lists = [sampleList({ keywords: ['特制暗号', '加群领资料'] })]
    const off = matchCommunityLists(lists, { enabled: false, text: '特制暗号', handle: 'spam_bot' })
    expect(off).toMatchObject({ suspect: false, recordStrike: false, queueMute: false, queueBlock: false })

    const hit = matchCommunityLists(lists, { enabled: true, text: '请看特制暗号', handle: 'reader', bio: '', displayName: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.recordStrike).toBe(false)
    expect(hit.queueMute).toBe(false)
    expect(hit.queueBlock).toBe(false)
    expect(hit.reasons[0]).toMatchObject({ community: true, listName: '示例名单', suggestTag: '' })
    expect(strikeReasonFromMatch(hit)).toBeNull()

    const byHandle = matchCommunityLists(lists, { enabled: true, text: 'hello', handle: 'Spam_Bot' })
    expect(byHandle.suspect).toBe(true)
    expect(byHandle.reasons[0].pattern.toLowerCase()).toBe('spam_bot')

    const display = matchCommunityLists(lists, { enabled: true, text: '', displayName: '加群领资料官方', handle: 'ok_user' })
    expect(display.suspect).toBe(true)

    const notInHandle = matchCommunityLists(
      [sampleList({ handles: [], keywords: ['spam'] })],
      { enabled: true, text: '', handle: 'spam_bot', bio: '', displayName: '' },
    )
    expect(notInHandle.suspect).toBe(false)

    const paused = matchCommunityLists(
      [sampleList({ enabled: false })],
      { enabled: true, text: '特制暗号', handle: 'someone' },
    )
    expect(paused.suspect).toBe(false)
  })

  it('folds only in fold mode, and still protects whitelist, follows, and the open post', () => {
    const yellow = communityListDecision({
      enabled: true,
      mode: 'yellow',
      matched: true,
      whitelist: false,
      followed: false,
      surface: 'timeline',
    })
    expect(yellow).toMatchObject({
      suspect: true,
      fold: false,
      recordStrike: false,
      queueMute: false,
      queueBlock: false,
    })

    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: false,
      surface: 'timeline',
    }).fold).toBe(true)
    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: null,
      whitelist: false,
      surface: 'reply',
    })).toMatchObject({ fold: true, recordStrike: false, queueMute: false, queueBlock: false })
    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      whitelist: true,
      followed: false,
      surface: 'timeline',
    }).fold).toBe(false)
    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      whitelist: false,
      followed: true,
      surface: 'reply',
    }).fold).toBe(false)
    expect(communityListDecision({
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: false,
      surface: 'focal',
    })).toMatchObject({ suspect: true, fold: false, recordStrike: false })
    expect(communityListDecision({ enabled: false, mode: 'fold', matched: true }).suspect).toBe(false)
  })

  it('names the list on the collapse bar and still prefers a keyword hit', () => {
    const only = foldReasonSummary({
      reasons: [{
        community: true,
        listName: '示例名单',
        packName: '示例名单',
        pattern: '特制暗号',
        patternType: 'keyword',
        suggestTag: '',
      }],
    })
    expect(only).toMatchObject({ source: 'community', pattern: '示例名单', extra: 0 })

    const both = foldReasonSummary({
      reasons: [
        {
          community: true,
          listName: '示例名单',
          packName: '示例名单',
          pattern: '特制暗号',
          patternType: 'keyword',
        },
        {
          pattern: '空投',
          patternType: 'keyword',
          packName: '垃圾',
          suggestTag: 'Spam',
        },
      ],
    })
    expect(both).toMatchObject({ source: 'keyword', pattern: '空投', extra: 1 })
    const keyword = matchRules([{
      id: 'pack-spam',
      name: '垃圾',
      enabled: true,
      suggestTag: 'Spam',
      patterns: [{ type: 'keyword', target: 'text', value: '空投' }],
    }], { text: '空投来了' })
    const community = matchCommunityLists([sampleList()], { enabled: true, text: '特制暗号', handle: 'someone' })
    expect(strikeReasonFromMatch({ reasons: [...keyword.reasons, ...community.reasons] })?.suggestTag).toBe('Spam')
    expect(strikeReasonFromMatch(community)).toBeNull()
  })

  it('lets a veto suppress a community hit without striking or silencing keyword packs', () => {
    const state = freshState(1)
    state.settings.communityListsEnabled = true
    state.settings.communityLists = [{
      ...sampleList(),
      source: 'local',
      url: '',
      error: '',
      fetchedAt: 0,
      updatedAt: 0,
    }]
    state.settings.keywordPacks = [{
      id: 'pack-mine',
      name: '我的',
      enabled: true,
      suggestTag: 'Spam',
      patterns: [{ type: 'keyword', target: 'text', value: '特制暗号' }],
    }]
    const hard = {
      id: 'veto_pack',
      kind: 'rule',
      until: 0,
      packId: 'pack-mine',
      packName: '我的',
      pattern: '特制暗号',
      patternType: 'keyword',
      target: 'text',
      phrase: '',
    }
    expect(matchCommunityLists(state.settings.communityLists, {
      enabled: true,
      text: '这是特制暗号',
      handle: 'someone',
      vetoes: [hard],
      now: 20,
    }).suspect).toBe(false)

    const fromList = {
      ...hard,
      id: 'veto_list',
      packId: 'c-cl_demo',
      packName: '示例名单',
    }
    expect(matchRules(state.settings.keywordPacks, {
      text: '这是特制暗号',
      vetoes: [fromList],
      now: 20,
    }).suspect).toBe(true)
    expect(matchCommunityLists(state.settings.communityLists, {
      enabled: true,
      text: '这是特制暗号',
      handle: 'someone',
      vetoes: [fromList],
      now: 20,
    }).suspect).toBe(false)

    const before = JSON.stringify({ ledger: state.ledger, queue: state.queue, tweets: state.tweets, hidden: state.hidden })
    const applied = applyFalsePositive(state, {
      source: 'suspect',
      text: '这是特制暗号',
      handle: 'bob',
      tweetId: 'abc123',
    }, 30)
    expect(applied.ok).toBe(true)
    expect(applied.count).toBeGreaterThan(0)
    expect(JSON.stringify({ ledger: state.ledger, queue: state.queue, tweets: state.tweets, hidden: state.hidden })).toBe(before)
    expect(matchCommunityLists(state.settings.communityLists, {
      enabled: true,
      text: '这是特制暗号',
      handle: 'bob',
      vetoes: state.vetoes,
      now: 30,
    }).suspect).toBe(false)
    expect(state.queue).toEqual([])

    state.settings.hitHistory = true
    const logged = recordRuleHits(state, {
      hits: [{ community: true, packId: 'c-cl_demo', pattern: '特制暗号', tweetId: 'abc123', handle: 'bob' }],
    }, 31)
    expect(logged.recorded).toBe(0)
    expect(state.hitLog).toEqual([])
    expect(state.ledger).toEqual({})

    expect(setCommunityListEnabled(state, { id: 'cl_demo', enabled: false }).ok).toBe(true)
    expect(matchCommunityLists(state.settings.communityLists, {
      enabled: true,
      text: '这是特制暗号',
      handle: 'someone',
      vetoes: [],
      now: 90,
    }).suspect).toBe(false)
    expect(removeCommunityList(state, 'cl_demo').ok).toBe(true)
    expect(state.settings.communityLists).toEqual([])
    expect(state.ledger).toEqual({})
  })
})
