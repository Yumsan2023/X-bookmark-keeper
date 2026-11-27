import { XClient } from '@/api/client'
import { OPERATIONS } from '@/api/endpoints'
import { canonicalScreenName, screenNameFromAccountLabel, screenNameFromProfileHref } from '@/shared/accounts'
import { getAuth, getProgress, getSettings, getTimelineProgress, saveProgress, saveTimelineProgress, bumpDbVersion, saveLastFullSync } from '@/shared/storage'
import { STORAGE_KEYS, type BgRequest, type BgResponse } from '@/shared/types'
import { autoRepairNewArticles, bookmarkTweets, cancelTask, deleteBookmarks, fetchThreads, pushBookmarksToNotion, pushFolder, recoverInterruptedTask, repairIncompletePosts, repairSinglePost, runCleanupQueue } from './actions'
import { decideAutoSync, markAutoSyncRan, readAutoSyncLastMap } from './auto-sync'
import { canForYouBookmarkMoreToday, dispatch as dispatchStrike, getForYouRunBatch, noteForYouBookmarkResult, noteForYouRateLimited } from '@/strike/lib/store.js'
import type { ForYouBookmarkItem, ForYouDestination, ForYouValidationRow } from '@/foryou/types'
import { buildProfileJob, readForYouProfile, readForYouSettings, readLastForYouValidation, validateJob, type ForYouProfileProgress } from '@/foryou/runner'
import { listNotionDatabases, pushQuoteToNotion } from '@/export/notion'
import { db } from '@/db/db'
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
  void engine
    .start(mode, name ? { account: name } : undefined)
    .then(async (prog) => {
      const settings = await getSettings()
      if (settings.autoRepairArticles && prog.status === 'done' && prog.added > 0) {
        await autoRepairNewArticles(client, prog.run_id, 10)
      }
    })
    .finally(stopKeepAlive)
}

/**
 * v2 打开 x.com 自动识别登录账号并静默增量扫描：
 * 免手动选账号、免手动点同步；按账号冷却节流防风控；
 * 同步到新书签后在扩展图标短暂显示 +N 徽标，并按设置自动补全残缺 X 文章全文。
 */
export async function handleAutoSyncTrigger(hintScreenName?: string): Promise<{
  triggered: boolean
  reason: string
  account?: string
}> {
  const settings = await getSettings()
  const auth = await getAuth()
  const hasAuth = !!(auth?.token && auth.csrf)
  let account = canonicalScreenName(hintScreenName)
  if (!account && hasAuth) {
    try {
      account = (await resolveCurrentAccount()).screen_name
    } catch {
      account = ''
    }
  }
  const lastMap = await readAutoSyncLastMap()
  const decision = decideAutoSync({
    settings,
    hasAuth,
    busy: engine.isRunning || timelineEngine.isRunning,
    account,
    lastMap,
  })
  if (!decision.run || !decision.account) {
    return { triggered: false, reason: decision.reason, account: decision.account }
  }
  await rememberBookmarkAccount(decision.account, auth?.user_id)
  await markAutoSyncRan(decision.account)
  startKeepAlive()
  void engine
    .start('incremental', { account: decision.account })
    .then(async (prog) => {
      if (prog.added > 0 && typeof chrome !== 'undefined' && chrome.action?.setBadgeText) {
        void chrome.action.setBadgeBackgroundColor?.({ color: '#10b981' })
        void chrome.action.setBadgeText({ text: `+${Math.min(prog.added, 99)}` })
        setTimeout(() => void chrome.action.setBadgeText({ text: '' }), 15_000)
      }
      if (settings.autoRepairArticles && prog.status === 'done' && prog.added > 0) {
        await autoRepairNewArticles(client, prog.run_id, 10)
      }
    })
    .finally(stopKeepAlive)
  return { triggered: true, reason: 'ok', account: decision.account }
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

/**
 * For You 自动收藏的执行器（M2）：由 store.js 的 FORYOU_BOOKMARK 入队后
 * 在锁外触发。从 xsl 读当前待执行队列 + 去向 / 间隔，交给
 * bookmarkTweets(client, …) 按 runTask('foryou-bookmark') 执行；
 * 每条成功 / 失败、每次 429 都回调回 store.js 记账（出队、计当日数、
 * 连续 2 次 429 当天停）。队列已在入队时按 dailyCap 钳过，这里只跑
 * 已入队的条目。runTask 已有任务在跑时直接抛错，由调用方忽略
 * （队列持久化在 xsl，下次 FORYOU_BOOKMARK 触发时再跑）。
 */
export async function runForYouBookmarkQueue() {
  // store.js 是 JS（无类型）：这里显式标注它返回的批次形状。
  const batch = (await getForYouRunBatch()) as unknown as {
    items: ForYouBookmarkItem[]
    destination: ForYouDestination
    minGapMs: number
  } | null
  if (!batch || !batch.items.length) return null
  const settings = await getSettings()
  return bookmarkTweets(client, batch.items, {
    destination: batch.destination,
    minGapMs: batch.minGapMs,
    pushFolderMoveToX: settings.pushFolderMoveToX,
    beforeEachBookmark: async () => Boolean(await canForYouBookmarkMoreToday()),
    onBookmarked: (item) => noteForYouBookmarkResult(item.tweetId, true),
    onFailed: (item) => noteForYouBookmarkResult(item.tweetId, false),
    onRateLimited: (strikes) => noteForYouRateLimited(strikes),
  })
}

/**
 * For You 画像构建 Job（M3，设计 §7.3）：设置页点「重建画像」触发。
 * 长 Job 在后台跑，调用方只拿 ok + running 就返回，进度轮询
 * 'foryou/status'（读 bk_foryou_progress）。同一时间只跑一个；
 * service worker 被回收时 Job 会中断，进度停在 running，调用方
 * 可重新点「重建画像」（幂等：重建会覆盖旧画像行）。
 */
let foryouProfileController: AbortController | null = null
let foryouProfileRunning = false

async function readForYouProgress(): Promise<ForYouProfileProgress | null> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.foryouProgress)
    return (got[STORAGE_KEYS.foryouProgress] as ForYouProfileProgress | undefined) ?? null
  } catch {
    return null
  }
}

