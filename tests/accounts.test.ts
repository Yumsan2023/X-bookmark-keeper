import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseTimelinePage, type ParsedPost } from '@/api/parser'
import { clearAll, markUnbookmarkedNotSeen, releaseBookmark, upsertParsed } from '@/db/posts'
import { bookmarksPage, tweet, tweetEntry } from './fixtures/builders'
import { decideDelete, partitionDeletes, twidFromCookie } from '@/shared/accounts'

function parsed(ids: string[]): ParsedPost[] {
  return parseTimelinePage(bookmarksPage(ids.map((id, i) => tweetEntry(tweet({ id, text: `t${id}` }), String(9000 - i))))).entries.map((e) => (e as { post: ParsedPost }).post)
}

beforeEach(async () => {
  await clearAll()
})

describe('bookmark accounts', () => {
  it('reads twid from a cookie header', () => {
    expect(twidFromCookie('guest_id=1; twid=u%3D42; other=1')).toBe('42')
    expect(twidFromCookie('twid="99"')).toBe('99')
    expect(twidFromCookie('auth_token=abc')).toBeUndefined()
  })

  it('stamps the syncing account and keeps other owners on delete', async () => {
    await upsertParsed(parsed(['1']), 'run', { source: 'bookmark', account: 'alice' })
    await upsertParsed(parsed(['1']), 'run2', { source: 'bookmark', account: 'bob' })
    expect((await (await import('@/db/db')).db.posts.get('1'))!.accounts).toEqual(['alice', 'bob'])
    expect(await releaseBookmark('1', 'alice', true)).toBe('keep')
    expect((await (await import('@/db/db')).db.posts.get('1'))!.accounts).toEqual(['bob'])
    expect((await (await import('@/db/db')).db.posts.get('1'))!.status).toBe('active')
    expect(await releaseBookmark('1', 'bob', false)).toBe('unbookmark')
    expect((await (await import('@/db/db')).db.posts.get('1'))!.status).toBe('unbookmarked')
  })

  it('partitions deletes: other accounts skipped, unknown legacy rows allowed', () => {
    const posts = [
      { tweet_id: 'a', accounts: ['alice'] },
      { tweet_id: 'b', accounts: ['bob'] },
      { tweet_id: 'c', accounts: [] as string[] },
    ]
    expect(partitionDeletes(['a', 'b', 'c', 'a'], posts, 'Alice')).toEqual({
      allowed: ['a', 'c'],
      skipped: ['b'],
      unknown: ['c'],
    })
    expect(decideDelete({ accounts: ['alice', 'bob'] }, 'alice', true)).toEqual({ kind: 'keep', accounts: ['bob'] })
    expect(decideDelete({ accounts: ['alice'] }, 'alice', true)).toEqual({ kind: 'remove' })
  })

  it('does not mass-unbookmark when the library has account stamps but this run has no account', async () => {
    await upsertParsed(parsed(['1', '2']), 'old', { account: 'alice' })
    expect(await markUnbookmarkedNotSeen('new', 0)).toBe(-2)
    expect((await (await import('@/db/db')).db.posts.get('1'))!.status).toBe('active')
  })

  it('unbookmarks only the current account when a full sync misses their bookmark', async () => {
    await upsertParsed(parsed(['1']), 'old', { account: 'alice' })
    await upsertParsed(parsed(['1']), 'old', { account: 'bob' })
    await upsertParsed(parsed(['2']), 'old', { account: 'alice' })
    expect(await markUnbookmarkedNotSeen('new', 1, 'alice')).toBe(1)
    const shared = (await (await import('@/db/db')).db.posts.get('1'))!
    expect(shared.status).toBe('active')
    expect(shared.accounts).toEqual(['bob'])
    expect((await (await import('@/db/db')).db.posts.get('2'))!.status).toBe('unbookmarked')
  })
})
