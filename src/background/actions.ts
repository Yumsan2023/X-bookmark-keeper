import { XApiError } from '@/api/errors'
import {
  extractArticleContent,
  extractTweetFromDetail,
  needsDirectArticleRepair,
  needsQuotedArticleRepair,
  padSortIndex,
  parseThread,
  snowflakeToMs,
  type ParsedPost,
} from '@/api/parser'
import { addColdTombstones, listCleanupQueue, updateCleanupStatus } from '@/db/cleanup'
import { db } from '@/db/db'
import { addTags, moveToFolder, releaseBookmark, upsertParsed } from '@/db/posts'
import { pushPostsToNotion } from '@/export/notion'
import { FORYOU_AUTO_TAG, type ForYouBookmarkItem, type ForYouDestination } from '@/foryou/types'
import { recordForYouDecision } from '@/foryou/decisions'
import { normalizeHandle, partitionDeletes, UNKNOWN_ACCOUNT } from '@/shared/accounts'
import { STORAGE_KEYS, type Post, type QuotedPost, type TaskProgress } from '@/shared/types'
import { bumpDbVersion, getSettings } from '@/shared/storage'
import { localDay, nextActionDelayMs } from '@/strike/lib/pure.js'
import type { XClient } from '@/api/client'

let current: { id: string; cancel: boolean; abort: AbortController; task: TaskProgress } | null = null

async function publish(t: TaskProgress) {
  await chrome.storage.local.set({ [STORAGE_KEYS.task]: t })
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function cancelTask(): Promise<void> {
  if (current) {
    current.cancel = true
    current.abort.abort()
    current.task.status = 'cancelled'
    current.task.updated_at = Date.now()
    try {
      await publish({ ...current.task })
    } catch {
      /* ignore */
    }
    return
  }
  // 兜底：Service Worker 被回收/重启后内存中已无 current，但 storage 仍残留 running 状态时，强制标为已取消
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.task)
    const stored = got[STORAGE_KEYS.task] as TaskProgress | undefined
    if (stored && stored.status === 'running') {
      await publish({ ...stored, status: 'cancelled', updated_at: Date.now() })
    }
  } catch {
    /* ignore */
  }
}

/** Service Worker 启动恢复：清理因 SW 休眠而遗留的僵尸 running 任务状态 */
export async function recoverInterruptedTask(): Promise<void> {
  if (current) return
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.task)
    const stored = got[STORAGE_KEYS.task] as TaskProgress | undefined
    if (stored && stored.status === 'running') {
      await publish({ ...stored, status: 'cancelled', error: '后台进程已被浏览器回收，任务已自动中止', updated_at: Date.now() })
    }
  } catch {
    /* ignore */
  }
}

export interface RunTaskOptions {
  /** 每步后的等待毫秒数（默认沿用设置里的页间延迟）。M2 传 minGapMs 的 nextActionDelayMs。 */
  gapMs?: () => number
  /** 单测注入：不真的等。生产不用传。 */
  sleepImpl?: (ms: number) => Promise<void>
  /**
   * 本批累计触发 429 达到该次数时整批中止（默认不限：沿用旧行为，等
   * resetAt 后把该 id 追加队尾重试）。M2 传 2：累计 2 次 429 当天停
   *（设计 §5.1）。注意是累计不是“中间无成功”：重试排队尾，中间
   * 别的条目成功不应把计数清零，否则限流信号会被成功冲掉。
   */
  maxRateLimitStrikes?: number
  /** 每次触发 429 时回调（次数，resetAt）。M2 用来写 xsl 的 backoff。 */
  onRateLimit?: (count: number, resetAt?: number) => void
  /**
   * auth / query_id 失败时是否继续下一条（默认否：整批中止，沿用旧行为）。
   * M2 传 true：单条 queryId 失效只记 failed，不拖垮整批（仅折叠降级）。
   */
  continueOnAuthError?: boolean
}