export async function startForYouProfileBuild(): Promise<{ running: boolean }> {
  if (foryouProfileRunning) return { running: true }
  const settings = await readForYouSettings()
  const controller = new AbortController()
  foryouProfileController = controller
  foryouProfileRunning = true
  startKeepAlive()
  void buildProfileJob({
    embed: settings.embed,
    halfLifeDays: settings.profileHalfLifeDays,
    signal: controller.signal,
  })
    .catch(async (e) => {
      const progress: ForYouProfileProgress = {
        job: 'profile',
        status: controller.signal.aborted ? 'cancelled' : 'error',
        done: 0,
        total: 0,
        message: (e as Error).message,
        updated_at: Date.now(),
      }
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.foryouProgress]: progress })
      } catch {
        /* ignore */
      }
    })
    .finally(() => {
      foryouProfileRunning = false
      if (foryouProfileController === controller) foryouProfileController = null
      stopKeepAlive()
    })
  return { running: true }
}

export function cancelForYouProfileBuild(): { cancelled: boolean } {
  if (!foryouProfileRunning || !foryouProfileController) return { cancelled: false }
  foryouProfileController.abort()
  return { cancelled: true }
}

export async function getForYouStatus(): Promise<{
  running: boolean
  progress: ForYouProfileProgress | null
  profile: { builtAt: number; sampleSize: number; model: string; endpoint: string; dim: number; holdout: number } | null
  lastValidation: ForYouValidationRow | null
}> {
  const profile = await readForYouProfile()
  return {
    running: foryouProfileRunning || foryouValidateRunning,
    progress: await readForYouProgress(),
    profile: profile
      ? {
          builtAt: profile.builtAt,
          sampleSize: profile.sampleSize,
          model: profile.model,
          endpoint: profile.endpoint,
          dim: profile.dim,
          holdout: profile.holdoutIds.length,
        }
      : null,
    lastValidation: (await readLastForYouValidation()) ?? null,
  }
}

/**
 * For You 离线验证 Job（M4，设计 §7.3）：面板点「离线验证」触发。
 * 与画像构建同款编排：长 Job 在后台跑，调用方只拿 ok + running 就返回，
 * 进度轮询 'foryou/status'（读 bk_foryou_progress）。同一时间只跑一个；
 * 画像构建和验证互斥（共用 foryouProgress 一个 key，串行跑才不会互相覆盖进度）。
 */
let foryouValidateController: AbortController | null = null
let foryouValidateRunning = false

export async function startForYouValidate(): Promise<{ running: boolean; error?: string }> {
  if (foryouValidateRunning) return { running: true }
  if (foryouProfileRunning) return { running: false, error: '画像构建进行中，请等它结束再验证' }
  const controller = new AbortController()
  foryouValidateController = controller
  foryouValidateRunning = true
  startKeepAlive()
  void validateJob({ signal: controller.signal })
    .catch(async (e) => {
      const progress: ForYouProfileProgress = {
        job: 'validate',
        status: controller.signal.aborted ? 'cancelled' : 'error',
        done: 0,
        total: 0,
        message: (e as Error).message,
        updated_at: Date.now(),
      }
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.foryouProgress]: progress })
      } catch {
        /* ignore */
      }
    })
    .finally(() => {
      foryouValidateRunning = false
      if (foryouValidateController === controller) foryouValidateController = null
      stopKeepAlive()
    })
  return { running: true }
}

