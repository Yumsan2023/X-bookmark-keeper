import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractArticleContent,
  needsDirectArticleRepair,
  needsQuotedArticleRepair,
  parseThread,
  tweetToPost,
} from '@/api/parser'
import { decideAutoSync } from '@/background/auto-sync'
import { cancelTask, recoverInterruptedTask } from '@/background/actions'
import { getCleanupSummary, importCleanupQueueJson, removeCleanupItems } from '@/db/cleanup'
import { db } from '@/db/db'
import { mergePost, upsertParsed } from '@/db/posts'
import { countYearsForQuery, invalidateStubCache, pagePostsNoText } from '@/db/query'
import { postsToSelfContainedHtml } from '@/export/html'
import { postToMarkdown } from '@/export/markdown'
import { buildNotionPagePayload, buildNotionQuotePayload, listNotionDatabases, pushPostsToNotion, pushQuoteToNotion } from '@/export/notion'
import { SearchEngine } from '@/search/engine'
import { parseQuery } from '@/search/query-parser'
import { buildIndexBatched, searchPage } from '@/search/service'
import { threadResponse, tweet } from './fixtures/builders'
import { parseCompactNumber } from '@/strike/lib/domparse.js'
import { computeHumanDwellMs } from '@/strike/content/foryou.js'
import { pickDailyReviewCandidates } from '@/ui/daily-review'
import { findMatchedSnippet } from '@/ui/v2/HighlightText'
import { STORAGE_KEYS, type Post } from '@/shared/types'

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