async function runTask(
  kind: TaskProgress['kind'],
  ids: string[],
  step: (id: string) => Promise<void>,
  extra: Partial<Pick<TaskProgress, 'skipped' | 'account'>> = {},
  opts: RunTaskOptions = {},
): Promise<TaskProgress> {
  if (current) throw new Error('已有任务在运行')
  const settings = await getSettings()
  const abort = new AbortController()
  const doSleep = opts.sleepImpl ?? ((ms: number) => cancellableSleep(ms, abort.signal))
  const idStr = `${Date.now()}`
  const t: TaskProgress = { id: idStr, kind, status: 'running', total: ids.length, done: 0, failed: 0, updated_at: Date.now(), ...extra }
  const ctl = { id: idStr, cancel: false, abort, task: t }
  current = ctl
  // 所有后台长任务统一加 MV3 Service Worker 心跳保活，防止睡眠导致僵尸任务
  const taskKeepAlive =
    typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo
      ? setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
      : undefined
  await publish(t)
  let rateLimitStrikes = 0
  try {
    for (const id of ids) {
      if (ctl.cancel) {
        t.status = 'cancelled'
        break
      }
      try {
        await step(id)
      } catch (e) {
        if (ctl.cancel) {
          t.status = 'cancelled'
          break
        }
        if (e instanceof XApiError && (e.code === 'auth' || e.code === 'query_id')) {
          if (opts.continueOnAuthError) t.failed++
          else throw e
        } else if (e instanceof XApiError && e.code === 'rate_limit') {
          rateLimitStrikes++
          opts.onRateLimit?.(rateLimitStrikes, e.resetAt)
          if (opts.maxRateLimitStrikes && rateLimitStrikes >= opts.maxRateLimitStrikes) {
            throw new Error(`触发限流 (429) 已达 ${rateLimitStrikes} 次，已暂停本次自动收藏`)
          }
          const wait = Math.max(5000, (e.resetAt ?? Date.now() + 60_000) - Date.now())
          await doSleep(Math.min(wait, 15 * 60_000))
          if (ctl.cancel) {
            t.status = 'cancelled'
            break
          }
          ids.push(id) // 重试一次: 追加到队尾
          t.total++
        } else t.failed++
      }
      if (ctl.cancel) {
        t.status = 'cancelled'
        break
      }
      t.done++
      t.updated_at = Date.now()
      await publish(t)
      await doSleep(opts.gapMs ? opts.gapMs() : rand(settings.delayMinSec, settings.delayMaxSec) * 1000 * 0.5)
      if (ctl.cancel) {
        t.status = 'cancelled'
        break
      }
    }
    if (t.status === 'running') t.status = ctl.cancel ? 'cancelled' : 'done'
  } catch (e) {
    if (ctl.cancel) {
      t.status = 'cancelled'
    } else {
      t.status = 'error'
      t.error = (e as Error).message
    }
  } finally {
    if (taskKeepAlive) clearInterval(taskKeepAlive)
    if (ctl.cancel && t.status === 'running') t.status = 'cancelled'
    current = null
    t.updated_at = Date.now()
    await publish(t)
    await bumpDbVersion()
  }
  return t
}

export interface DeleteBookmarkResult {
  account: string
  queued: number
  skipped: number
  unknown: number
}

/**
 * 批量取消当前登录账号的 X 书签。
 * 其他账号收藏的帖子跳过；未记录账号的旧数据会尝试删除（unknown）。
 * 仍有其他账号持有时只去掉当前账号，不把整行标成 unbookmarked。
 */
export async function deleteBookmarks(client: XClient, ids: string[], removeLocalToo: boolean): Promise<DeleteBookmarkResult> {
  if (current) throw new Error('已有任务在运行')
  let account = ''
  try {
    account = normalizeHandle((await client.getAccountSettings()).screen_name)
  } catch (e) {
    throw new Error(`无法确认当前登录的 X 账号, 已取消删除: ${(e as Error).message}`)
  }
  if (!account) throw new Error('无法确认当前登录的 X 账号, 已取消删除')
  const unique = [...new Set(ids)]
  const posts = await db.posts.bulkGet(unique)
  const part = partitionDeletes(unique, posts, account)
  if (part.allowed.length) {
    void runTask(
      'delete',
      [...part.allowed],
      async (id) => {
        await client.deleteBookmark(id)
        await releaseBookmark(id, account, removeLocalToo)
      },
      { skipped: part.skipped.length, account },
    ).catch(() => {})
  }
  return { account, queued: part.allowed.length, skipped: part.skipped.length, unknown: part.unknown.length }
}

