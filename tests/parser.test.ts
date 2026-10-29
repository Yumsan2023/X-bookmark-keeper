import { describe, expect, it } from 'vitest'
import { padSortIndex, parseFolders, parseThread, parseTimelinePage, snowflakeToMs, tweetToPost, unwrapTweetResult } from '@/api/parser'
import { bookmarksPage, cursorEntry, folderTimelinePage, foldersResponse, threadResponse, tweet, tweetEntry } from './fixtures/builders'

describe('parseTimelinePage', () => {
  it('parses text, urls, photos, metrics and bottom cursor', () => {
    const t = tweet({
      id: '1800000000000000001',
      text: 'Check this &amp; that',
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/article' }],
      photos: ['https://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com/media/B.jpg'],
      views: '98765',
      likes: 42,
    })
    const page = parseTimelinePage(
      bookmarksPage([tweetEntry(t, '1900000000000000100'), cursorEntry('TOP_CURSOR', 'Top'), cursorEntry('NEXT_PAGE_CURSOR')]),
    )
    expect(page.recognized).toBe(true)
    expect(page.cursor).toBe('NEXT_PAGE_CURSOR')
    expect(page.entries).toHaveLength(1)
    const e = page.entries[0]
    expect(e.kind).toBe('tweet')
    if (e.kind !== 'tweet') return
    const p = e.post
    expect(p.tweet_id).toBe('1800000000000000001')
    expect(p.screen_name).toBe('alice')
    expect(p.name).toBe('Alice')
    // t.co 展开, 媒体短链移除, HTML 实体解码
    expect(p.text).toBe('Check this & that https://example.com/article')
    expect(p.urls).toEqual(['https://example.com/article'])
    expect(p.media).toHaveLength(2)
    expect(p.media[0]).toMatchObject({ type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg', width: 800, alt: 'alt text' })
    expect(p.has_image).toBe(1)
    expect(p.has_video).toBe(0)
    expect(p.has_link).toBe(1)
    expect(p.has_quote).toBe(0)
    expect(p.metrics).toEqual({ replies: 1, retweets: 2, likes: 42, quotes: 4, bookmarks: 5, views: 98765 })
    expect(p.created_at).toBe(Date.parse('Wed Oct 10 20:19:24 +0000 2018'))
    expect(p.sort_index).toBe(padSortIndex('1900000000000000100'))
    expect(p.sort_index).toHaveLength(24)
    expect(p.url).toBe('https://x.com/alice/status/1800000000000000001')
  })

  it('picks the highest bitrate mp4 for videos and unwraps TweetWithVisibilityResults', () => {
    const t = tweet({
      id: '2',
      video: {
        thumb: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg',
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' },
          { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/low.mp4' },
          { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/high.mp4' },
        ],
      },
    })
    const page = parseTimelinePage(bookmarksPage([tweetEntry(t, '10', true)]))
    const e = page.entries[0]
    expect(e.kind === 'tweet' && e.post.media[0]).toMatchObject({ type: 'video', video_url: 'https://video.twimg.com/high.mp4', duration_ms: 12000 })
    expect(e.kind === 'tweet' && e.post.has_video).toBe(1)
  })

  it('prefers long-form note_tweet text and supports the new user shape', () => {
    const t = tweet({
      id: '3',
      text: 'short…',
      note: 'This is a very long post body '.repeat(5) + 'https://t.co/long',
      urls: [{ url: 'https://t.co/long', expanded_url: 'https://long.example/x' }],
      newUserShape: true,
      screen_name: 'bob_new',
      name: 'Bob',
    })
    const e = parseTimelinePage(bookmarksPage([tweetEntry(t, '1')])).entries[0]
    expect(e.kind).toBe('tweet')
    if (e.kind !== 'tweet') return
    expect(e.post.text.startsWith('This is a very long post body')).toBe(true)
    expect(e.post.text.endsWith('https://long.example/x')).toBe(true)
    expect(e.post.screen_name).toBe('bob_new')
    expect(e.post.avatar).toContain('new.jpg')
  })

  it('sets has_article when tweet.article node is present', () => {
    const t = tweet({ id: '90', text: 'check article' })
    ;(t as any).article = {
      article_results: { result: { title: 'My Article', preview_text: 'preview', rest_id: 'art1' } },
    }
    const e = parseTimelinePage(bookmarksPage([tweetEntry(t, '1')])).entries[0]
    expect(e.kind).toBe('tweet')
    if (e.kind !== 'tweet') return
    expect(e.post.has_article).toBe(1)
    expect(e.post.text).toContain('My Article')
  })


  it('parses quoted tweets', () => {
    const q = tweet({ id: '5', text: 'original', screen_name: 'carol', name: 'Carol' })
    const t = tweet({ id: '4', text: 'quoting', quoted: q })
    const e = parseTimelinePage(bookmarksPage([tweetEntry(t, '1')])).entries[0]
    if (e.kind !== 'tweet') throw new Error('expected tweet')
    expect(e.post.has_quote).toBe(1)
    expect(e.post.quoted).toMatchObject({ tweet_id: '5', screen_name: 'carol', text: 'original' })
  })

  it('reports deleted tweets (tombstone / empty result) as placeholders and skips promoted', () => {
    const tomb = {
      entryId: 'tweet-777',
      sortIndex: '77',
      content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: 'TweetTombstone', tombstone: { text: { text: 'deleted' } } } } } },
    }
    const empty = {
      entryId: 'tweet-778',
      sortIndex: '78',
      content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: {} } },
    }
    const promoted = tweetEntry(tweet({ id: '9' }), '9')
    ;(promoted.content.itemContent as any).promotedMetadata = { advertiser_results: {} }
    const page = parseTimelinePage(bookmarksPage([tomb, empty, promoted, tweetEntry(tweet({ id: '10' }), '10')]))
    expect(page.entries.map((e) => [e.kind, e.kind === 'deleted' ? e.tweet_id : e.post.tweet_id])).toEqual([
      ['deleted', '777'],
      ['deleted', '778'],
      ['tweet', '10'],
    ])
  })

  it('flags unrecognized structures', () => {
    expect(parseTimelinePage({ data: {} }).recognized).toBe(false)
    expect(parseTimelinePage({}).entries).toEqual([])
  })

  it('falls back to deep search for instructions and to snowflake time', () => {
    const t = tweet({ id: '1800000000000000001' })
    ;(t.legacy as any).created_at = undefined
    const json = { data: { weird: { nested: { instructions: [{ type: 'TimelineAddEntries', entries: [tweetEntry(t, '5')] }] } } } }
    const page = parseTimelinePage(json)
    const e = page.entries[0]
    expect(e.kind === 'tweet' && e.post.created_at).toBe(snowflakeToMs('1800000000000000001'))
  })

  it('parses folder timeline responses the same way', () => {
    const page = parseTimelinePage(folderTimelinePage([tweetEntry(tweet({ id: '8' }), '8'), cursorEntry('C2')]))
    expect(page.entries).toHaveLength(1)
    expect(page.cursor).toBe('C2')
  })
})