describe('v2 X Article full-body parsing, quoted article repair detection & clean threads', () => {
  it('renders full Draft.js content_state blocks from X Articles into structured Markdown', () => {
    const res = extractArticleContent({
      title: 'How to Build Local Agents',
      preview_text: 'Short preview...',
      content_state: {
        blocks: [
          { type: 'header-two', text: 'Architecture' },
          { type: 'unstyled', text: 'First paragraph with details.' },
          { type: 'unordered-list-item', text: 'Item A' },
          { type: 'ordered-list-item', text: 'Step One' },
          { type: 'blockquote', text: 'Key insight' },
          { type: 'code-block', text: 'const x = 1' },
        ],
        entityMap: [],
      },
    })
    expect(res).not.toBeNull()
    expect(res!.isFull).toBe(true)
    expect(res!.title).toBe('How to Build Local Agents')
    expect(res!.body).toContain('## Architecture')
    expect(res!.body).toContain('- Item A')
    expect(res!.body).toContain('1. Step One')
    expect(res!.body).toContain('> Key insight')
    expect(res!.body).toContain('```\nconst x = 1\n```')

    // Cover image + inline media_entities + stringified content_state
    const withImgs = extractArticleContent({
      title: 'Visual Essay',
      cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/media/cover.jpg' } },
      media_entities: [{ media_id: 'm1', media_info: { original_img_url: 'https://pbs.twimg.com/media/inline1.jpg' } }],
      content_state: JSON.stringify({
        blocks: [
          { type: 'unstyled', text: 'Intro' },
          { type: 'atomic', text: ' ', entityRanges: [{ key: 0 }] },
        ],
        entityMap: [{ key: '0', value: { type: 'MEDIA', data: { caption: 'Diagram', mediaItems: [{ mediaId: 'm1' }] } } }],
      }),
    })
    expect(withImgs?.isFull).toBe(true)
    expect(withImgs?.images.map((m) => m.url)).toEqual([
      'https://pbs.twimg.com/media/cover.jpg',
      'https://pbs.twimg.com/media/inline1.jpg',
    ])
    expect(withImgs?.body).toContain('![Visual Essay](https://pbs.twimg.com/media/cover.jpg)')
    expect(withImgs?.body).toContain('![Diagram](https://pbs.twimg.com/media/inline1.jpg)')
  })

  it('extracts quoted article full body and detects incomplete direct/quoted articles', () => {
    const artTweet = tweet({ id: '2001', text: 'https://x.com/i/article/999' })
    ;(artTweet as any).article = {
      article_results: {
        result: {
          rest_id: '999',
          title: 'Deep Essay',
          preview_text: 'Short preview',
          plain_text: 'Complete full essay body. '.repeat(25),
        },
      },
    }
    const wrapper = tweet({ id: '2002', text: 'Long commentary on this essay...', quoted: artTweet })
    const parsed = tweetToPost(wrapper)
    expect(parsed?.quoted?.article_title).toBe('Deep Essay')
    expect(parsed?.quoted?.article_text).toContain('Complete full essay body.')
    expect(needsQuotedArticleRepair(parsed?.quoted)).toBe(false)

    // Preview-only quoted article should be flagged for repair
    expect(
      needsQuotedArticleRepair({
        tweet_id: '2001',
        screen_name: 'alice',
        name: 'Alice',
        text: 'preview only',
        article_title: 'Deep Essay',
        article_preview: 'Short preview',
      }),
    ).toBe(true)

    // Preview-only direct article should be flagged, full article should not
    expect(needsDirectArticleRepair(makePost({ has_article: 1, text: 'http://x.com/i/article/123 preview' }))).toBe(true)
    expect(
      needsDirectArticleRepair(makePost({ has_article: 1, text: 'Full body '.repeat(80), article_fetched_at: Date.now() })),
    ).toBe(false)
  })

  it('excludes author replies to other commenters from parseThread', () => {
    const conv = '3000'
    const focal = tweet({ id: '3001', text: 'OPUS 5.5 bypassed', user_id: 'u1', conversation_id: conv })
    const selfReply = tweet({ id: '3002', text: 'Self follow-up', user_id: 'u1', conversation_id: conv })
    ;(selfReply.legacy as any).in_reply_to_user_id_str = 'u1'
    const replyToOther = tweet({ id: '3003', text: '@sb_chadi Do you think this is the first time?', user_id: 'u1', conversation_id: conv })
    ;(replyToOther.legacy as any).in_reply_to_user_id_str = 'u999'

    const json = threadResponse(focal, [{ tweet: selfReply }, { tweet: replyToOther, module: true }])
    const thread = parseThread(json, '3001')
    expect(thread.map((t) => t.tweet_id)).toEqual(['3002'])
  })

  it('preserves full repaired article and quoted.article_text on subsequent sync mergePost and includes in exports', () => {
    const existing = makePost({
      tweet_id: '4001',
      has_article: 1,
      text: 'Full repaired direct article body '.repeat(40),
      article_fetched_at: Date.now(),
      quoted: {
        tweet_id: '4000',
        screen_name: 'writer',
        name: 'Writer',
        text: 'short preview',
        article_title: 'Great Essay',
        article_text: 'Complete quoted essay content '.repeat(30),
      },
    })
    const shorterIncoming = {
      ...makePost({
        tweet_id: '4001',
        has_article: 1,
        text: 'short preview',
        quoted: {
          tweet_id: '4000',
          screen_name: 'writer',
          name: 'Writer',
          text: 'short preview',
          article_title: 'Great Essay',
        },
      }),
    }
    const merged = mergePost(existing, shorterIncoming, 'run-next', { source: 'bookmark', account: 'justdoityum' })
    expect(merged.text).toBe(existing.text)
    expect(merged.quoted?.article_text).toBe(existing.quoted?.article_text)

    const md = postToMarkdown(merged)
    expect(md).toContain('Complete quoted essay content')
    const html = postsToSelfContainedHtml([merged])
    expect(html).toContain('Complete quoted essay content')
    const notion = buildNotionPagePayload(merged, 'db-1')
    expect(JSON.stringify(notion)).toContain('Complete quoted essay content')
  })

  it('supports excludeTags (X文章 vs 长推文), year sub-buckets, and multi-DB Notion quote sync', async () => {
    await db.posts.clear()
    invalidateStubCache()
    await db.posts.bulkPut([
      makePost({ tweet_id: '5001', tags: ['长文章', 'X文章'], created_at: new Date('2026-05-01T00:00:00Z').getTime() }),
      makePost({ tweet_id: '5002', tags: ['长文章'], created_at: new Date('2025-06-01T00:00:00Z').getTime() }),
      makePost({ tweet_id: '5003', tags: ['长Quote'], created_at: new Date('2023-03-01T00:00:00Z').getTime() }),
    ])

    // Long Post = tag:长文章 excluding X文章 -> only 5002
    const longPostPage = await pagePostsNoText({
      offset: 0,
      limit: 20,
      filters: { tags: ['长文章'], excludeTags: ['X文章'] },
    })
    expect(longPostPage.posts.map((p) => p.tweet_id)).toEqual(['5002'])

    // Year sub-buckets across all 3 posts
    const years = await countYearsForQuery(parseQuery(''), {})
    expect(years.map((y) => [y.key, y.count])).toEqual([
      ['2026', 1],
      ['2025', 1],
      ['older', 1],
    ])

    // Multi-DB Notion discovery + highlight quote & annotation payload
    const mockListFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { id: 'db-notes', title: [{ plain_text: '随想与笔记库' }] },
            { id: 'db-ai', title: [{ plain_text: 'AI 知识库' }] },
          ],
        }),
        { status: 200 },
      ),
    )
    const dbs = await listNotionDatabases('ntn_token', mockListFetch as unknown as typeof fetch)
    expect(dbs).toEqual([
      { id: 'db-notes', name: '随想与笔记库' },
      { id: 'db-ai', name: 'AI 知识库' },
    ])

    const payload = buildNotionQuotePayload({
      post: makePost({ tweet_id: '5001', article_title: 'Agent Architecture' }),
      databaseId: 'db-ai',
      quoteText: 'Selected key sentence from the article',
      annotation: 'Great pattern to reuse in our extension',
      includeFullPost: true,
    })
    expect((payload.parent as { database_id: string }).database_id).toBe('db-ai')
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain('Selected key sentence from the article')
    expect(serialized).toContain('Great pattern to reuse in our extension')
    expect(serialized).toContain('展开完整推文 / 文章原文')

    const mockPushFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'pg-9', url: 'https://notion.so/pg-9' }), { status: 200 }))
    const pushed = await pushQuoteToNotion(
      {
        token: 'ntn_token',
        databaseId: 'db-ai',
        post: makePost({ tweet_id: '5001' }),
        quoteText: 'Selected text',
        annotation: 'My note',
        includeFullPost: false,
      },
      mockPushFetch as unknown as typeof fetch,
    )
    expect(pushed).toEqual({ pageId: 'pg-9', url: 'https://notion.so/pg-9' })
  })

  it('keeps keyword search exact for short terms like muse, supports abort signal, extracts highlight snippets, and cancels orphaned tasks', async () => {
    await db.posts.clear()
    invalidateStubCache()
    await db.posts.bulkPut([
      makePost({ tweet_id: '6001', text: 'Computer Use in Gemini App Task mode is great' }),
      makePost({ tweet_id: '6002', text: 'Grok bot /muse 每天自动盯优惠源头' }),
      makePost({
        tweet_id: '6003',
        text: 'Long post header '.repeat(15),
        quoted: {
          tweet_id: '6000',
          screen_name: 'writer',
          name: 'Writer',
          text: 'short quote',
          article_title: 'AI Deep Dive',
          article_text: 'Full article explaining Muse workflow in detail.',
        },
      }),
    ])

    const engine = new SearchEngine()
    await buildIndexBatched(engine)
    const res = await searchPage(engine, { query: 'muse', page: 0, pageSize: 20 })
    expect(res.hits.map((h) => h.post.tweet_id).sort()).toEqual(['6002', '6003'])
    expect(res.highlightTerms).toEqual(['muse'])

    // Aborted signal returns immediately without stale hits
    const abortedRes = await searchPage(engine, { query: 'muse', page: 0, pageSize: 20, signal: { aborted: true } })
    expect(abortedRes.hits).toEqual([])

    // Matched snippet extraction when hit is inside quoted article rather than top 140 chars
    const p6003 = (await db.posts.get('6003'))!
    const snip = findMatchedSnippet(p6003, ['muse'])
    expect(snip).not.toBeNull()
    expect(snip!.source).toBe('引用文章')
    expect(snip!.snippet.toLowerCase()).toContain('muse')

    // Orphaned running task in chrome.storage.local is cleanly cancelled by cancelTask() and recoverInterruptedTask()
    const store: Record<string, unknown> = {
      [STORAGE_KEYS.task]: { id: 't1', kind: 'repair', status: 'running', total: 20, done: 12, failed: 0, updated_at: Date.now() },
    }
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        },
      },
    }
    await cancelTask()
    expect((store[STORAGE_KEYS.task] as any).status).toBe('cancelled')

    store[STORAGE_KEYS.task] = { id: 't2', kind: 'repair', status: 'running', total: 20, done: 12, failed: 0, updated_at: Date.now() }
    await recoverInterruptedTask()
    expect((store[STORAGE_KEYS.task] as any).status).toBe('cancelled')
  })
})
