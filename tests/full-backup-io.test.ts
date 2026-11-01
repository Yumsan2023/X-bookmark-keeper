import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMark, enqueue, freshState, setAuthorFlag, setHidden } from '@/strike/lib/pure.js'
import { dispatch } from '@/strike/lib/store.js'
import { pickStrike, type StrikeSlice } from '@/backup/full'
import { applyRestorePlan, collectFullBackup } from '@/backup/io'
import { inspectBackup } from '@/backup/full'
import { db } from '@/db/db'
import { clearAll } from '@/db/posts'
import { DEFAULT_SETTINGS, STORAGE_KEYS, type AuthInfo, type Post } from '@/shared/types'

const NOW = 1_700_000_000_000
const STRIKE_KEY = 'sk-strike-SECRET'
const LLM_KEY = 'sk-llm-SECRET'
const SESSION = 'session-token-SECRET'
const KEEP_STRIKE = 'sk-keep-strike'
const KEEP_LLM = 'sk-keep-llm'
const KEEP_SESSION = 'session-keep'

const holder: { data: Record<string, unknown> } = { data: {} }

function installChrome() {
  holder.data = {}
  const local = {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) return { ...holder.data }
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
      const out: Record<string, unknown> = {}
      for (const key of list) out[key] = holder.data[key]
      return out
    },
    async set(items: Record<string, unknown>) {
      Object.assign(holder.data, items)
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete holder.data[key]
    },
  }
  const runtime = {
    lastError: undefined as { message?: string } | undefined,
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage(message: unknown, callback?: (result: unknown) => void) {
      void dispatch(message, { internal: true }).then((result) => callback?.(result))
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local }, runtime }
}

function post(id: string, note = 'local-note'): Post {
  return {
    tweet_id: id,
    sort_index: id.padStart(5, '0'),
    user_id: '7',
    screen_name: 'spammer',
    name: 'S',
    avatar: '',
    created_at: 1,
    text: 'hello 加群',
    lang: 'zh',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 1, quotes: 0, bookmarks: 1, views: 2 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: 'Dev',
    tags: ['keep'],
    status: 'active',
    saved_at: 1,
    sync_run: 'r',
    url: `https://x.com/spammer/status/${id}`,
    source: 'bookmark',
    accounts: ['alice'],
    note,
  }
}

function richState() {
  const state = freshState(NOW)
  applyMark(state, { tag: 'Spam', handle: 'spammer', tweetId: '100', textSnippet: 'buy followers' }, NOW)
  setAuthorFlag(state, { handle: 'spammer', flag: 'marketing', value: true, addStrike: false }, NOW)
  setHidden(state, { handle: 'spammer', hidden: true }, NOW)
  state.settings.enablePlatformActions = true
  state.settings.communityListsEnabled = true
  state.settings.tagEffects = { Spam: 'outline' }
  state.settings.keywordPacks = [{
    id: 'pack-1',
    name: '自定',
    enabled: true,
    suggestTag: 'Spam',
    patterns: [{ type: 'keyword', target: 'text', value: '加群', enqueue: false }],
  }] as unknown as typeof state.settings.keywordPacks
  state.settings.communityLists = [{
    id: 'list1',
    name: '示例',
    enabled: true,
    source: 'url',
    url: 'https://example.com/list.json',
    handles: ['spam_bot'],
    keywords: ['加群'],
    error: '',
    fetchedAt: NOW,
    updatedAt: NOW,
  }]
  state.vetoes = [{
    id: 'veto1',
    kind: 'rule',
    at: NOW,
    until: 0,
    packId: 'pack-1',
    packName: '自定',
    pattern: '加群',
    patternType: 'keyword',
    target: 'text',
    source: 'suspect',
  }] as unknown as typeof state.vetoes
  state.rate.paused = true
  const queued = enqueue(state, { handle: 'spammer', type: 'mute', source: 'manual' }, NOW)
  if (!queued.ok) throw new Error(queued.error || 'queue')
  state.settings.ai.apiKey = STRIKE_KEY
  return state
}

function rememberStrike(state: { settings: { ai: { apiKey?: string; hasApiKey?: boolean } } }, apiKey: string) {
  const slice = pickStrike(state)
  const ai = { ...(slice.settings.ai as Record<string, unknown>), apiKey: '', hasApiKey: !!apiKey }
  slice.settings.ai = ai
  holder.data.xsl = slice
  holder.data.xslSecret = { apiKey }
}

