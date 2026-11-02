import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_LIBRARY_FORMAT,
  accountLibraryFileName,
  buildAccountLibraryExport,
  filterPostsForAccountExport,
  foldersForAccountExport,
  postMatchesAccountExport,
  serializeAccountLibrary,
} from '@/backup/account-library'
import { inspectBackup } from '@/backup/full'
import { db } from '@/db/db'
import { clearAll, countUnstampedBookmarks, listBookmarkAccounts, postsForAccountExport } from '@/db/posts'
import { UNKNOWN_ACCOUNT } from '@/shared/accounts'
import type { Folder, Post } from '@/shared/types'

function post(id: string, patch: Partial<Post> = {}): Post {
  return {
    tweet_id: id,
    sort_index: id.padStart(5, '0'),
    user_id: '7',
    screen_name: 'author',
    name: 'A',
    avatar: '',
    created_at: 1,
    text: `text ${id}`,
    lang: 'zh',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 1, quotes: 0, bookmarks: 1, views: 2 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: '',
    tags: [],
    status: 'active',
    saved_at: 1,
    sync_run: 'r',
    url: `https://x.com/author/status/${id}`,
    source: 'bookmark',
    accounts: [],
    ...patch,
  }
}

const dev: Folder = { name: 'Dev', source: 'local', created_at: 1 }
const other: Folder = { name: 'Other', source: 'x', created_at: 2, x_id: '9' }

beforeEach(async () => {
  await clearAll()
})

