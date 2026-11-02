import { XClient } from '@/api/client'
import { OPERATIONS } from '@/api/endpoints'
import { canonicalScreenName, screenNameFromAccountLabel, screenNameFromProfileHref } from '@/shared/accounts'
import { getAuth, getProgress, getSettings, getTimelineProgress, saveProgress, saveTimelineProgress, bumpDbVersion, saveLastFullSync } from '@/shared/storage'
import { STORAGE_KEYS, type BgRequest, type BgResponse } from '@/shared/types'
import { cancelTask, deleteBookmarks, fetchThreads, pushFolder } from './actions'
import { getAllQueryIds, getQueryId, refreshQueryIds } from './queryids'
import { SyncEngine } from './sync-engine'
import { TimelineSyncEngine } from './timeline-engine'

export const client = new XClient({
  getAuth: async () => (await getAuth()) ?? null,
  getQueryId,
  refreshQueryIds,
  onRateLimit: (op, info) => {
    void chrome.storage.local.get(STORAGE_KEYS.rate).then((r) => chrome.storage.local.set({ [STORAGE_KEYS.rate]: { ...(r[STORAGE_KEYS.rate] ?? {}), [op]: info } }))
  },
})

export const engine = new SyncEngine({
  api: {
    getBookmarks: (c, n) => client.getBookmarks(c, n),
    getFolders: (c) => client.getFolders(c),
    getFolderTimeline: (id, c) => client.getFolderTimeline(id, c),
    getTweetDetail: (id) => client.getTweetDetail(id),
    getAccount: () => resolveCurrentAccount(),
  },
  getSettings,
  loadProgress: getProgress,
  saveProgress,
  onDbChanged: bumpDbVersion,
  onFullSyncDone: (meta) => saveLastFullSync(meta),
  scheduleWake: (at) => chrome.alarms.create('bk-resume', { when: at }),
  knownAccounts: listKnownBookmarkAccounts,
})

type StoredAccounts = Record<string, { user_id?: string; last_seen_at?: number }>

async function readStoredAccounts(): Promise<StoredAccounts> {
  return ((await chrome.storage.local.get(STORAGE_KEYS.accounts))[STORAGE_KEYS.accounts] ?? {}) as StoredAccounts
}

export async function listKnownBookmarkAccounts(): Promise<string[]> {
  return Object.keys(await readStoredAccounts())
}

/** Remember a bookmark owner. Does not touch the strike ledger. */
export async function rememberBookmarkAccount(screenName: string, userId?: string): Promise<void> {
  const name = canonicalScreenName(screenName)
  if (!name) return
  const stored = await readStoredAccounts()
  const prev = stored[name] ?? {}
  stored[name] = { user_id: userId || prev.user_id, last_seen_at: Date.now() }
  await chrome.storage.local.set({
    [STORAGE_KEYS.accounts]: stored,
    [STORAGE_KEYS.stampAccount]: name,
  })
}

/**
 * Screen name of the logged-in X account.
 * REST settings (then verify_credentials) first; if that fails, the open x.com tab's profile link.
 * user_id is attached only when the name came from the signed-in API, so a stale captured session
 * is not glued onto a different tab account.
 */
export async function resolveCurrentAccount(): Promise<{ screen_name: string; user_id?: string }> {
  let screen = ''
  let userId: string | undefined
  try {
    screen = canonicalScreenName((await client.getAccountSettings()).screen_name)
    if (screen) userId = (await getAuth())?.user_id
  } catch {
    screen = ''
  }
  if (!screen) screen = await screenNameFromOpenTabs()
  if (!screen) throw new Error('无法确认当前登录的 X 账号')
  await rememberBookmarkAccount(screen, userId)
  return { screen_name: screen, user_id: userId }
}

async function screenNameFromOpenTabs(): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.tabs?.sendMessage) return ''
  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.x.com/*', 'https://mobile.twitter.com/*'],
    })
  } catch {
    return ''
  }
  const ordered = [...tabs].sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
  for (const tab of ordered) {
    if (tab.id == null) continue
    try {
      const res = (await chrome.tabs.sendMessage(tab.id, { type: 'BOOKMARK_ACCOUNT' })) as { screen_name?: string } | undefined
      const name = canonicalScreenName(res?.screen_name) || screenNameFromProfileHref(res?.screen_name) || screenNameFromAccountLabel(res?.screen_name)
      if (name) return name
    } catch {
      /* this tab has no content script yet */
    }
  }
  return ''
}

export const timelineEngine = new TimelineSyncEngine({
  api: {
    getUserByScreenName: (s) => client.getUserByScreenName(s),
    getUserTweets: (id, c, n) => client.getUserTweets(id, c, n),
    getAccountSettings: () => client.getAccountSettings(),
  },
  getSettings,
  loadProgress: getTimelineProgress,
  saveProgress: saveTimelineProgress,
  onDbChanged: bumpDbVersion,
  scheduleWake: (at) => chrome.alarms.create('bk-timeline-resume', { when: at }),
})

