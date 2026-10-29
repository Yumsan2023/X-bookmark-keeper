import { XApiError } from '@/api/errors'
import { parseFolders, parseThread, parseTimelinePage, type ParsedPost } from '@/api/parser'
import { db } from '@/db/db'
import {
  listFolders,
  markTweetsDeleted,
  markUnbookmarkedNotSeen,
  upsertFolder,
  upsertParsed,
} from '@/db/posts'
import type { Settings, SyncMode, SyncProgress } from '@/shared/types'

/** 同步引擎依赖 (全部可注入, 便于测试) */
export interface SyncApi {
  getBookmarks(cursor?: string, count?: number): Promise<any>
  getFolders(cursor?: string): Promise<any>
  getFolderTimeline(folderId: string, cursor?: string): Promise<any>
  getTweetDetail(tweetId: string): Promise<any>
}

export interface SyncDeps {
  api: SyncApi
  getSettings(): Promise<Settings>
  loadProgress(): Promise<SyncProgress | undefined>
  saveProgress(p: SyncProgress): Promise<void>
  onDbChanged?(): Promise<void> | void
  /** Called after a successful full bookmark sync (for report meta) */
  onFullSyncDone?(meta: { at: number; syncedInRun: number; run_id: string; mode: SyncMode; pendingReport?: boolean }): Promise<void> | void
  /** 限流等待期间的兜底唤醒 (alarms) */
  scheduleWake?(at: number): void
  sleep?(ms: number): Promise<void>
  random?(): number
  now?(): number
  newRunId?(): string
}

class Cancelled extends Error {}

const MAX_RETRIES = 3

export class SyncEngine {
  private running = false
  private pauseRequested = false
  private cancelRequested = false
  private resumeWaiter: (() => void) | null = null
  private prog!: SyncProgress
  private seenInBookmarks = 0

  constructor(private deps: SyncDeps) {}

  get isRunning() {
    return this.running
  }

  private sleep(ms: number) {
    return (this.deps.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms)
  }
  private now() {
    return (this.deps.now ?? Date.now)()
  }

  pause() {
    if (this.running) this.pauseRequested = true
  }
  resume() {
    this.pauseRequested = false
    this.resumeWaiter?.()
    this.resumeWaiter = null
  }
  cancel() {
    this.cancelRequested = true
    this.resume()
  }

  private async save(patch: Partial<SyncProgress> = {}) {
    this.prog = { ...this.prog, ...patch, updated_at: this.now() }
    await this.deps.saveProgress(this.prog)
  }

  /** 每个循环节点调用: 处理取消/暂停 */
  private async checkpoint() {
    if (this.cancelRequested) throw new Cancelled()
    if (this.pauseRequested) {
      await this.save({ status: 'paused', message: '已暂停' })
      await new Promise<void>((r) => (this.resumeWaiter = r))
      if (this.cancelRequested) throw new Cancelled()
      await this.save({ status: 'running', message: undefined })
    }
  }

  private async pageDelay(settings: Settings) {
    const min = Math.max(0, settings.delayMinSec)
    const max = Math.max(min, settings.delayMaxSec)
    const sec = min + (this.deps.random ?? Math.random)() * (max - min)
    await this.interruptibleSleep(sec * 1000)
  }

  private async interruptibleSleep(ms: number) {
    let left = ms
    while (left > 0) {
      await this.checkpoint()
      const step = Math.min(left, 2000)
      await this.sleep(step)
      left -= step
    }
  }

