import { XClient } from '@/api/client'
import { OPERATIONS } from '@/api/endpoints'
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
  },
  getSettings,
  loadProgress: getProgress,
  saveProgress,
  onDbChanged: bumpDbVersion,
  onFullSyncDone: (meta) => saveLastFullSync(meta),
  scheduleWake: (at) => chrome.alarms.create('bk-resume', { when: at }),
})

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

export async function startSync(mode: 'incremental' | 'full' | 'resume') {
  if (engine.isRunning) return
  if (timelineEngine.isRunning) throw new Error('时间线同步进行中, 请先完成或取消后再同步书签')
  startKeepAlive()
  void engine.start(mode).finally(stopKeepAlive)
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
        await startSync(msg.mode)
        return { ok: true }
      case 'sync/pause':
        engine.pause()
        return { ok: true }
      case 'sync/resume':
        if (engine.isRunning) engine.resume()
        else await startSync('resume')
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
        void deleteBookmarks(client, msg.tweetIds, msg.removeLocal)
        return { ok: true }
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
