import { describe, expect, it } from 'vitest'
import { SearchEngine } from '@/search/engine'
import { parseQuery } from '@/search/query-parser'
import type { Post } from '@/shared/types'
import {
  AUTHOR_FLAG_STORE,
  authorMarkLookup,
  distinctAuthorFlagOps,
  libraryMarksForAccount,
  marksForPost,
} from '@/strike/lib/author-flags.js'
import {
  applyMark,
  applyUndo,
  exportData,
  freshState,
  importData,
  normalizeState,
  setAuthorFlag,
} from '@/strike/lib/pure.js'

type AuthorFlags = { marketing: boolean; spam: boolean }
type LedgerAccount = {
  tags: { name: string; count: number }[]
  authorFlags: AuthorFlags
  whitelist: boolean
}
type FlagResult = {
  ok?: boolean
  enqueued?: boolean
  queued?: boolean
  strikeAdded?: boolean
  userId?: string
  marks?: { marketing: boolean; spam: boolean; explicit: AuthorFlags; fromStrike: { marketing: boolean; spam: boolean } }
}

function accounts(state: { ledger: object }) {
  return state.ledger as Record<string, LedgerAccount>
}

function post(over: Partial<Post> = {}): Post {
  return {
    tweet_id: '1',
    sort_index: '0001',
    user_id: '42',
    screen_name: 'promo',
    name: 'Promo',
    avatar: '',
    created_at: 1,
    text: 'buy now',
    lang: 'en',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: 0 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: '',
    tags: [],
    status: 'active',
    saved_at: 1,
    sync_run: 'r',
    url: 'https://x.com/promo/status/1',
    ...over,
  }
}

describe('author flag store', () => {
  it('documents one source of truth on the strike ledger', () => {
    expect(AUTHOR_FLAG_STORE).toMatchObject({
      area: 'chrome.storage.local',
      key: 'xsl',
      accountField: 'ledger[userId].authorFlags',
    })
    expect(AUTHOR_FLAG_STORE.settings).toEqual([
      'libraryChipFromStrikes',
      'libraryChipThreshold',
      'bookmarkMarkAddsStrike',
    ])
  })
})

describe('library chips from strikes', () => {
  it('lights the chip at the library threshold without an explicit flag and without a queue', () => {
    const state = freshState(1)
    state.settings.enablePlatformActions = true
    state.settings.muteOnThreshold = true
    state.settings.blockOnThreshold = true
    state.settings.actionMode = 'auto'
    applyMark(state, { tag: 'Marketing', handle: 'promo', userId: '42', tweetId: '201', textSnippet: 'sale' }, 1)
    applyMark(state, { tag: 'Marketing', handle: 'promo', userId: '42', tweetId: '202', textSnippet: 'sale' }, 2)
    const third = applyMark(state, { tag: 'Marketing', handle: 'promo', userId: '42', tweetId: '203', textSnippet: 'sale', followed: true }, 3)
    const account = accounts(state)['42']
    expect(third.threshold?.crossed).toBe(true)
    expect(account.authorFlags.marketing).toBe(false)
    expect(libraryMarksForAccount(account, state.settings).marketing).toBe(true)
    expect(libraryMarksForAccount(account, state.settings).fromStrike.marketing).toBe(true)
    expect(state.queue).toEqual([])

    state.settings.libraryChipThreshold = 4
    expect(libraryMarksForAccount(account, state.settings).marketing).toBe(false)
    state.settings.libraryChipFromStrikes = false
    state.settings.libraryChipThreshold = 3
    expect(libraryMarksForAccount(account, state.settings).marketing).toBe(false)
  })

  it('keeps a whitelist chip and still does not enqueue', () => {
    const state = freshState(1)
    state.settings.enablePlatformActions = true
    state.settings.blockOnThreshold = true
    state.settings.actionMode = 'auto'
    const accountId = String(applyMark(state, { tag: 'Spam', handle: 'safe', tweetId: '301', textSnippet: 'x' }, 1).userId)
    accounts(state)[accountId].whitelist = true
    applyMark(state, { tag: 'Spam', handle: 'safe', userId: accountId, tweetId: '302', textSnippet: 'x' }, 2)
    applyMark(state, { tag: 'Spam', handle: 'safe', userId: accountId, tweetId: '303', textSnippet: 'x' }, 3)
    expect(libraryMarksForAccount(accounts(state)[accountId], state.settings).spam).toBe(true)
    expect(state.queue).toEqual([])
  })
})

