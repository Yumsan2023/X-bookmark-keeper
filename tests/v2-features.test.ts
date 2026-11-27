import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideAutoSync } from '@/background/auto-sync'
import { getCleanupSummary, importCleanupQueueJson, removeCleanupItems } from '@/db/cleanup'
import { db } from '@/db/db'
import { upsertParsed } from '@/db/posts'
import { postsToSelfContainedHtml } from '@/export/html'
import { buildNotionPagePayload, pushPostsToNotion } from '@/export/notion'
import { parseCompactNumber } from '@/strike/lib/domparse.js'
import { computeHumanDwellMs } from '@/strike/content/foryou.js'
import { pickDailyReviewCandidates } from '@/ui/daily-review'
import type { Post } from '@/shared/types'

function makePost(over: Partial<Post> = {}): Post {
  return {
    tweet_id: '1001',
    sort_index: '00001001',
    user_id: 'u1',
    screen_name: 'alice',
    name: 'Alice',
    avatar: '',
    created_at: new Date('2025-11-27T08:00:00Z').getTime(),
    saved_at: Date.now(),
    text: 'Deep dive into Claude Code and local SQLite pipelines.',
    lang: 'en',
    urls: ['https://github.com/example/repo'],
    media: [],
    metrics: { replies: 5, retweets: 20, likes: 400, quotes: 4, bookmarks: 650, views: 15000 },
    has_image: 0,
    has_video: 0,
    has_link: 1,
    has_quote: 0,
    folder: 'AI工具与工作流',
    tags: ['tier:S-核心精华', '干货教程'],
    status: 'active',
    sync_run: 'r1',
    url: 'https://x.com/alice/status/1001',
    source: 'bookmark',
    accounts: ['justdoityum'],
    ...over,
  }
}

describe('v2 auto-sync controller', () => {
  it('allows sync when enabled, authed, idle, and past cooldown', () => {
    const now = 1_760_000_000_000
    const res = decideAutoSync({
      settings: { autoSyncOnXOpen: true, autoSyncCooldownMin: 20 },
      hasAuth: true,
      busy: false,
      account: '@JustDoItYum',
      lastMap: { justdoityum: now - 25 * 60_000 },
      now,
    })
    expect(res).toEqual({ run: true, reason: 'ok', account: 'justdoityum' })
  })

  it('respects per-account cooldown without blocking a different logged-in account', () => {
    const now = 1_760_000_000_000
    const blocked = decideAutoSync({
      settings: { autoSyncOnXOpen: true, autoSyncCooldownMin: 20 },
      hasAuth: true,
      busy: false,
      account: 'justdoityum',
      lastMap: { justdoityum: now - 5 * 60_000 },
      now,
    })
    expect(blocked.run).toBe(false)
    expect(blocked.reason).toBe('cooldown')

    const other = decideAutoSync({
      settings: { autoSyncOnXOpen: true, autoSyncCooldownMin: 20 },
      hasAuth: true,
      busy: false,
      account: 'attnltd2026',
      lastMap: { justdoityum: now - 5 * 60_000 },
      now,
    })
    expect(other.run).toBe(true)
    expect(other.account).toBe('attnltd2026')
  })

  it('blocks when disabled, missing auth, or busy', () => {
    expect(
      decideAutoSync({
        settings: { autoSyncOnXOpen: false, autoSyncCooldownMin: 20 },
        hasAuth: true,
        busy: false,
        account: 'alice',
        lastMap: {},
      }).reason,
    ).toBe('disabled')
    expect(
      decideAutoSync({
        settings: { autoSyncOnXOpen: true, autoSyncCooldownMin: 20 },
        hasAuth: false,
        busy: false,
        account: 'alice',
        lastMap: {},
      }).reason,
    ).toBe('no-auth')
    expect(
      decideAutoSync({
        settings: { autoSyncOnXOpen: true, autoSyncCooldownMin: 20 },
        hasAuth: true,
        busy: true,
        account: 'alice',
        lastMap: {},
      }).reason,
    ).toBe('busy')
  })
})