/** 把本地已归类的书签推送到 X 文件夹 (best-effort) */
export function pushFolder(client: XClient, ids: string[], folderName: string) {
  return runTask('folder', [...ids], async (id) => {
    const f = await db.folders.get(folderName)
    if (!f?.x_id) throw new Error('该文件夹不是 X 端文件夹')
    await client.addToFolder(id, f.x_id)
  })
}

export function fetchThreads(client: XClient, ids: string[]) {
  return runTask('threads', [...ids], async (id) => {
    const json = await client.getTweetDetail(id)
    await db.posts.update(id, { thread: parseThread(json, id), thread_fetched_at: Date.now() })
  })
}

// ---------------- For You 自动收藏 (M2) ----------------

export interface BookmarkTweetsOptions {
  destination: ForYouDestination
  /** 收藏动作最小间隔 (ms)，默认 5000（设计 §4.2，M1 设置值）。 */
  minGapMs: number
  /** 手动移动文件夹时是否同步到 X（bk_settings.pushFolderMoveToX，默认 false）。 */
  pushFolderMoveToX: boolean
  /** 每收藏成功一条回调（store.js 用来从 xsl 队列移除并计入当日数）。 */
  onBookmarked?: (item: ForYouBookmarkItem) => void
  /** 每条失败回调（store.js 用来从 xsl 队列移除；失败仍记决策日志）。 */
  onFailed?: (item: ForYouBookmarkItem, error: Error) => void
  /** 每次触发 429 回调（store.js 用来写 backoff；连续 2 次当天停）。 */
  onRateLimited?: (strikes: number, resetAt?: number) => void
  /** 单测注入：不真的等。生产不用传。 */
  sleepImpl?: (ms: number) => Promise<void>
  /** 单测注入：固定间隔，替代 nextActionDelayMs 的随机 jitter。生产不用传。 */
  gapMs?: () => number
  /** v2 出队二次上限校验：每次真正发 CreateBookmark 前原子确认今日未超 dailyCap。 */
  beforeEachBookmark?: () => Promise<boolean>
}

/**
 * 把内容脚本采集到的最小推文信息拼成轻量 ParsedPost。
 * 内容脚本只给 handle/text/tweetId/followed，缺 user_id/name/avatar/
 * 互动数/媒体/创建时间：user_id/name/avatar 尽量从库里已有行补，
 * 其余填空值/0；created_at 用 snowflake 反推。下次书签增量同步命中
 * 同一 tweetId 时 mergePost() 会补全全部字段（不覆盖本地 tags/folder）。
 */
export function buildForYouParsedPost(
  item: ForYouBookmarkItem,
  existing?: { user_id?: string; name?: string; avatar?: string; text?: string },
): ParsedPost {
  const handle = item.handle.replace(/^@/, '')
  return {
    tweet_id: item.tweetId,
    sort_index: padSortIndex(item.tweetId),
    user_id: existing?.user_id ?? '',
    screen_name: handle,
    name: existing?.name ?? '',
    avatar: existing?.avatar ?? '',
    created_at: snowflakeToMs(item.tweetId),
    text: item.text || existing?.text || '',
    lang: '',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: 0 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    url: `https://x.com/${handle}/status/${item.tweetId}`,
    source: 'bookmark',
    accounts: [],
  }
}

