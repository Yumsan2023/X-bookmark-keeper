import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { parseTimelinePage, type ParsedPost } from '@/api/parser'
import {
  addTags, clearAll, createBackup, createLocalFolder, deleteFolder, deleteTag, importBackup, listFolders, listTags, markTweetsDeleted,
  markUnbookmarkedNotSeen, moveToFolder, removeTags, renameFolder, renameTag, upsertFolder, upsertParsed, validateBackup,
} from '@/db/posts'
import { bookmarksPage, tweet, tweetEntry } from './fixtures/builders'

function parsed(ids: string[]): ParsedPost[] {
  return parseTimelinePage(bookmarksPage(ids.map((id, i) => tweetEntry(tweet({ id, text: `t${id}` }), String(9000 - i))))).entries.map((e) => (e as any).post)
}

beforeEach(async () => {
  await clearAll()
})

describe('posts repo', () => {
  it('upsert keeps local fields (tags, folder, note) and counts added/updated', async () => {
    const r1 = await upsertParsed(parsed(['1', '2']), 'run1')
    expect(r1).toMatchObject({ added: 2, updated: 0, existingIds: [] })
    await addTags(['1'], ['x'])
    await moveToFolder(['1'], 'F')
    await db.posts.update('1', { note: 'n' })
    const r2 = await upsertParsed(parsed(['1', '3']), 'run2')
    expect(r2).toMatchObject({ added: 1, updated: 1, existingIds: ['1'] })
    const p = (await db.posts.get('1'))!
    expect(p).toMatchObject({ tags: ['x'], folder: 'F', note: 'n', sync_run: 'run2', status: 'active' })
  })

  it('marks deleted tweets without dropping them', async () => {
    await upsertParsed(parsed(['1']), 'r')
    expect(await markTweetsDeleted(['1', 'nope'], 'r2')).toBe(1)
    const p = (await db.posts.get('1'))!
    expect(p.status).toBe('tweet_deleted')
    expect(p.text).toBe('t1')
    expect(p.deleted_at).toBeTypeOf('number')
  })

  it('markUnbookmarkedNotSeen flags unseen active posts only (kept in db)', async () => {
    await upsertParsed(parsed(['1', '2', '3']), 'old')
    await upsertParsed(parsed(['1', '3']), 'new')
    expect(await markUnbookmarkedNotSeen('new', 2)).toBe(1)
    expect((await db.posts.get('2'))!.status).toBe('unbookmarked')
    expect((await db.posts.get('1'))!.status).toBe('active')
    expect(await db.posts.count()).toBe(3)
    // 重新出现在书签里 → 恢复 active
    await upsertParsed(parsed(['2']), 'newer')
    expect((await db.posts.get('2'))!.status).toBe('active')
  })

  it('safety guard: refuses to mass-mark when far fewer posts were seen', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => String(100 + i))
    await upsertParsed(parsed(ids), 'old')
    expect(await markUnbookmarkedNotSeen('new', 2)).toBe(-1)
    expect(await db.posts.where('status').equals('active').count()).toBe(30)
  })

  it('tags: add/remove/rename/delete/list', async () => {
    await upsertParsed(parsed(['1', '2']), 'r')
    await addTags(['1', '2'], ['#AI', 'to read', ''])
    expect((await db.posts.get('1'))!.tags).toEqual(['AI', 'to-read'])
    await removeTags(['2'], ['AI'])
    expect(await listTags()).toEqual([{ tag: 'AI', count: 1 }, { tag: 'to-read', count: 2 }].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
    expect(await renameTag('to-read', 'later')).toBe(2)
    expect(await db.posts.where('tags').equals('later').count()).toBe(2)
    expect(await deleteTag('later')).toBe(2)
    expect((await listTags()).map((t) => t.tag)).toEqual(['AI'])
  })

  it('folders: create, move, rename cascades to posts, delete unfiles', async () => {
    await upsertParsed(parsed(['1', '2']), 'r')
    await createLocalFolder('Dev')
    await moveToFolder(['1', '2'], 'Dev')
    await moveToFolder(['2'], 'AutoCreated')
    expect((await listFolders()).map((f) => [f.name, f.count, f.source])).toEqual([['AutoCreated', 1, 'local'], ['Dev', 1, 'local']])
    await renameFolder('Dev', 'Development')
    expect((await db.posts.get('1'))!.folder).toBe('Development')
    await upsertFolder({ name: 'Development', x_id: '55', source: 'x', created_at: 1 })
    expect((await db.folders.get('Development'))!.x_id).toBe('55')
    await deleteFolder('Development')
    expect((await db.posts.get('1'))!.folder).toBe('')
    expect(await db.folders.get('Development')).toBeUndefined()
  })

  it('backup export/import roundtrip merges tags', async () => {
    await upsertParsed(parsed(['1', '2']), 'r')
    await addTags(['1'], ['a'])
    await createLocalFolder('F')
    const b = await createBackup()
    expect(validateBackup(b)).toBe(true)
    await clearAll()
    expect(await db.posts.count()).toBe(0)
    await addTags([], [])
    const r = await importBackup(JSON.parse(JSON.stringify(b)))
    expect(r).toEqual({ posts: 2, folders: 1 })
    expect((await db.posts.get('1'))!.tags).toEqual(['a'])
    await expect(importBackup({ nope: 1 } as any)).rejects.toThrow()
  })
})