describe('setAuthorFlag', () => {
  it('pins the author without a strike or a queue when the setting is off', () => {
    const state = freshState(1)
    state.settings.enablePlatformActions = true
    state.settings.muteOnThreshold = true
    state.settings.actionMode = 'auto'
    state.settings.tagThresholds.Marketing = 1
    const result = setAuthorFlag(state, {
      handle: 'promo',
      userId: '42',
      displayName: 'Promo',
      flag: 'marketing',
      value: true,
      addStrike: true,
      tweetId: '900',
      textSnippet: 'sale',
    }, 5) as FlagResult
    expect(result.ok).toBe(true)
    expect(result.enqueued).toBe(false)
    expect(result.queued).toBe(false)
    expect(result.strikeAdded).toBe(false)
    expect(result.marks?.marketing).toBe(true)
    expect(result.marks?.explicit.marketing).toBe(true)
    expect(accounts(state)['42'].tags).toEqual([])
    expect(state.queue).toEqual([])
  })

  it('adds one strike when asked and still never enqueues mute or block', () => {
    const state = freshState(1)
    state.settings.bookmarkMarkAddsStrike = true
    state.settings.enablePlatformActions = true
    state.settings.muteOnThreshold = true
    state.settings.blockOnThreshold = true
    state.settings.actionMode = 'auto'
    state.settings.tagThresholds.Marketing = 1
    state.settings.libraryChipThreshold = 1
    const first = setAuthorFlag(state, {
      handle: 'promo',
      userId: '42',
      flag: 'marketing',
      value: true,
      addStrike: true,
      tweetId: '901',
      url: 'https://x.com/promo/status/901',
      textSnippet: 'sale',
      followed: false,
    }, 6) as FlagResult
    expect(first.strikeAdded).toBe(true)
    expect(first.enqueued).toBe(false)
    expect(accounts(state)['42'].tags.find((tag) => tag.name === 'Marketing')?.count).toBe(1)
    expect(state.queue).toEqual([])
    const again = setAuthorFlag(state, {
      handle: 'promo',
      userId: '42',
      flag: 'marketing',
      value: true,
      addStrike: true,
      tweetId: '901',
      textSnippet: 'sale',
    }, 7) as FlagResult
    expect(again.strikeAdded).toBe(false)
    expect(accounts(state)['42'].tags.find((tag) => tag.name === 'Marketing')?.count).toBe(1)
    expect(state.queue).toEqual([])
  })

  it('clears the explicit flag and leaves strike-derived chips in place', () => {
    const state = freshState(1)
    state.settings.libraryChipThreshold = 1
    applyMark(state, { tag: 'Marketing', handle: 'promo', userId: '42', tweetId: '910', textSnippet: 'sale' }, 1)
    state.settings.bookmarkMarkAddsStrike = true
    setAuthorFlag(state, { handle: 'promo', userId: '42', flag: 'marketing', value: true, addStrike: false }, 2)
    expect(libraryMarksForAccount(accounts(state)['42'], state.settings).explicit.marketing).toBe(true)
    setAuthorFlag(state, { handle: 'promo', userId: '42', flag: 'marketing', value: false, addStrike: true }, 3)
    const marks = libraryMarksForAccount(accounts(state)['42'], state.settings) as { explicit: AuthorFlags; marketing: boolean }
    expect(marks.explicit.marketing).toBe(false)
    expect(marks.marketing).toBe(true)
    expect(accounts(state)['42'].tags.find((tag) => tag.name === 'Marketing')?.count).toBe(1)
    expect(state.queue).toEqual([])
  })

  it('writes the flag onto an existing handle account so numeric bookmark ids still match', () => {
    const state = freshState(1)
    applyMark(state, { tag: 'Marketing', handle: 'promo', tweetId: '11', textSnippet: 'a' }, 1)
    const id = Object.keys(accounts(state))[0]
    expect(id.startsWith('h:')).toBe(true)
    setAuthorFlag(state, { handle: 'promo', userId: '42', flag: 'spam', value: true }, 2)
    expect(accounts(state)['42']).toBeUndefined()
    expect(accounts(state)[id].authorFlags.spam).toBe(true)
    const lookup = authorMarkLookup(state.index, state.settings)
    const marks = marksForPost({ user_id: '42', screen_name: 'promo' }, lookup) as { spam: boolean; marketing: boolean }
    expect(marks.spam).toBe(true)
    expect(marks.marketing).toBe(false)
    expect(state.queue).toEqual([])
  })

  it('undo restores the previous explicit flag', () => {
    const state = freshState(1)
    setAuthorFlag(state, { handle: 'promo', flag: 'spam', value: true }, 1)
    expect(Object.values(accounts(state))[0].authorFlags.spam).toBe(true)
    applyUndo(state, 2)
    expect(Object.values(accounts(state))[0].authorFlags.spam).toBe(false)
  })

  it('round-trips through export, normalize, and import', () => {
    const state = freshState(1)
    setAuthorFlag(state, { handle: 'promo', userId: '42', flag: 'marketing', value: true }, 1)
    const exported = exportData(state) as { ledger: Record<string, { authorFlags: AuthorFlags }> }
    expect(exported.ledger['42'].authorFlags.marketing).toBe(true)
    const restored = normalizeState(exported)
    expect(accounts(restored)['42'].authorFlags.marketing).toBe(true)
    expect(restored.settings.bookmarkMarkAddsStrike).toBe(false)
    expect(restored.settings.libraryChipFromStrikes).toBe(true)
    const other = freshState(2)
    setAuthorFlag(other, { handle: 'promo', userId: '42', flag: 'spam', value: true }, 2)
    importData(other, exported, { mode: 'merge', settings: true }, 3)
    expect(accounts(other)['42'].authorFlags).toEqual({ marketing: true, spam: true })
  })
})

