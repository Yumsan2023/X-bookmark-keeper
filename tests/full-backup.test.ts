import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  APP_VERSION,
  FULL_BACKUP_FORMAT,
  FULL_BACKUP_VERSION,
  buildFullBackup,
  inspectBackup,
  inspectBackupText,
  serializeBackup,
  type FullBackupInput,
} from '@/backup/full'
import { DEFAULT_SETTINGS, type Folder, type Post } from '@/shared/types'

const STRIKE_KEY = 'sk-strike-SECRET'
const LLM_KEY = 'sk-llm-SECRET'
const SESSION = 'session-token-SECRET'

function post(id: string, note = ''): Post {
  return {
    tweet_id: id,
    sort_index: id.padStart(5, '0'),
    user_id: '7',
    screen_name: 'spammer',
    name: 'S',
    avatar: '',
    created_at: 1,
    text: `hello ${id}`,
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

function folder(): Folder {
  return { name: 'Dev', source: 'local', created_at: 1 }
}

function input(includeSecrets: boolean): FullBackupInput {
  return {
    includeSecrets,
    now: Date.UTC(2026, 10, 1),
    posts: [post('99', 'local-note')],
    folders: [folder()],
    strike: {
      schema: 1,
      settings: {
        keywordPacks: [{
          id: 'pack-1',
          name: '自定',
          enabled: true,
          suggestTag: 'Spam',
          patterns: [{ type: 'keyword', target: 'text', value: '加群', enqueue: false }],
        }],
        communityLists: [{
          id: 'list1',
          name: '示例',
          url: 'https://example.com/list.json',
          handles: ['spam_bot'],
          keywords: ['加群'],
        }],
        ai: { apiKey: STRIKE_KEY, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
      },
      ledger: {
        u1: { userId: 'u1', handle: 'spammer', authorFlags: { marketing: true, spam: false }, tags: [] },
      },
      tweets: {},
      hidden: { u1: { userId: 'u1', handle: 'spammer' } },
      queue: [{ id: 'q1', type: 'mute', userId: 'u1', handle: 'spammer', status: 'pending' }],
      vetoes: [{ id: 'veto1', kind: 'rule', pattern: '加群' }],
      log: [],
      undo: [],
      aiCache: {},
      hitLog: [],
      rate: { paused: true },
    },
    storage: {
      settings: { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm, apiKey: LLM_KEY } },
      accounts: { alice: { user_id: '1' } },
      queryIds: { Bookmarks: 'QID' },
      libraryColumns: ['text'],
      lastFullSync: { at: 5 },
      auth: { token: SESSION, csrf: 'csrf-1', uuid: 'u', transaction_id: 't', captured_at: 1 },
    },
  }
}

describe('full backup file', () => {
  it('matches the extension version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8')) as { version: string }
    expect(APP_VERSION).toBe('0.7.15')
    expect(pkg.version).toBe(APP_VERSION)
    expect(manifest.version).toBe(APP_VERSION)
  })

  it('leaves secrets out unless asked, and keeps a format version', () => {
    const file = buildFullBackup(input(false))
    const text = serializeBackup(file)
    expect(file.format).toBe(FULL_BACKUP_FORMAT)
    expect(file.version).toBe(FULL_BACKUP_VERSION)
    expect(file.appVersion).toBe(APP_VERSION)
    expect(file.secretsIncluded).toBe(false)
    expect(file.omittedSecrets).toEqual(['strikeAiKey', 'bookmarkLlmKey', 'session'])
    expect(text).not.toContain(STRIKE_KEY)
    expect(text).not.toContain(LLM_KEY)
    expect(text).not.toContain(SESSION)
    expect(file.bookmarks.posts[0]?.note).toBe('local-note')
    expect(file.storage.auth).toBeUndefined()

    const withSecrets = buildFullBackup(input(true))
    const secretText = serializeBackup(withSecrets)
    expect(withSecrets.secretsIncluded).toBe(true)
    expect(withSecrets.omittedSecrets).toEqual([])
    expect(secretText).toContain(STRIKE_KEY)
    expect(secretText).toContain(LLM_KEY)
    expect(secretText).toContain(SESSION)
  })

  it('summarizes counts and replaces duplicate posts with the later copy', () => {
    const file = buildFullBackup(input(false))
    file.bookmarks.posts.push(post('99', 'second'))
    const inspected = inspectBackup(file)
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.plan.mode).toBe('replace')
    expect(inspected.plan.summary).toMatchObject({
      kind: 'full',
      format: FULL_BACKUP_FORMAT,
      version: 1,
      posts: 1,
      folders: 1,
      ledgerAccounts: 1,
      authorFlags: 1,
      keywordPacks: 1,
      keywordRules: 1,
      vetoes: 1,
      communityLists: 1,
      queue: 1,
      hidden: 1,
      secretsIncluded: false,
    })
    expect(inspected.plan.posts[0]?.note).toBe('second')
    expect(inspected.plan.storage?.settings.llm.apiKey).toBe('')
  })

  it('drops a key that was stuffed into a file marked as secret-free', () => {
    const file = buildFullBackup(input(true))
    file.secretsIncluded = false
    const inspected = inspectBackup(JSON.parse(serializeBackup(file)))
    expect(inspected.ok).toBe(true)
    if (!inspected.ok || !inspected.plan.strike || !inspected.plan.storage) return
    expect(String((inspected.plan.strike.settings.ai as { apiKey?: string }).apiKey || '')).toBe('')
    expect(inspected.plan.storage.settings.llm.apiKey).toBe('')
    expect(inspected.plan.storage.auth).toBeUndefined()
    expect(inspected.plan.secretsIncluded).toBe(false)
  })

  it('accepts an older bookmark-keeper file as a library replace', () => {
    const inspected = inspectBackup({
      app: 'bookmark-keeper',
      version: 1,
      exported_at: Date.UTC(2026, 0, 2),
      posts: [post('1'), post('1', 'later')],
      folders: [folder()],
    })
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.plan.kind).toBe('bookmarks-legacy')
    expect(inspected.plan.summary.posts).toBe(1)
    expect(inspected.plan.summary.ledgerAccounts).toBe(0)
    expect(inspected.plan.strike).toBeNull()
    expect(inspected.plan.posts[0]?.note).toBe('later')
  })

  it('rejects a newer full backup, a ledger-only export, and broken JSON', () => {
    const future = inspectBackup({ format: FULL_BACKUP_FORMAT, version: 2 })
    const ledger = inspectBackup({ product: 'x-strike-ledger', schema: 1, ledger: {} })
    const broken = inspectBackupText('{')
    const unknown = inspectBackup({ nope: true })
    expect(future.ok).toBe(false)
    expect(ledger.ok).toBe(false)
    expect(broken.ok).toBe(false)
    expect(unknown.ok).toBe(false)
    if (future.ok || ledger.ok || broken.ok || unknown.ok) return
    expect(future.error).toBe('future-version')
    expect(ledger.error).toBe('ledger-only')
    expect(broken.error).toBe('bad-json')
    expect(unknown.error).toBe('bad-file')
  })
})