describe('v2 cleanup queue & cold tombstones', () => {
  beforeEach(async () => {
    await db.posts.clear()
    await db.cleanupQueue.clear()
    await db.coldTombstones.clear()
  })

  it('imports cleanup_queue_by_account.json and prevents incremental re-import of tombstoned cold posts', async () => {
    const payload = JSON.stringify({
      format: 'x-toolkit-cleanup-queue',
      version: 1,
      accounts: {
        justdoityum: {
          count: 1,
          items: [
            {
              tweet_id: '9001',
              url: 'https://x.com/spam/status/9001',
              screen_name: 'spam',
              text_preview: 'giveaway',
              reason: 'rule:spam-giveaway',
              accounts: ['justdoityum'],
            },
          ],
        },
      },
      cold_tombstone_ids: ['9001', '8888'],
    })

    const imp = await importCleanupQueueJson(payload)
    expect(imp).toEqual({ importedItems: 1, importedTombstones: 2 })

    const sum = await getCleanupSummary()
    expect(sum.pending).toBe(1)
    expect(sum.tombstones).toBe(2)
    expect(sum.byAccount[0].account).toBe('justdoityum')

    // Incremental sync with respectTombstones=true skips '8888' and marks it as seen!
    const up = await upsertParsed(
      [
        {
          ...makePost({ tweet_id: '8888' }),
        },
        {
          ...makePost({ tweet_id: '7777' }),
        },
      ],
      'run-1',
      { source: 'bookmark', account: 'justdoityum', respectTombstones: true },
    )
    expect(up.added).toBe(1)
    expect(up.existingIds).toContain('8888')
    expect(await db.posts.get('8888')).toBeUndefined()
    expect(await db.posts.get('7777')).toBeDefined()

    await removeCleanupItems(['9001'])
    expect((await getCleanupSummary()).pending).toBe(0)
  })
})

describe('v2 dom metric parsing, humanized dwell, HTML/Notion export & Daily Review', () => {
  it('parses compact engagement counts from aria-label and text', () => {
    expect(parseCompactNumber('1,234 Likes')).toBe(1234)
    expect(parseCompactNumber('2.5K')).toBe(2500)
    expect(parseCompactNumber('1.3万 次喜欢')).toBe(13000)
    expect(parseCompactNumber('3M')).toBe(3000000)
    expect(parseCompactNumber('')).toBeNull()
  })

  it('computes longer dwell time for long posts than short posts', () => {
    const shortMs = computeHumanDwellMs([{ text: 'short' }], () => 0.5)
    const longMs = computeHumanDwellMs([{ text: 'a'.repeat(500) }], () => 0.5)
    expect(shortMs).toBeGreaterThanOrEqual(1500)
    expect(longMs).toBeGreaterThan(shortMs)
  })

  it('exports safe self-contained offline HTML with threads & escaped script tags', () => {
    const html = postsToSelfContainedHtml([
      makePost({
        text: 'Hello </script><script>alert(1)</script>',
        thread: [{ tweet_id: '1002', text: 'Part 2 of thread', created_at: Date.now(), media: [] }],
      }),
    ])
    expect(html).toContain('<!doctype html>')
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('Part 2 of thread')
  })

  it('builds Notion payload and pushes via fetch', async () => {
    const post = makePost({ note: 'Great read!' })
    const body = buildNotionPagePayload(post, 'db-123')
    expect((body.parent as { database_id: string }).database_id).toBe('db-123')

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }))
    const res = await pushPostsToNotion([post], { token: 'ntn_test', databaseId: 'db-123' }, mockFetch as unknown as typeof fetch)
    expect(res).toEqual({ pushed: 1, failed: 0, errors: [] })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('excludes 待清理 posts from Daily Review and picks active gems', () => {
    const keep = makePost({ tweet_id: '1', folder: 'AI工具与工作流' })
    const cleanup = makePost({ tweet_id: '2', folder: '待清理' })
    const picked = pickDailyReviewCandidates([keep, cleanup], 5, Date.now(), () => 0.5)
    expect(picked.map((p) => p.tweet_id)).toEqual(['1'])
  })
})