  /** 带重试 / 限流退避的请求包装 */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0
    for (;;) {
      await this.checkpoint()
      try {
        return await fn()
      } catch (e) {
        if (e instanceof Cancelled) throw e
        if (!(e instanceof XApiError)) throw e
        if (e.code === 'rate_limit') {
          const until = Math.max(e.resetAt ?? 0, this.now() + 5000) + 2000
          this.deps.scheduleWake?.(until)
          await this.save({
            status: 'waiting',
            wait_until: until,
            message: `触发限流, 等待至 ${new Date(until).toLocaleTimeString()}`,
          })
          let left = until - this.now()
          let sinceSave = 0
          while (left > 0) {
            await this.checkpoint()
            const step = Math.min(left, 5000)
            await this.sleep(step)
            left = until - this.now()
            sinceSave += step
            if (sinceSave >= 20000) {
              sinceSave = 0
              await this.save() // 写 storage 也能让 service worker 保持活跃
            }
          }
          await this.save({ status: 'running', wait_until: undefined, message: undefined })
          continue
        }
        if ((e.code === 'network' || e.code === 'timeout') && attempt < MAX_RETRIES) {
          attempt++
          await this.interruptibleSleep(2000 * 2 ** attempt)
          continue
        }
        throw e
      }
    }
  }

  async start(mode: SyncMode): Promise<SyncProgress> {
    if (this.running) return this.prog // 已在运行: 忽略重复调用, 返回当前进度
    this.running = true
    this.pauseRequested = false
    this.cancelRequested = false
    const settings = await this.deps.getSettings()
    const saved = await this.deps.loadProgress()
    const now = this.now()
    const canResume = mode === 'resume' && saved && saved.mode === 'full' && saved.status !== 'done' && saved.status !== 'idle'
    if (canResume && saved) {
      this.prog = { ...saved, status: 'running', error: undefined, error_code: undefined, wait_until: undefined, message: '从断点继续', updated_at: now }
    } else {
      this.prog = {
        status: 'running',
        phase: 'bookmarks',
        mode: mode === 'resume' ? 'incremental' : mode,
        kind: 'bookmark',
        run_id: (this.deps.newRunId ?? (() => `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`))(),
        started_at: now,
        updated_at: now,
        pages: 0,
        fetched: 0,
        added: 0,
        updated: 0,
      }
    }
    this.seenInBookmarks = this.prog.fetched
    await this.save()

    try {
      if (this.prog.phase === 'bookmarks') {
        await this.syncBookmarks(settings)
        if (settings.syncFolders) await this.syncFolders(settings)
        else await this.save({ phase: 'folders' })
      } else if (this.prog.phase === 'folders') {
        await this.syncFolders(settings)
      }
      if (settings.fetchThreads) await this.syncThreads(settings)
      if (this.prog.mode === 'full' && settings.detectDeleted) await this.detectRemoved()
      await this.save({ status: 'done', phase: 'done', cursor: undefined, message: '同步完成' })
      if (this.prog.mode === 'full') {
        await this.deps.onFullSyncDone?.({
          at: this.now(),
          syncedInRun: this.prog.fetched,
          run_id: this.prog.run_id,
          mode: this.prog.mode,
          pendingReport: true,
        })
      }
    } catch (e) {
      if (e instanceof Cancelled) {
        await this.save({ status: 'cancelled', message: '已取消 (可从断点继续)' })
      } else if (e instanceof XApiError) {
        await this.save({ status: 'error', error: e.message, error_code: e.code, message: undefined })
      } else {
        await this.save({ status: 'error', error: (e as Error)?.message ?? String(e), error_code: 'data' })
      }
    } finally {
      this.running = false
      await this.deps.onDbChanged?.()
    }
    return this.prog
  }

  // ---------------- 阶段 1: 书签主列表 ----------------
  private async syncBookmarks(settings: Settings) {
    const runId = this.prog.run_id
    const full = this.prog.mode === 'full'
    let cursor = this.prog.cursor
    await this.save({ phase: 'bookmarks' })
    for (;;) {
      await this.checkpoint()
      const json = await this.call(() => this.deps.api.getBookmarks(cursor, settings.pageSize))
      const page = parseTimelinePage(json)
      if (!page.recognized) throw new XApiError('data', '无法识别 Bookmarks 响应结构 (X 可能改版), 请查看 README 的 queryId/结构变动说明')
      const tweets = page.entries.filter((e): e is { kind: 'tweet'; post: ParsedPost } => e.kind === 'tweet').map((e) => e.post)
      const deleted = page.entries.filter((e) => e.kind === 'deleted').map((e) => (e as { tweet_id: string }).tweet_id)
      const r = await upsertParsed(tweets, runId, { source: 'bookmark' })
      if (deleted.length) await markTweetsDeleted(deleted, runId)
      this.seenInBookmarks += tweets.length + deleted.length
      const nextCursor = page.cursor && page.cursor !== cursor ? page.cursor : undefined
      await this.save({
        pages: this.prog.pages + 1,
        fetched: this.seenInBookmarks,
        added: this.prog.added + r.added,
        updated: this.prog.updated + r.updated,
        cursor: nextCursor,
        message: `已抓取 ${this.seenInBookmarks} 条`,
      })
      await this.deps.onDbChanged?.()
      if (!tweets.length && !deleted.length) break // 空页 = 到底
      if (!full && r.existingIds.length > 0) break // 增量: 遇到已存在的书签即停
      if (!nextCursor) break
      cursor = nextCursor
      await this.pageDelay(settings)
    }
    await this.save({ cursor: undefined, phase: 'folders' })
  }

  // ---------------- 阶段 2: 文件夹 ----------------
  private async syncFolders(settings: Settings) {
    const runId = this.prog.run_id
    await this.save({ phase: 'folders', message: '同步文件夹…' })
    const json = await this.call(() => this.deps.api.getFolders())
    const { folders } = parseFolders(json)
    const now = this.now()
    const remoteNames = new Set<string>()
    for (const f of folders) {
      remoteNames.add(f.name)
      await upsertFolder({ name: f.name, x_id: f.id, source: 'x', created_at: now })
    }
    // X 端已不存在的文件夹降级为本地文件夹 (保留归类)
    for (const f of await listFolders()) {
      if (f.source === 'x' && !remoteNames.has(f.name)) await db.folders.put({ name: f.name, source: 'local', created_at: f.created_at })
    }
    for (const f of folders) {
      await this.pageDelay(settings)
      await this.save({ folder: f.name, message: `文件夹: ${f.name}` })
      const seen = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        await this.checkpoint()
        const res = await this.call(() => this.deps.api.getFolderTimeline(f.id, cursor))
        const page = parseTimelinePage(res)
        if (!page.recognized) break
        const tweets = page.entries.filter((e): e is { kind: 'tweet'; post: ParsedPost } => e.kind === 'tweet').map((e) => e.post)
        const r = await upsertParsed(tweets, runId, { folder: f.name, keepSortIndex: true, source: 'bookmark' })
        tweets.forEach((t) => seen.add(t.tweet_id))
        await this.save({ pages: this.prog.pages + 1, added: this.prog.added + r.added })
        const next = page.cursor && page.cursor !== cursor ? page.cursor : undefined
        if (!tweets.length || !next) break
        cursor = next
        await this.pageDelay(settings)
      }
      // 本地认为在该文件夹、但 X 端文件夹里已没有的书签 → 移出
      await db.posts
        .where('folder')
        .equals(f.name)
        .filter((p) => !seen.has(p.tweet_id))
        .modify({ folder: '' })
      await this.deps.onDbChanged?.()
    }
    await this.save({ folder: undefined, phase: 'threads' })
  }

  // ---------------- 阶段 3: 线程 ----------------
  private async syncThreads(settings: Settings) {
    await this.save({ phase: 'threads', message: '抓取线程…' })
    const todo = await db.posts.filter((p) => p.status === 'active' && !p.thread_fetched_at && p.sync_run === this.prog.run_id).primaryKeys()
    let n = 0
    for (const id of todo) {
      await this.checkpoint()
      try {
        const json = await this.call(() => this.deps.api.getTweetDetail(id))
        const thread = parseThread(json, id)
        await db.posts.update(id, { thread, thread_fetched_at: this.now() })
      } catch (e) {
        if (e instanceof XApiError && (e.code === 'auth' || e.code === 'query_id')) throw e
        // 单条失败 (推文被删等) 不中断整体
      }
      n++
      await this.save({ message: `线程 ${n}/${todo.length}` })
      await this.pageDelay(settings)
    }
    await this.save({ phase: 'detect' })
  }

  // ---------------- 阶段 4: 检测被移除的书签 ----------------
  private async detectRemoved() {
    await this.save({ phase: 'detect', message: '检测已取消的书签…' })
    const n = await markUnbookmarkedNotSeen(this.prog.run_id, this.seenInBookmarks)
    if (n === -1) await this.save({ message: '已抓取数量异常偏少, 跳过"已取消书签"检测' })
    else await this.save({ message: n ? `标记 ${n} 条已取消书签 (本地保留)` : undefined })
  }
}