/**
 * For You 自动收藏执行（M2，设计 §5.1）。
 * 每步：X 端 createBookmark → 本地轻量落库（tags 追加 'auto'）→
 * 去向是文件夹时 moveToFolder（本地文件夹不存在自动创建；只有文件夹
 * 有 x_id 且 pushFolderMoveToX 开启时才额外推到 X，best-effort，
 * 失败不回滚本地）→ 写 foryouDecisions。
 * 节流：间隔 minGapMs + 1000–2500ms jitter（nextActionDelayMs）；
 * 429 等 resetAt 后把该条追加队尾重试一次，本批累计 2 次 429 整批中止；
 * auth / query_id 失败只记 failed 不拖垮整批（仅折叠降级，见 client.ts）。
 * 已在库里是 active 书签的跳过（不重复收藏），计入 skipped。
 * 注意：本函数不读 xsl 的每日上限——上限在入队时由 store.js 的
 * FORYOU_BOOKMARK 按 dailyCap 钳；这里只执行已入队的条目。
 */
export async function bookmarkTweets(
  client: XClient,
  items: ForYouBookmarkItem[],
  opts: BookmarkTweetsOptions,
): Promise<TaskProgress> {
  const byId = new Map<string, ForYouBookmarkItem>()
  for (const item of items) {
    const id = String(item?.tweetId || '').trim()
    if (id && !byId.has(id)) byId.set(id, { ...item, tweetId: id })
  }
  const ids = [...byId.keys()]
  const runId = `foryou-${Date.now()}`
  const destinationFolder = opts.destination.kind === 'folder' ? opts.destination.folder : ''
  let skipped = 0
  if (ids.length) {
    const existingRows = await db.posts.bulkGet(ids)
    for (let i = ids.length - 1; i >= 0; i--) {
      const row = existingRows[i]
      if (row && row.status === 'active' && row.source !== 'timeline') {
        byId.delete(ids[i])
        ids.splice(i, 1)
        skipped++
      }
    }
  }
  const gapMs = opts.gapMs ?? (() => nextActionDelayMs(opts.minGapMs))
  return runTask(
    'foryou-bookmark',
    [...ids],
    async (id) => {
      const item = byId.get(id)!
      const decisionBase = {
        tweet_id: id,
        at: Date.now(),
        rule: item.rule ?? null,
        vector: item.vector ?? null,
        final: item.final,
        decision: 'bookmark' as const,
        reasons: item.reasons ?? [],
        destination: destinationFolder,
        // M4：面板展示用；打分时已记的行里可能有 vectorCache / feedback，
        // 执行覆盖时要保留（否则反馈用的向量就丢了）。
        handle: item.handle,
        textSnippet: (item.text || '').slice(0, 200),
      }
      // 打分时记的行（带 vectorCache / feedback）不能被执行覆盖丢掉。
      const prevDecision = await db.foryouDecisions.get(id)
      if (opts.beforeEachBookmark) {
        const allowed = await opts.beforeEachBookmark()
        if (!allowed) {
          cancelTask()
          return
        }
      }
      try {
        await client.createBookmark(id)
        const existing = await db.posts.get(id)
        await upsertParsed([buildForYouParsedPost(item, existing ?? undefined)], runId, { source: 'bookmark' })
        await addTags([id], [FORYOU_AUTO_TAG])
        if (destinationFolder) {
          await moveToFolder([id], destinationFolder)
          if (opts.pushFolderMoveToX) {
            const folder = await db.folders.get(destinationFolder)
            if (folder?.x_id) {
              try {
                await client.addToFolder(id, folder.x_id)
              } catch {
                /* best-effort：本地已正确落库，X 端推送失败不回滚 */
              }
            }
          }
        }
        await recordForYouDecision({
          ...decisionBase,
          vectorCache: prevDecision?.vectorCache,
          feedback: prevDecision?.feedback,
          status: 'bookmarked',
        })
        opts.onBookmarked?.(item)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        await recordForYouDecision({
          ...decisionBase,
          vectorCache: prevDecision?.vectorCache,
          feedback: prevDecision?.feedback,
          status: 'failed',
          error: err.message.slice(0, 200),
        })
        opts.onFailed?.(item, err)
        throw err
      }
    },
    { skipped },
    {
      gapMs,
      sleepImpl: opts.sleepImpl,
      maxRateLimitStrikes: 2,
      continueOnAuthError: true,
      onRateLimit: (count, resetAt) => opts.onRateLimited?.(count, resetAt),
    },
  )
}

// ---------------- v2 X 端安全清理队列执行 ----------------

