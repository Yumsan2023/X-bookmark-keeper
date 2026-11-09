import { describe, expect, it } from 'vitest'
import { articleSurface, focalStatusId, isNestedTweetArticle, TWEET_ARTICLE_SELECTOR } from '@/strike/lib/domparse.js'
import {
  applyMark,
  autoPlatformAllowed,
  commentScanDecision,
  commentStrikePlatform,
  defaultKeywordPacks,
  defaultSettings,
  freshState,
  matchRules,
  normalizeState,
  sanitizeSettings,
} from '@/strike/lib/pure.js'

type El = {
  tag: string
  attrs: Record<string, string>
  parentElement: El | null
  children: El[]
  closest: (selector: string) => El | null
}

function matches(node: El, selector: string) {
  return selector.split(',').some((raw) => {
    const part = raw.trim()
    if (!part) return false
    if (part.startsWith('[')) {
      const attr = part.match(/^\[([^=]+)="([^"]+)"\]$/)
      return !!attr && node.attrs[attr[1]] === attr[2]
    }
    const tag = part.match(/^[a-zA-Z]+/)?.[0]
    if (!tag || node.tag !== tag) return false
    const attrs = [...part.matchAll(/\[([^=]+)="([^"]+)"\]/g)]
    return attrs.every((found) => node.attrs[found[1]] === found[2])
  })
}

function makeEl(tag: string, attrs: Record<string, string> = {}, children: El[] = []): El {
  const node: El = {
    tag,
    attrs,
    parentElement: null,
    children,
    closest(selector: string) {
      let cur: El | null = node
      while (cur) {
        if (matches(cur, selector)) return cur
        cur = cur.parentElement
      }
      return null
    },
  }
  for (const child of children) child.parentElement = node
  return node
}

const tweet = () => makeEl('article', { 'data-testid': 'tweet', role: 'article' })

describe('comment-area scan', () => {
  it('tells the focal status from reply articles on a detail thread', () => {
    expect(TWEET_ARTICLE_SELECTOR).toContain('article[data-testid="tweet"]')
    expect(TWEET_ARTICLE_SELECTOR).toContain('article[role="article"]')
    expect(focalStatusId('/alice/status/123')).toBe('123')
    expect(focalStatusId('/alice/status/123/')).toBe('123')
    expect(focalStatusId('/i/status/123')).toBe('123')
    expect(focalStatusId('/i/web/status/123')).toBe('123')
    expect(focalStatusId('/alice/statuses/123')).toBe('123')
    expect(focalStatusId('/alice/status/123/photo/2')).toBe('123')
    expect(focalStatusId('/alice/status/123/video/1')).toBe('123')
    expect(focalStatusId('/alice/status/123/quotes')).toBe('')
    expect(focalStatusId('/alice/status/123/retweets')).toBe('')
    expect(focalStatusId('/alice/status/123/likes')).toBe('')
    expect(focalStatusId('/home')).toBe('')
    expect(focalStatusId('/alice')).toBe('')
    expect(focalStatusId('/alice/with_replies')).toBe('')

    expect(articleSurface('/alice/status/123', '123')).toBe('focal')
    expect(articleSurface('/alice/status/123', '456')).toBe('reply')
    expect(articleSurface('/i/web/status/123/photo/1', '456')).toBe('reply')
    expect(articleSurface('/home', '456')).toBe('timeline')
    expect(articleSurface('/alice/status/123/quotes', '456')).toBe('timeline')
    expect(articleSurface('/alice/status/123', '')).toBe('focal')
  })

  it('skips quote embeds and articles nested inside another tweet', () => {
    const focal = tweet()
    const reply = tweet()
    makeEl('div', { 'data-testid': 'primaryColumn' }, [focal, reply])
    expect(isNestedTweetArticle(focal)).toBe(false)
    expect(isNestedTweetArticle(reply)).toBe(false)

    const quoted = tweet()
    const quote = makeEl('div', { 'data-testid': 'quoteTweet' }, [quoted])
    const outer = makeEl('article', { 'data-testid': 'tweet', role: 'article' }, [quote])
    expect(isNestedTweetArticle(quoted)).toBe(true)
    expect(isNestedTweetArticle(outer)).toBe(false)

    const inner = tweet()
    makeEl('article', { role: 'article' }, [inner])
    expect(isNestedTweetArticle(inner)).toBe(true)
  })

  it('reuses keyword packs on a reply and never queues from that hit', () => {
    const state = freshState(1)
    expect(state.settings.commentScanEnabled).toBe(false)
    expect(state.settings.commentHitMode).toBe('fold')
    const before = JSON.stringify({ ledger: state.ledger, queue: state.queue })
    const hit = matchRules(defaultKeywordPacks(), { text: '加微信 领资料', handle: 'spammer', bio: '' })
    expect(hit.suspect).toBe(true)
    expect(hit.tags).toContain('Marketing')

    const off = commentScanDecision({
      surface: 'reply',
      enabled: false,
      mode: 'fold',
      matched: hit.suspect,
      followed: false,
      whitelist: false,
    })
    expect(off).toMatchObject({ active: false, suspect: false, fold: false, queueMute: false, queueBlock: false })

    const folded = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: false,
    })
    expect(folded).toMatchObject({
      active: true,
      suspect: true,
      fold: true,
      prompt: false,
      confirmStrike: true,
      queueMute: false,
      queueBlock: false,
    })
    expect(commentScanDecision({ surface: 'timeline', enabled: true, mode: 'fold', matched: true }).fold).toBe(false)
    expect(commentScanDecision({ surface: 'focal', enabled: true, mode: 'fold', matched: true }).active).toBe(false)
    expect(JSON.stringify({ ledger: state.ledger, queue: state.queue })).toBe(before)
  })

  it('defaults to fold or prompt, and protects whitelist and follows', () => {
    const prompt = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'prompt',
      matched: true,
      followed: false,
      whitelist: false,
    })
    expect(prompt.fold).toBe(false)
    expect(prompt.prompt).toBe(true)
    expect(prompt.confirmStrike).toBe(true)
    expect(prompt.queueMute).toBe(false)
    expect(prompt.queueBlock).toBe(false)

    const unknown = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: null,
      whitelist: false,
    })
    expect(unknown.fold).toBe(true)
    expect(unknown.queueMute).toBe(false)
    expect(unknown.queueBlock).toBe(false)

    const followed = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: true,
      whitelist: false,
    })
    expect(followed.fold).toBe(false)
    expect(followed.prompt).toBe(true)
    expect(followed.suspect).toBe(true)
    expect(followed.queueBlock).toBe(false)

    const listed = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: true,
      followed: false,
      whitelist: true,
    })
    expect(listed.fold).toBe(false)
    expect(listed.suspect).toBe(true)
    expect(listed.queueMute).toBe(false)

    const quiet = commentScanDecision({
      surface: 'reply',
      enabled: true,
      mode: 'fold',
      matched: false,
      followed: false,
    })
    expect(quiet).toMatchObject({ active: true, suspect: false, fold: false, confirmStrike: false })

    const platformOn = {
      enablePlatformActions: true,
      muteOnThreshold: true,
      blockOnThreshold: true,
      commentScanEnabled: true,
      commentHitMode: 'fold',
    }
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: false }, 'mute', 'keyword')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: false }, 'block', 'suspect')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: false, followed: true }, 'mute', 'ai')).toBe(false)
    expect(autoPlatformAllowed(platformOn, { whitelist: true, followed: false }, 'block', 'keyword')).toBe(false)
  })

  it('drops mute and block when a reply chip confirm crosses the threshold', () => {
    const state = freshState(1)
    state.settings.actionMode = 'auto'
    state.settings.enablePlatformActions = true
    state.settings.muteOnThreshold = true
    state.settings.blockOnThreshold = true
    state.settings.defaultThreshold = 1
    state.settings.tagThresholds = { Spam: 1, Marketing: 1, Vagueposting: 1 }
    const marked = applyMark(state, {
      tag: 'Spam',
      handle: 'spammer',
      tweetId: '9001',
      textSnippet: '加微信',
      followed: false,
    }, 5)
    expect(marked.threshold?.suggest.mute).toBe(true)
    expect(marked.threshold?.suggest.block).toBe(true)
    expect(state.queue).toEqual([])

    const fromChip = commentStrikePlatform(marked.threshold, 'reply', 'rule')
    expect(fromChip.commentSignal).toBe(true)
    expect(fromChip.blockedQueue).toBe(true)
    expect(fromChip.threshold?.suggest?.mute).toBe(false)
    expect(fromChip.threshold?.suggest?.block).toBe(false)
    expect(fromChip.threshold?.suggest?.hide).toBe(true)

    const fromAi = commentStrikePlatform(marked.threshold, 'reply', 'ai')
    expect(fromAi.threshold?.suggest?.mute).toBe(false)
    expect(fromAi.threshold?.suggest?.block).toBe(false)

    const fromMarkSheet = commentStrikePlatform(marked.threshold, 'reply', 'user')
    expect(fromMarkSheet.commentSignal).toBe(false)
    expect(fromMarkSheet.threshold?.suggest?.mute).toBe(true)
    expect(commentStrikePlatform(marked.threshold, 'reply', 'shortcut').threshold?.suggest?.block).toBe(true)
    expect(commentStrikePlatform(marked.threshold, 'timeline', 'rule').threshold?.suggest?.mute).toBe(true)
    expect(commentStrikePlatform(marked.threshold, 'focal', 'ai').commentSignal).toBe(false)
    expect(state.queue).toEqual([])
  })

  it('keeps comment scan off and fold-only unless the setting says otherwise', () => {
    const fresh = sanitizeSettings(defaultSettings(), {})
    expect(fresh.settings.commentScanEnabled).toBe(false)
    expect(fresh.settings.commentHitMode).toBe('fold')

    const turned = sanitizeSettings(defaultSettings(), { commentScanEnabled: true, commentHitMode: 'prompt' })
    expect(turned.settings.commentScanEnabled).toBe(true)
    expect(turned.settings.commentHitMode).toBe('prompt')

    const rejected = sanitizeSettings(defaultSettings(), { commentScanEnabled: true, commentHitMode: 'auto' })
    expect(rejected.settings.commentScanEnabled).toBe(true)
    expect(rejected.settings.commentHitMode).toBe('fold')
    expect(sanitizeSettings(defaultSettings(), { commentScanEnabled: 'yes' as unknown as boolean }).settings.commentScanEnabled).toBe(false)

    const loaded = normalizeState({ settings: { language: 'zh', commentScanEnabled: true, commentHitMode: 'prompt' } }, 2)
    expect(loaded.settings.commentScanEnabled).toBe(true)
    expect(loaded.settings.commentHitMode).toBe('prompt')
    const legacy = normalizeState({ settings: { language: 'en' } }, 2)
    expect(legacy.settings.commentScanEnabled).toBe(false)
    expect(legacy.settings.commentHitMode).toBe('fold')
  })
})