export function cancelForYouValidate(): { cancelled: boolean } {
  if (!foryouValidateRunning || !foryouValidateController) return { cancelled: false }
  foryouValidateController.abort()
  return { cancelled: true }
}

/** 决策日志面板读最近 100 条决策（倒序）；统计行在面板里由这 100 条算。 */
export async function getForYouDecisions() {
  return db.foryouDecisions.orderBy('at').reverse().limit(100).toArray()
}

/** service worker 重启后: 上次未结束的同步标记为暂停, 残留后台任务标为已中止 */
export async function recoverInterrupted() {
  const p = await getProgress()
  if (p && (p.status === 'running' || p.status === 'waiting') && !engine.isRunning) {
    await saveProgress({ ...p, status: 'paused', message: '后台被浏览器回收, 点击"继续"从断点恢复', updated_at: Date.now() })
  }
  const tp = await getTimelineProgress()
  if (tp && (tp.status === 'running' || tp.status === 'waiting') && !timelineEngine.isRunning) {
    await saveTimelineProgress({ ...tp, status: 'paused', message: '后台被浏览器回收, 点击"继续"从断点恢复', updated_at: Date.now() })
  }
  await recoverInterruptedTask()
}

export async function handleMessage(msg: BgRequest): Promise<BgResponse> {
  try {
    switch (msg.type) {
      case 'sync/start':
        await startSync(msg.mode, msg.account)
        return { ok: true }
      case 'sync/autoTrigger':
        return { ok: true, data: await handleAutoSyncTrigger(msg.screenName) }
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
          if (p && (p.status === 'running' || p.status === 'waiting')) {
            await saveProgress({ ...p, status: 'cancelled', message: '已取消', updated_at: Date.now() })
          }
        }
        await cancelTask()
        stopKeepAlive()
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
      case 'cleanup/run':
        return { ok: true, data: await runCleanupQueue(client, { limit: msg.limit, removeLocal: msg.removeLocal }) }
      case 'repair/incomplete':
        startKeepAlive()
        void repairIncompletePosts(client, msg.tweetIds).catch(() => {}).finally(stopKeepAlive)
        return { ok: true }
      case 'repair/single':
        return { ok: true, data: await repairSinglePost(client, msg.tweetId, { force: true }) }
      case 'notion/push':
        startKeepAlive()
        void pushBookmarksToNotion(msg.tweetIds).catch(() => {}).finally(stopKeepAlive)
        return { ok: true }
      case 'notion/listDatabases': {
        const s = await getSettings()
        const token = (msg.token ?? s.notionToken ?? '').trim()
        const dbs = await listNotionDatabases(token)
        return { ok: true, data: dbs }
      }
      case 'notion/pushQuote': {
        const s = await getSettings()
        const post = await db.posts.get(msg.tweetId)
        if (!post) return { ok: false, error: '未找到该条书签' }
        const pushed = await pushQuoteToNotion({
          token: s.notionToken,
          databaseId: msg.databaseId || s.notionDatabaseId,
          post,
          quoteText: msg.quoteText,
          annotation: msg.annotation,
          includeFullPost: msg.includeFullPost,
        })
        let updatedPost = post
        if (msg.saveLocalNote) {
          const stamp = new Date().toISOString().slice(0, 10)
          const snippet = [
            `[${stamp}]`,
            msg.quoteText.trim() ? `> ${msg.quoteText.trim().slice(0, 300)}` : '',
            msg.annotation.trim(),
          ]
            .filter(Boolean)
            .join('\n')
          const nextNote = post.note?.trim() ? `${post.note.trim()}\n\n${snippet}` : snippet
          await db.posts.update(post.tweet_id, { note: nextNote })
          updatedPost = (await db.posts.get(post.tweet_id)) ?? { ...post, note: nextNote }
          await bumpDbVersion()
        }
        return { ok: true, data: { ...pushed, post: updatedPost } }
      }
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
      case 'foryou/buildProfile':
        return { ok: true, data: await startForYouProfileBuild() }
      case 'foryou/cancelProfile':
        return { ok: true, data: cancelForYouProfileBuild() }
      case 'foryou/status':
        return { ok: true, data: await getForYouStatus() }
      case 'foryou/validate':
        return { ok: true, data: await startForYouValidate() }
      case 'foryou/cancelValidate':
        return { ok: true, data: cancelForYouValidate() }
      case 'foryou/decisions':
        return { ok: true, data: await getForYouDecisions() }
      case 'foryou/applyValidation': {
        // 阈值写进 xsl 必须走 store 的单写者（dispatch + locked）。
        const res = (await dispatchStrike({ type: 'FORYOU_APPLY_VALIDATION', id: msg.validationId }, { internal: true })) as {
          ok?: boolean
          error?: string
        }
        if (!res?.ok) return { ok: false, error: res?.error ?? '应用失败' }
        return { ok: true, data: res }
      }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