export interface CleanupRunResult {
  account: string
  queued: number
  remainingToday: number
  dailyCap: number
}

async function readCleanupDaily(): Promise<{ day: string; doneToday: number }> {
  const today = localDay(Date.now())
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.cleanupDaily)
    const raw = got[STORAGE_KEYS.cleanupDaily] as { day?: string; doneToday?: number } | undefined
    if (raw && raw.day === today) return { day: today, doneToday: Number(raw.doneToday) || 0 }
  } catch {
    /* ignore */
  }
  return { day: today, doneToday: 0 }
}

async function bumpCleanupDaily(delta = 1): Promise<number> {
  const cur = await readCleanupDaily()
  const next = cur.doneToday + delta
  await chrome.storage.local.set({ [STORAGE_KEYS.cleanupDaily]: { day: cur.day, doneToday: next } })
  return next
}

const CLEANUP_COOLDOWN_KEY = 'bk_cleanup_cooldown_until'

async function readCleanupCooldownUntil(): Promise<number> {
  try {
    const got = await chrome.storage.local.get(CLEANUP_COOLDOWN_KEY)
    return Number(got[CLEANUP_COOLDOWN_KEY] ?? 0) || 0
  } catch {
    return 0
  }
}

async function writeCleanupCooldownUntil(until: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [CLEANUP_COOLDOWN_KEY]: until })
  } catch {
    /* ignore */
  }
}

/**
 * v2 安全清理队列执行器：
 * 1. 只执行归属于「当前已登录 X 账号」的 pending 条目（绝不误动其他账号）；
 * 2. 严格执行每日上限（settings.cleanupDailyCap，默认 50 条/天）与 429 持久化冷却保护；
 * 3. 随机 3–6 秒间隔 + 遇 2 次 429 自动熔断暂停；
 * 4. 成功后更新 cleanupQueue 状态、同步更新本地书签状态并写入冷库墓碑。
 */
export async function runCleanupQueue(
  client: XClient,
  opts: { limit?: number; removeLocal?: boolean } = {},
): Promise<CleanupRunResult> {
  if (current) throw new Error('已有任务在运行')
  const cooldownUntil = await readCleanupCooldownUntil()
  if (Date.now() < cooldownUntil) {
    const waitMin = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60_000))
    throw new Error(`上次触发了 X 限流 (429)，安全冷却中，请约 ${waitMin} 分钟后再试`)
  }
  let account = ''
  try {
    account = normalizeHandle((await client.getAccountSettings()).screen_name)
  } catch (e) {
    throw new Error(`无法确认当前登录的 X 账号, 已取消执行清理队列: ${(e as Error).message}`)
  }
  if (!account) throw new Error('无法确认当前登录的 X 账号, 已取消执行清理队列')

  const settings = await getSettings()
  const dailyCap = Math.max(1, Math.min(300, Number(settings.cleanupDailyCap) || 50))
  const daily = await readCleanupDaily()
  const remainingToday = Math.max(0, dailyCap - daily.doneToday)
  if (remainingToday <= 0) {
    return { account, queued: 0, remainingToday: 0, dailyCap }
  }

  const pending = await listCleanupQueue({ account, status: 'pending' })
  // Also allow __unknown__ only if specifically owned by current account; default strictly matches current account
  const matched = pending.filter((row) => row.account === account || (row.accounts ?? []).includes(account))
  const maxRun = Math.min(remainingToday, Math.max(1, opts.limit ?? remainingToday), matched.length)
  const batch = matched.slice(0, maxRun)
  if (!batch.length) {
    return { account, queued: 0, remainingToday, dailyCap }
  }

  const removeLocal = opts.removeLocal === true
  void runTask(
    'cleanup',
    batch.map((r) => r.tweet_id),
    async (id) => {
      const check = await readCleanupDaily()
      if (check.doneToday >= dailyCap) {
        cancelTask()
        return
      }
      try {
        await client.deleteBookmark(id)
        await releaseBookmark(id, account, removeLocal)
        await updateCleanupStatus(id, 'done')
        await addColdTombstones([id])
        await bumpCleanupDaily(1)
      } catch (e) {
        const msg = (e as Error)?.message?.slice(0, 200) ?? String(e)
        if (!(e instanceof XApiError && e.code === 'rate_limit')) {
          await updateCleanupStatus(id, 'failed', msg)
        }
        throw e
      }
    },
    { account, skipped: pending.length - matched.length },
    {
      gapMs: () => 3000 + Math.random() * 3000,
      maxRateLimitStrikes: 2,
      onRateLimit: (_count, resetAt) => {
        const until = Math.max(resetAt ?? 0, Date.now() + 15 * 60_000)
        void writeCleanupCooldownUntil(until)
      },
    },
  ).catch(() => {})

  return {
    account,
    queued: batch.length,
    remainingToday: Math.max(0, remainingToday - batch.length),
    dailyCap,
  }
}

