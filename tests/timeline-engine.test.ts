import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { padSortIndex } from '@/api/parser'
import { XApiError } from '@/api/errors'
import { TimelineSyncEngine, type TimelineApi } from '@/background/timeline-engine'
import { db } from '@/db/db'
import { clearAll, upsertParsed } from '@/db/posts'
import { DEFAULT_SETTINGS, timelineFolder, type Settings, type SyncProgress } from '@/shared/types'
import { bookmarksPage, cursorEntry, tweet, tweetEntry } from './fixtures/builders'

function userTweetsPage(entries: any[]) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
          },
        },
      },
    },
  }
}

function userByScreenName(id: string, screen: string) {
  return { data: { user: { result: { rest_id: id, legacy: { screen_name: screen } } } } }
}

function fakeTimeline(pages: string[][], screen = 'alice', userId = '111') {
  const calls: (string | undefined)[] = []
  let sort = 100000
  const api: TimelineApi = {
    async getUserByScreenName(s) {
      return userByScreenName(userId, s || screen)
    },
    async getUserTweets(_id, cursor) {
      calls.push(cursor)
      const key = cursor ?? 'c0'
      const idx = Number(key.slice(1))
      const ids = pages[idx] ?? []
      const entries: any[] = ids.map((id) => tweetEntry(tweet({ id, text: `tl ${id}`, screen_name: screen, user_id: userId }), String(sort--)))
      if (idx + 1 < pages.length) entries.push(cursorEntry(`c${idx + 1}`))
      else entries.push(cursorEntry('c_end'))
      return userTweetsPage(entries)
    },
    async getAccountSettings() {
      return { screen_name: screen }
    },
  }
  return { api, calls }
}

function mkEngine(api: TimelineApi, settings: Partial<Settings> = {}, extra: { progress?: { v?: SyncProgress }; sleeps?: number[] } = {}) {
  const store = extra.progress ?? {}
  const history: SyncProgress[] = []
  const engine = new TimelineSyncEngine({
    api,
    getSettings: async () => ({ ...DEFAULT_SETTINGS, delayMinSec: 0, delayMaxSec: 0, ...settings }),
    loadProgress: async () => store.v,
    saveProgress: async (p) => {
      store.v = p
      history.push(p)
    },
    sleep: async (ms) => {
      extra.sleeps?.push(ms)
    },
    random: () => 0,
  })
  return { engine, store, history }
}

beforeEach(async () => {
  await clearAll()
})

describe('TimelineSyncEngine', () => {
  it('syncs all UserTweets pages into timeline:@handle folder with source=timeline', async () => {
    const { api, calls } = fakeTimeline([['10', '9'], ['8'], []])
    const { engine, store } = mkEngine(api)
    const p = await engine.start('@Alice')
    expect(p.status).toBe('done')
    expect(calls[0]).toBeUndefined()
    expect(await db.posts.count()).toBe(3)
    const folder = timelineFolder('Alice')
    for (const post of await db.posts.toArray()) {
      expect(post.source).toBe('timeline')
      expect(post.folder).toBe(folder)
    }
    expect(await db.folders.get(folder)).toBeTruthy()
    expect(store.v).toMatchObject({ status: 'done', kind: 'timeline', fetched: 3, added: 3 })
  })

  it('startSelf resolves screen_name then syncs', async () => {
    const { api } = fakeTimeline([['1', '2']], 'me', '999')
    const { engine } = mkEngine(api)
    const p = await engine.startSelf()
    expect(p.status).toBe('done')
    expect(p.handle).toBe('me')
    expect(await db.posts.count()).toBe(2)
    expect((await db.posts.toArray())[0].folder).toBe(timelineFolder('me'))
  })

  it('does not downgrade an existing bookmark to timeline', async () => {
    const page = bookmarksPage([tweetEntry(tweet({ id: '10', text: 'bookmarked' }), '9000')])
    const { parseTimelinePage } = await import('@/api/parser')
    const parsed = parseTimelinePage(page).entries.map((e) => (e as any).post)
    await upsertParsed(parsed, 'b1', { source: 'bookmark', folder: 'Fav' })
    const { api } = fakeTimeline([['10', '9']], 'alice')
    const p = await mkEngine(api).engine.start('alice')
    expect(p.status).toBe('done')
    const kept = (await db.posts.get('10'))!
    expect(kept.source).toBe('bookmark')
    expect(kept.folder).toBe('Fav')
    expect((await db.posts.get('9'))!.source).toBe('timeline')
  })

  it('rate-limit waits then continues', async () => {
    let failOnce = true
    const base = fakeTimeline([['1'], ['2']])
    const api: TimelineApi = {
      ...base.api,
      async getUserTweets(id, cursor, count) {
        if (failOnce && !cursor) {
          failOnce = false
          throw new XApiError('rate_limit', '429', { resetAt: now + 60_000 })
        }
        return base.api.getUserTweets(id, cursor, count)
      },
    }
    let now = Date.now()
    const sleeps: number[] = []
    const store: { v?: SyncProgress } = {}
    const engine = new TimelineSyncEngine({
      api,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, delayMinSec: 0, delayMaxSec: 0 }),
      loadProgress: async () => store.v,
      saveProgress: async (p) => void (store.v = p),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
      random: () => 0,
    })
    const p = await engine.start('alice')
    expect(p.status).toBe('done')
    expect(await db.posts.count()).toBe(2)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000)
    expect(store.v?.kind).toBe('timeline')
  })

  it('rejects bad handle', async () => {
    const { engine, store } = mkEngine(fakeTimeline([[]]).api)
    const p = await engine.start('!!!')
    expect(p.status).toBe('error')
    expect(store.v?.error_code).toBe('data')
  })
})

describe('padSortIndex smoke', () => {
  it('pads', () => expect(padSortIndex('12')).toHaveLength(24))
})