describe('lookup and search', () => {
  it('merges a numeric id and an h:handle row for the same author', () => {
    const lookup = authorMarkLookup({
      '111': { handle: 'alice', counts: { Marketing: 3 }, authorFlags: { marketing: false, spam: false } },
      'h:alice': { handle: 'alice', counts: {}, authorFlags: { marketing: false, spam: true } },
    }, { libraryChipFromStrikes: true, libraryChipThreshold: 3 })
    const marks = marksForPost({ user_id: '999', screen_name: 'alice' }, lookup)
    expect(marks.marketing).toBe(true)
    expect(marks.spam).toBe(true)
    expect(marksForPost({ user_id: '111', screen_name: 'alice' }, lookup).marketing).toBe(true)
  })

  it('collapses a bulk selection to one op per author', () => {
    const ops = distinctAuthorFlagOps([
      { tweet_id: '1', user_id: '9', screen_name: 'alice', text: 'a', url: 'https://x.com/alice/status/1' },
      { tweet_id: '2', user_id: '9', screen_name: 'alice', text: 'b' },
      { tweet_id: '3', user_id: '8', screen_name: 'bob', text: 'c' },
    ], 'marketing', true)
    expect(ops.map((op) => op.handle)).toEqual(['alice', 'bob'])
    expect(ops[0].tweetId).toBe('1')
    expect(ops[0].value).toBe(true)
  })

  it('parses author: and strike: and filters the library', () => {
    const parsed = parseQuery('author:常营销 strike:spam -author:any')
    expect(parsed.authorMarks).toEqual(['marketing', 'spam'])
    expect(parsed.excludeAuthorMarks).toEqual(['any'])
    expect(parseQuery('strike:nope').warnings).toEqual(['strike:nope'])

    const state = freshState(1)
    setAuthorFlag(state, { handle: 'promo', userId: '42', flag: 'marketing', value: true }, 1)
    setAuthorFlag(state, { handle: 'spammer', userId: '7', flag: 'spam', value: true }, 2)
    const lookup = authorMarkLookup(state.index, state.settings)
    const engine = new SearchEngine([
      post({ tweet_id: 'a', user_id: '42', screen_name: 'promo', text: 'offer' }),
      post({ tweet_id: 'b', user_id: '7', screen_name: 'spammer', text: 'airdrop' }),
      post({ tweet_id: 'c', user_id: '8', screen_name: 'calm', text: 'hello' }),
    ])
    const ids = (query: string) => engine.search({ query, filters: { authorMarkLookup: lookup } }).hits.map((hit) => hit.post.tweet_id)
    expect(ids('author:marketing')).toEqual(['a'])
    expect(ids('strike:spam')).toEqual(['b'])
    expect(ids('strike:any').sort()).toEqual(['a', 'b'])
    expect(ids('-author:marketing').sort()).toEqual(['b', 'c'])
    expect(ids('author:marketing hello')).toEqual([])
  })
})