describe('account bookmark export filter', () => {
  const alice = post('1', { accounts: ['alice'], folder: 'Dev', tags: ['keep'], note: 'alice-note' })
  const both = post('2', { accounts: ['alice', 'bob'], folder: 'Dev', tags: ['shared'], note: 'both-note' })
  const bob = post('3', { accounts: ['Bob'], folder: 'Other', tags: ['bob-tag'], note: 'bob-note' })
  const blank = post('4', { accounts: [], folder: 'Dev', tags: ['old'], note: 'blank-note' })
  const missing = post('5', { accounts: undefined, note: 'missing-note' })
  const timeline = post('6', { accounts: [], source: 'timeline', folder: 'timeline:@carol', note: 'timeline-note' })
  const posts = [alice, both, bob, blank, missing, timeline]

  it('keeps posts whose accounts include the chosen handle, including shared posts', () => {
    const picked = filterPostsForAccountExport(posts, { account: '@Alice' })
    expect(picked.map((row) => row.tweet_id)).toEqual(['1', '2'])
    expect(picked[1]?.accounts).toEqual(['alice', 'bob'])
    expect(picked[0]?.note).toBe('alice-note')
    expect(picked[0]?.tags).toEqual(['keep'])
    expect(postMatchesAccountExport(bob, { account: 'alice' })).toBe(false)
    expect(postMatchesAccountExport(blank, { account: 'alice' })).toBe(false)
    expect(postMatchesAccountExport(timeline, { account: 'alice' })).toBe(false)
  })

  it('matches a handle stored with different case', () => {
    expect(filterPostsForAccountExport(posts, { account: 'bob' }).map((row) => row.tweet_id)).toEqual(['2', '3'])
  })

  it('adds unstamped bookmarks when asked, and still skips timeline rows', () => {
    const picked = filterPostsForAccountExport(posts, { account: 'alice', includeUnknown: true })
    expect(picked.map((row) => row.tweet_id)).toEqual(['1', '2', '4', '5'])
    expect(picked.some((row) => row.source === 'timeline')).toBe(false)
  })

  it('exports only unstamped bookmarks for the unknown account', () => {
    const picked = filterPostsForAccountExport(posts, { account: UNKNOWN_ACCOUNT })
    expect(picked.map((row) => row.tweet_id)).toEqual(['4', '5'])
    expect(filterPostsForAccountExport(posts, { account: '__UNKNOWN__' }).map((row) => row.tweet_id)).toEqual(['4', '5'])
    expect(postMatchesAccountExport(timeline, { account: UNKNOWN_ACCOUNT })).toBe(false)
    expect(postMatchesAccountExport(alice, { account: UNKNOWN_ACCOUNT, includeUnknown: true })).toBe(false)
  })

  it('drops a value that is not a handle', () => {
    expect(filterPostsForAccountExport(posts, { account: 'not a handle' })).toEqual([])
    expect(filterPostsForAccountExport(posts, { account: '' })).toEqual([])
    expect(buildAccountLibraryExport({ posts, folders: [dev], account: '@@@' })).toBeNull()
  })

  it('builds a bookmark-library file with tags, notes, owners, and only used folders', () => {
    const file = buildAccountLibraryExport({
      posts,
      folders: [other, dev, dev],
      account: 'alice',
      includeUnknown: false,
      now: Date.UTC(2026, 10, 2),
    })
    expect(file).toMatchObject({
      app: 'bookmark-keeper',
      version: 1,
      format: ACCOUNT_LIBRARY_FORMAT,
      account: 'alice',
      includeUnknown: false,
      exported_at: Date.UTC(2026, 10, 2),
    })
    expect(file?.posts.map((row) => row.tweet_id)).toEqual(['2', '1'])
    expect(file?.posts.find((row) => row.tweet_id === '1')).toMatchObject({
      note: 'alice-note',
      tags: ['keep'],
      folder: 'Dev',
      accounts: ['alice'],
    })
    expect(file?.posts.find((row) => row.tweet_id === '2')?.accounts).toEqual(['alice', 'bob'])
    expect(file?.folders).toEqual([dev])
    expect(foldersForAccountExport([bob], [dev, other])).toEqual([other])
    expect(accountLibraryFileName('alice', Date.UTC(2026, 10, 2))).toBe('bookmark-keeper-alice-2026-11-02.json')
    expect(accountLibraryFileName(UNKNOWN_ACCOUNT, Date.UTC(2026, 10, 2))).toBe('bookmark-keeper-unknown-2026-11-02.json')
    const text = serializeAccountLibrary(file!)
    expect(text).toContain('alice-note')
    expect(text).toContain('bookmark-keeper-account')
    expect(text).not.toContain('bob-note')
    expect(text).not.toContain('timeline-note')
    alice.note = 'mutated-after-export'
    expect(file?.posts.find((row) => row.tweet_id === '1')?.note).toBe('alice-note')
    alice.note = 'alice-note'
  })

  it('marks an unknown-only file as including unstamped rows', () => {
    const file = buildAccountLibraryExport({ posts, folders: [dev, other], account: UNKNOWN_ACCOUNT, now: 5 })
    expect(file?.includeUnknown).toBe(true)
    expect(file?.account).toBe(UNKNOWN_ACCOUNT)
    expect(file?.posts.map((row) => row.tweet_id)).toEqual(['5', '4'])
    expect(file?.folders.map((folder) => folder.name)).toEqual(['Dev'])
  })

  it('is restored as a library merge, while a file without format still replaces', () => {
    const file = buildAccountLibraryExport({
      posts: [alice, bob],
      folders: [dev, other],
      account: 'alice',
      now: 8,
    })
    const inspected = inspectBackup(JSON.parse(serializeAccountLibrary(file!)))
    expect(inspected.ok).toBe(true)
    if (!inspected.ok) return
    expect(inspected.plan.kind).toBe('bookmarks-account')
    expect(inspected.plan.mode).toBe('merge')
    expect(inspected.plan.account).toBe('alice')
    expect(inspected.plan.includeUnknown).toBe(false)
    expect(inspected.plan.strike).toBeNull()
    expect(inspected.plan.summary.posts).toBe(1)
    expect(inspected.plan.summary.ledgerAccounts).toBe(0)
    expect(inspected.plan.posts[0]?.note).toBe('alice-note')

    const stripped = { ...file, format: undefined }
    const legacy = inspectBackup(stripped)
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) return
    expect(legacy.plan.kind).toBe('bookmarks-legacy')
    expect(legacy.plan.mode).toBe('replace')
  })

  it('rejects a newer account file and a file with no account', () => {
    const future = inspectBackup({
      app: 'bookmark-keeper',
      version: 2,
      format: ACCOUNT_LIBRARY_FORMAT,
      account: 'alice',
      posts: [],
      folders: [],
    })
    const nameless = inspectBackup({
      app: 'bookmark-keeper',
      version: 1,
      format: ACCOUNT_LIBRARY_FORMAT,
      posts: [alice],
      folders: [],
    })
    expect(future).toEqual({ ok: false, error: 'future-version' })
    expect(nameless).toEqual({ ok: false, error: 'bad-file' })
  })

  it('reads the same subset from the library index', async () => {
    await db.posts.bulkPut([alice, both, { ...bob, accounts: ['bob'] }, blank, missing, timeline])
    await db.folders.bulkPut([dev, other])
    expect((await listBookmarkAccounts()).map((row) => row.account).sort()).toEqual(['alice', 'bob'])
    expect(await countUnstampedBookmarks()).toBe(2)
    const named = await postsForAccountExport({ account: '@alice' })
    expect(named.map((row) => row.tweet_id).sort()).toEqual(['1', '2'])
    const withBlank = await postsForAccountExport({ account: 'alice', includeUnknown: true })
    expect(withBlank.map((row) => row.tweet_id).sort()).toEqual(['1', '2', '4', '5'])
    const unknown = await postsForAccountExport({ account: UNKNOWN_ACCOUNT })
    expect(unknown.map((row) => row.tweet_id).sort()).toEqual(['4', '5'])
    expect(await postsForAccountExport({ account: 'nope space' })).toEqual([])
    await db.posts.put(post('9', { accounts: ['Alice'], note: 'cased', tags: ['Cased'], folder: 'Dev' }))
    const cased = await postsForAccountExport({ account: 'alice' })
    expect(cased.map((row) => row.tweet_id).sort()).toEqual(['1', '2', '9'])
    expect(cased.find((row) => row.tweet_id === '9')).toMatchObject({ note: 'cased', tags: ['Cased'], accounts: ['Alice'] })
  })
})