// ---------------- v2 残缺内容定向补全 (截断正文 / X 文章全文 / 引用文章全文 / t.co 还原) ----------------

const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g

async function expandTcoUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) })
    return res.url && !res.url.includes('t.co/') ? res.url : url
  } catch {
    return url
  }
}

function needsOuterTweetRepair(p: Post): boolean {
  if (needsDirectArticleRepair(p)) return true
  const s = (p.text || '').trim()
  if (!s) return true
  if (s.length >= 220 && s.length <= 360 && (s.endsWith('…') || s.endsWith('...'))) return true
  if (TCO_RE.test(s) || (p.urls ?? []).some((u) => u.includes('t.co/'))) return true
  return false
}

export interface RepairSingleResult {
  tweet_id: string
  updated: boolean
  charsAdded: number
  imagesAdded: number
  articleFull: boolean
  quotedArticleFull: boolean
  message: string
  post?: Post
}

function mergeMediaUnique(prev: Post['media'] | undefined, incoming: Post['media'] | undefined): Post['media'] {
  const out = [...(prev ?? [])]
  const seen = new Set(out.map((m) => m.url))
  for (const m of incoming ?? []) {
    if (m.url && !seen.has(m.url)) {
      seen.add(m.url)
      out.push(m)
    }
  }
  return out
}

/**
 * 单条书签的同步定向补全（同时被阅读抽屉单条按钮和批量补全队列复用）：
 * - 不拉取评论区无关串推；
 * - 补全缺失/截断正文、直接 X 文章全文 + 配图、被引用 X 文章全文 + 配图、以及残留 t.co 短链；
 * - 返回精确结果摘要与更新后的 Post，供 UI 立即刷新并给出明确提示。
 */