// service worker 保活: 同步期间定期访问 storage
let keepAlive: ReturnType<typeof setInterval> | undefined
function startKeepAlive() {
  stopKeepAlive()
  keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
}
function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive)
  keepAlive = undefined
}

export async function startSync(mode: 'incremental' | 'full' | 'resume', account?: string) {
  if (engine.isRunning) return
  if (timelineEngine.isRunning) throw new Error('时间线同步进行中, 请先完成或取消后再同步书签')
  const name = canonicalScreenName(account)
  if (name) await rememberBookmarkAccount(name)
  startKeepAlive()
  void engine.start(mode, name ? { account: name } : undefined).finally(stopKeepAlive)
}

export async function startTimeline(handle: string) {
  if (timelineEngine.isRunning) return
  if (engine.isRunning) throw new Error('书签同步进行中, 请先完成或取消后再同步发帖')
  startKeepAlive()
  void timelineEngine.start(handle).finally(stopKeepAlive)
}

export async function startTimelineSelf() {
  if (timelineEngine.isRunning) return
  if (engine.isRunning) throw new Error('书签同步进行中, 请先完成或取消后再同步发帖')
  startKeepAlive()
  void timelineEngine.startSelf().finally(stopKeepAlive)
}

/** service worker 重启后: 上次未结束的同步标记为暂停, 允许用户断点续传 */
export async function recoverInterrupted() {
  const p = await getProgress()
  if (p && (p.status === 'running' || p.status === 'waiting') && !engine.isRunning) {
    await saveProgress({ ...p, status: 'paused', message: '后台被浏览器回收, 点击"继续"从断点恢复', updated_at: Date.now() })
  }
  const tp = await getTimelineProgress()
  if (tp && (tp.status === 'running' || tp.status === 'waiting') && !timelineEngine.isRunning) {
    await saveTimelineProgress({ ...tp, status: 'paused', message: '后台被浏览器回收, 点击"继续"从断点恢复', updated_at: Date.now() })
  }
}

export async function handleMessage(msg: BgRequest): Promise<BgResponse> {
  try {
    switch (msg.type) {
      case 'sync/start':
        await startSync(msg.mode, msg.account)
        return { ok: true }
      case 'sync/pause':
        engine.pause()
        return { ok: true }
      case 'sync/resume':
        if (engine.isRunning) engine.resume()
        else await startSync('resume', msg.account)
        return { ok: true }
      case 'sync/cancel':
        if (engine.isRunning) engine.cancel()
        else {
          const p = await getProgress()
          if (p) await saveProgress({ ...p, status: 'cancelled', message: '已取消', updated_at: Date.now() })
        }
        cancelTask()
        return { ok: true }
      case 'sync/status':
        return { ok: true, data: { progress: await getProgress(), running: engine.isRunning } }
      case 'timeline/start':
        await startTimeline(msg.handle)
        return { ok: true }
      case 'timeline/startSelf':
        await startTimelineSelf()
        return { ok: true }
      case 'timeline/pause':
        timelineEngine.pause()
        return { ok: true }
      case 'timeline/resume':
        if (timelineEngine.isRunning) timelineEngine.resume()
        else {
          const tp = await getTimelineProgress()
          if (tp?.handle) await startTimeline(tp.handle)
        }
        return { ok: true }
      case 'timeline/cancel':
        if (timelineEngine.isRunning) timelineEngine.cancel()
        else {
          const tp = await getTimelineProgress()
          if (tp) await saveTimelineProgress({ ...tp, status: 'cancelled', message: '已取消', updated_at: Date.now() })
        }
        return { ok: true }
      case 'timeline/status':
        return { ok: true, data: { progress: await getTimelineProgress(), running: timelineEngine.isRunning } }
      case 'auth/status': {
        const a = await getAuth()
        return { ok: true, data: { hasAuth: !!(a?.token && a.csrf), capturedAt: a?.captured_at } }
      }
      case 'queryids/get':
        return { ok: true, data: await getAllQueryIds() }
      case 'queryids/refresh': {
        const changed = await refreshQueryIds()
        return { ok: true, data: { changed, ids: await getAllQueryIds(), ops: OPERATIONS } }
      }
      case 'bookmarks/delete':
        return { ok: true, data: await deleteBookmarks(client, msg.tweetIds, msg.removeLocal) }
      case 'account/current':
        return { ok: true, data: await resolveCurrentAccount() }
      case 'folder/push':
        void pushFolder(client, msg.tweetIds, msg.folder)
        return { ok: true }
      case 'threads/fetch':
        void fetchThreads(client, msg.tweetIds)
        return { ok: true }
      case 'ui/openLibrary':
        await chrome.runtime.openOptionsPage()
        return { ok: true }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