describe('helpers', () => {
  it('padSortIndex pads and strips non digits', () => {
    expect(padSortIndex('123')).toBe('000000000000000000000123')
    expect(padSortIndex(undefined)).toBe('0'.repeat(24))
  })
  it('unwrapTweetResult rejects tombstones', () => {
    expect(unwrapTweetResult({ __typename: 'TweetTombstone' })).toBeNull()
    expect(unwrapTweetResult(undefined)).toBeNull()
  })
  it('tweetToPost returns null without legacy', () => {
    expect(tweetToPost({ rest_id: '1' })).toBeNull()
  })
})

describe('parseFolders', () => {
  it('reads bookmark_collections_slice items', () => {
    const r = parseFolders(foldersResponse([{ id: '11', name: 'AI' }, { id: '12', name: '工具' }]))
    expect(r.folders).toEqual([{ id: '11', name: 'AI' }, { id: '12', name: '工具' }])
  })
  it('returns empty for unknown shape', () => {
    expect(parseFolders({ data: {} }).folders).toEqual([])
  })
})

describe('parseThread', () => {
  it('collects same-author same-conversation tweets in time order, excluding focal and others', () => {
    const conv = '1000'
    const focal = tweet({ id: '1001', text: '1/', user_id: 'u1', conversation_id: conv, created_at: 'Wed Oct 10 20:19:24 +0000 2018' })
    const t2 = tweet({ id: '1003', text: '3/', user_id: 'u1', conversation_id: conv, created_at: 'Wed Oct 10 20:21:24 +0000 2018' })
    const t1 = tweet({ id: '1002', text: '2/', user_id: 'u1', conversation_id: conv, created_at: 'Wed Oct 10 20:20:24 +0000 2018' })
    const reply = tweet({ id: '1004', text: 'someone else', user_id: 'u2', conversation_id: conv })
    const otherConv = tweet({ id: '1005', text: 'unrelated', user_id: 'u1', conversation_id: '999' })
    const json = threadResponse(focal, [{ tweet: t2, module: true }, { tweet: t1 }, { tweet: reply, module: true }, { tweet: otherConv }])
    const thread = parseThread(json, '1001')
    expect(thread.map((t) => t.text)).toEqual(['2/', '3/'])
  })
  it('returns [] when focal tweet missing', () => {
    expect(parseThread(threadResponse(tweet({ id: '1' }), []), '999')).toEqual([])
  })
})