export async function repairSinglePost(
  client: XClient,
  id: string,
  opts: { force?: boolean } = {},
): Promise<RepairSingleResult> {
  const existing = await db.posts.get(id)
  if (!existing) {
    return {
      tweet_id: id,
      updated: false,
      charsAdded: 0,
      imagesAdded: 0,
      articleFull: false,
      quotedArticleFull: false,
      message: '未在本地库中找到该书签',
    }
  }

  const prevTextLen = (existing.text || '').length
  const prevQuotedArtLen = (existing.quoted?.article_text || '').length
  const prevImgCount = (existing.media?.length ?? 0) + (existing.quoted?.media?.length ?? 0)

  let text = existing.text
  let urls = [...(existing.urls ?? [])]
  let media = [...(existing.media ?? [])]
  let quoted: QuotedPost | undefined = existing.quoted ? { ...existing.quoted } : undefined
  let hasArticle = existing.has_article
  let articleTitle = existing.article_title
  let articleFull = false
  let quotedArticleFull = false

  const hasQuotedArticle = !!(
    quoted?.tweet_id &&
    (quoted.article_id || quoted.article_title || /(?:x|twitter)\.com\/(?:i\/articles?\/|[^/]+\/article\/)/i.test(quoted.text || ''))
  )
  const shouldFetchQuoted = opts.force ? hasQuotedArticle : needsQuotedArticleRepair(quoted)
  const onlyQuotedArticle = !opts.force && !needsOuterTweetRepair(existing) && shouldFetchQuoted

  // 1. 抓取外层推文（截断正文 / 直接 X 文章全文 + 配图 / 最新引用元数据）
  if (!onlyQuotedArticle) {
    const json = await client.getTweetDetail(id)
    const hit = extractTweetFromDetail(json, id)
    const fresh = hit?.post
    if (fresh) {
      const rawArt = hit?.raw?.article?.article_results?.result ?? hit?.raw?.article?.result
      const extractedArt = extractArticleContent(rawArt)
      if (extractedArt?.isFull) {
        articleFull = true
        if (extractedArt.title) articleTitle = extractedArt.title
        media = mergeMediaUnique(media, extractedArt.images)
      }
      if (fresh.text.length > text.length || (articleFull && (fresh.text.length >= text.length || opts.force))) {
        text = fresh.text
      }
      if (fresh.urls.length >= urls.length) urls = [...fresh.urls]
      media = mergeMediaUnique(media, fresh.media)
      if (fresh.has_article) hasArticle = 1
      if (fresh.article_title) articleTitle = fresh.article_title
      if (fresh.quoted) {
        quoted = {
          ...quoted,
          ...fresh.quoted,
          text: quoted && quoted.text.length > fresh.quoted.text.length ? quoted.text : fresh.quoted.text,
          article_text:
            !opts.force && quoted?.article_text && quoted.article_text.length > (fresh.quoted.article_text?.length ?? 0)
              ? quoted.article_text
              : fresh.quoted.article_text || quoted?.article_text,
          article_title: fresh.quoted.article_title || quoted?.article_title,
          article_id: fresh.quoted.article_id || quoted?.article_id,
          media: mergeMediaUnique(quoted?.media, fresh.quoted.media),
        }
        if (quoted.article_text && quoted.article_text.length > prevQuotedArtLen) {
          quotedArticleFull = true
        }
      }
    }
  }

  // 2. 若该书签引用了一条 X 文章且尚未拿到完整文章正文（或用户手动强制刷新配图），定向抓取被引用推文的完整 X Article + 配图
  const needQuotedStep = opts.force ? hasQuotedArticle : needsQuotedArticleRepair(quoted)
  if (needQuotedStep && quoted?.tweet_id) {
    if (!onlyQuotedArticle) await sleep(400)
    try {
      const qJson = await client.getTweetDetail(quoted.tweet_id)
      const qHit = extractTweetFromDetail(qJson, quoted.tweet_id)
      if (qHit) {
        const rawArt = qHit.raw?.article?.article_results?.result ?? qHit.raw?.article?.result
        const extracted = extractArticleContent(rawArt)
        if (extracted?.body && (extracted.isFull || opts.force || extracted.body.length > (quoted.article_text?.length ?? 0))) {
          quoted = {
            ...quoted,
            article_title: extracted.title || quoted.article_title,
            article_text: extracted.body,
            media: mergeMediaUnique(quoted.media, mergeMediaUnique(qHit.post.media, extracted.images)),
          }
          quotedArticleFull = true
        } else if (qHit.post.text.length > quoted.text.length) {
          quoted = {
            ...quoted,
            text: qHit.post.text,
            ...(qHit.post.article_title ? { article_title: qHit.post.article_title } : {}),
            ...(qHit.post.text.length >= 300 ? { article_text: qHit.post.text } : {}),
            media: mergeMediaUnique(quoted.media, qHit.post.media),
          }
          quotedArticleFull = true
        }
      }
    } catch (e) {
      if (e instanceof XApiError && (e.code === 'auth' || e.code === 'rate_limit')) throw e
      /* 被引用的原推文可能已删除/不可见，不阻断外层修复 */
    }
  }

  // 3. 还原残留 t.co 短链
  const tcoHits = [...new Set([...(text.match(TCO_RE) ?? []), ...urls.filter((u) => u.includes('t.co/'))])]
  for (const shortUrl of tcoHits.slice(0, 6)) {
    const expanded = await expandTcoUrl(shortUrl)
    if (expanded !== shortUrl) {
      text = text.split(shortUrl).join(expanded)
      urls = urls.map((u) => (u === shortUrl ? expanded : u))
    }
  }

  const patch: Partial<Post> = {
    text,
    urls,
    media,
    has_image: media.some((m) => m.type === 'photo') ? 1 : existing.has_image,
    quoted,
    article_checked_at: Date.now(),
    ...(hasArticle ? { has_article: hasArticle } : {}),
    ...(articleTitle ? { article_title: articleTitle } : {}),
    ...(articleFull || quotedArticleFull ? { article_fetched_at: Date.now() } : {}),
  }
  await db.posts.update(id, patch)
  const updatedPost = await db.posts.get(id)
  await bumpDbVersion()

  const newImgCount = (media.length ?? 0) + (quoted?.media?.length ?? 0)
  const charsAdded = Math.max(0, text.length - prevTextLen) + Math.max(0, (quoted?.article_text?.length ?? 0) - prevQuotedArtLen)
  const imagesAdded = Math.max(0, newImgCount - prevImgCount)
  const updated = charsAdded > 0 || imagesAdded > 0 || articleFull || quotedArticleFull

  let message: string
  if (quotedArticleFull && articleFull) {
    message = `已补全主文与引用文章全文（+${charsAdded.toLocaleString()} 字${imagesAdded ? ` · +${imagesAdded} 张图` : ''}）`
  } else if (quotedArticleFull) {
    message = `已抓取引用文章全文（+${charsAdded.toLocaleString()} 字${imagesAdded ? ` · +${imagesAdded} 张图` : ''}）`
  } else if (articleFull) {
    message = `已抓取 X 文章全文（+${charsAdded.toLocaleString()} 字${imagesAdded ? ` · +${imagesAdded} 张图` : ''}）`
  } else if (charsAdded > 0 || imagesAdded > 0) {
    message = `已补全内容（+${charsAdded.toLocaleString()} 字${imagesAdded ? ` · +${imagesAdded} 张图` : ''}）`
  } else if (hasArticle === 1 || needsDirectArticleRepair(existing)) {
    message = 'X 接口本次未返回该文章正文（可能为仅网页端渲染的文章卡片或原帖受限），可点「原文」查看'
  } else {
    message = '该条书签正文已是完整版，无需补充'
  }

  return {
    tweet_id: id,
    updated,
    charsAdded,
    imagesAdded,
    articleFull,
    quotedArticleFull,
    message,
    post: updatedPost,
  }
}