function auth(token: string): AuthInfo {
  return { token, csrf: 'csrf', uuid: 'uuid', transaction_id: 'txn', captured_at: 1 }
}

beforeEach(async () => {
  installChrome()
  await clearAll()
})

describe('full backup replace', () => {
  it('replaces ledger, queue, lists, vetoes, and bookmarks, and keeps secrets that were left out', async () => {
    const state = richState()
    rememberStrike(state, STRIKE_KEY)
    holder.data[STORAGE_KEYS.settings] = { ...DEFAULT_SETTINGS, lang: 'en', llm: { ...DEFAULT_SETTINGS.llm, apiKey: LLM_KEY } }
    holder.data[STORAGE_KEYS.auth] = auth(SESSION)
    holder.data[STORAGE_KEYS.accounts] = { alice: { user_id: '1', last_seen_at: 2 } }
    holder.data[STORAGE_KEYS.queryIds] = { Bookmarks: 'QID' }
    holder.data[STORAGE_KEYS.libraryColumns] = ['text', 'author']
    holder.data[STORAGE_KEYS.lastFullSync] = { finished_at: 9, pendingReport: false }
    holder.data[STORAGE_KEYS.progress] = { status: 'running' }
    await db.posts.put(post('99'))
    await db.folders.put({ name: 'Dev', source: 'local', created_at: 1 })
    await db.searchMeta.put({ key: 'main', dbVersion: 1, postCount: 1, updatedAt: 1, indexJson: { stale: true } })

    const file = await collectFullBackup(false, NOW)
    const text = JSON.stringify(file)
    expect(text).not.toContain(STRIKE_KEY)
    expect(text).not.toContain(LLM_KEY)
    expect(text).not.toContain(SESSION)
    const inspected = inspectBackup(JSON.parse(text))
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return

    await clearAll()
    await db.posts.put(post('other', 'gone'))
    const empty = freshState(NOW)
    applyMark(empty, { tag: 'Marketing', handle: 'otheracct', tweetId: '8', textSnippet: 'ad' }, NOW)
    rememberStrike(empty, KEEP_STRIKE)
    holder.data[STORAGE_KEYS.settings] = { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, apiKey: KEEP_LLM } }
    holder.data[STORAGE_KEYS.auth] = auth(KEEP_SESSION)
    holder.data[STORAGE_KEYS.progress] = { status: 'running' }

    await applyRestorePlan(inspected.plan)

    const restored = await db.posts.get('99')
    expect(restored?.note).toBe('local-note')
    expect(restored?.tags).toEqual(['keep'])
    expect(restored?.accounts).toEqual(['alice'])
    expect(await db.posts.get('other')).toBeUndefined()
    expect(await db.folders.get('Dev')).toBeTruthy()
    expect(await db.searchMeta.get('main')).toBeUndefined()

    const xsl = holder.data.xsl as StrikeSlice
    const account = Object.values(xsl.ledger).find((row) => (row as { handle?: string }).handle === 'spammer') as {
      authorFlags?: { marketing?: boolean }
    }
    expect(account?.authorFlags?.marketing).toBe(true)
    expect(xsl.queue).toHaveLength(1)
    expect((xsl.queue[0] as { type?: string }).type).toBe('mute')
    expect(xsl.vetoes).toHaveLength(1)
    expect(xsl.hidden && Object.keys(xsl.hidden).length).toBeGreaterThan(0)
    const packs = (xsl.settings.keywordPacks as { patterns: { enqueue?: boolean }[] }[])
    expect(packs[0]?.patterns[0]?.enqueue).toBe(false)
    const lists = xsl.settings.communityLists as { handles: string[]; url: string }[]
    expect(lists[0]?.handles).toContain('spam_bot')
    expect(lists[0]?.url).toContain('example.com')
    expect(xsl.settings.tagEffects).toMatchObject({ Spam: 'outline' })
    expect((xsl.settings as { communityListsEnabled?: boolean }).communityListsEnabled).toBe(true)
    expect(xsl.rate.paused).toBe(true)
    expect((holder.data.xslSecret as { apiKey: string }).apiKey).toBe(KEEP_STRIKE)
    expect((holder.data[STORAGE_KEYS.settings] as { llm: { apiKey: string }; lang: string }).llm.apiKey).toBe(KEEP_LLM)
    expect((holder.data[STORAGE_KEYS.settings] as { lang: string }).lang).toBe('en')
    expect((holder.data[STORAGE_KEYS.auth] as AuthInfo).token).toBe(KEEP_SESSION)
    expect(holder.data[STORAGE_KEYS.progress]).toBeUndefined()
    expect(holder.data[STORAGE_KEYS.queryIds]).toEqual({ Bookmarks: 'QID' })
    expect(holder.data[STORAGE_KEYS.lastFullSync]).toEqual({ finished_at: 9, pendingReport: false })
    expect(holder.data[STORAGE_KEYS.libraryColumns]).toEqual(['text', 'author'])
    expect((holder.data[STORAGE_KEYS.accounts] as { alice?: { user_id?: string } }).alice?.user_id).toBe('1')

    const secretFile = await collectFullBackup(true, NOW)
    expect(JSON.stringify(secretFile)).toContain(KEEP_STRIKE)
    holder.data.xslSecret = { apiKey: 'sk-other' }
    ;(holder.data[STORAGE_KEYS.settings] as { llm: { apiKey: string } }).llm.apiKey = 'sk-other-llm'
    holder.data[STORAGE_KEYS.auth] = auth('session-other')
    await db.posts.put(post('temp', 'temp'))
    const secretPlan = inspectBackup(JSON.parse(JSON.stringify(secretFile)))
    expect(secretPlan.ok).toBe(true)
    if (!secretPlan.ok) return
    await applyRestorePlan(secretPlan.plan)
    expect((holder.data.xslSecret as { apiKey: string }).apiKey).toBe(KEEP_STRIKE)
    expect((holder.data[STORAGE_KEYS.settings] as { llm: { apiKey: string } }).llm.apiKey).toBe(KEEP_LLM)
    expect((holder.data[STORAGE_KEYS.auth] as AuthInfo).token).toBe(KEEP_SESSION)
    expect(await db.posts.get('temp')).toBeUndefined()
    expect((await db.posts.get('99'))?.note).toBe('local-note')
  })

  it('restores an older bookmark file without touching the ledger', async () => {
    const state = freshState(NOW)
    applyMark(state, { tag: 'Spam', handle: 'keepme', tweetId: '300', textSnippet: 'x' }, NOW)
    rememberStrike(state, KEEP_STRIKE)
    await db.posts.put(post('old', 'old'))
    holder.data[STORAGE_KEYS.progress] = { status: 'running' }
    const plan = inspectBackup({
      app: 'bookmark-keeper',
      version: 1,
      exported_at: NOW,
      posts: [post('new', 'from-old-file')],
      folders: [{ name: 'Imported', source: 'local', created_at: 2 }],
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    await applyRestorePlan(plan.plan)
    expect((await db.posts.get('new'))?.note).toBe('from-old-file')
    expect(await db.posts.get('old')).toBeUndefined()
    expect(await db.folders.get('Imported')).toBeTruthy()
    const handles = Object.values((holder.data.xsl as StrikeSlice).ledger).map((row) => (row as { handle?: string }).handle)
    expect(handles).toContain('keepme')
    expect((holder.data.xslSecret as { apiKey: string }).apiKey).toBe(KEEP_STRIKE)
    expect(holder.data[STORAGE_KEYS.progress]).toBeUndefined()
  })

  it('reports a strike write failure after the library was replaced', async () => {
    await db.posts.put(post('99', 'from-backup'))
    const file = await collectFullBackup(false, NOW)
    await db.posts.put(post('other', 'only-local'))
    const plan = inspectBackup(JSON.parse(JSON.stringify(file)))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const runtime = (globalThis as unknown as { chrome: { runtime: { sendMessage: (message: unknown, callback?: (result: unknown) => void) => void } } }).chrome.runtime
    runtime.sendMessage = (_message, callback) => callback?.({ ok: false, error: 'nope' })
    await expect(applyRestorePlan(plan.plan)).rejects.toThrow('strike:nope')
    expect((await db.posts.get('99'))?.note).toBe('from-backup')
    expect(await db.posts.get('other')).toBeUndefined()
  })
})