/** 批量残缺内容与 X 文章全文补全任务 */
export function repairIncompletePosts(client: XClient, tweetIds: string[]) {
  const unique = [...new Set(tweetIds)]
  return runTask(
    'repair',
    unique,
    async (id) => {
      await repairSinglePost(client, id)
    },
    {},
    {
      gapMs: () => rand(1600, 3200),
      maxRateLimitStrikes: 2,
    },
  )
}

/** 新同步完成后，自动在后台补全本轮新入库的残缺 X 文章（含直接文章与引用文章，默认每轮最多 10 条防限流） */
export async function autoRepairNewArticles(client: XClient, runId: string, maxPerRun = 10): Promise<number> {
  if (!runId || current) return 0
  const recent = await db.posts.where('sync_run').equals(runId).toArray()
  const targets = recent
    .filter((p) => p.status === 'active' && (needsDirectArticleRepair(p) || needsQuotedArticleRepair(p.quoted)))
    .slice(0, maxPerRun)
    .map((p) => p.tweet_id)
  if (!targets.length) return 0
  void repairIncompletePosts(client, targets).catch(() => {})
  return targets.length
}

// ---------------- v2 一键推送精选至 Notion ----------------

export function pushBookmarksToNotion(tweetIds: string[]) {
  const unique = [...new Set(tweetIds)]
  return runTask('notion', unique, async (id) => {
    const settings = await getSettings()
    const post = await db.posts.get(id)
    if (!post) return
    const res = await pushPostsToNotion([post], {
      token: settings.notionToken,
      databaseId: settings.notionDatabaseId,
    })
    if (res.failed > 0) throw new Error(res.errors[0] || 'Notion 推送失败')
  })
}

export { UNKNOWN_ACCOUNT }
