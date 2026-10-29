import { XApiError } from '@/api/errors'
import { parseHandleOrUrl, parseUserByScreenName } from '@/api/handle'
import { parseTimelinePage, type ParsedPost } from '@/api/parser'
import { upsertFolder, upsertParsed } from '@/db/posts'
import { timelineFolder, type Settings, type SyncProgress } from '@/shared/types'

export interface TimelineApi {
  getUserByScreenName(screenName: string): Promise<any>
  getUserTweets(userId: string, cursor?: string, count?: number): Promise<any>
  getAccountSettings(): Promise<{ screen_name: string }>
}

export interface TimelineDeps {
  api: TimelineApi
  getSettings(): Promise<Settings>
  loadProgress(): Promise<SyncProgress | undefined>
  saveProgress(p: SyncProgress): Promise<void>
  onDbChanged?(): Promise<void> | void
  scheduleWake?(at: number): void
  sleep?(ms: number): Promise<void>
  random?(): number
  now?(): number
  newRunId?(): string
}

class Cancelled extends Error {}

const MAX_RETRIES = 3

export class TimelineSyncEngine {
  private running = false
  private pauseRequested = false
  private cancelRequested = false
  private resumeWaiter: (() => void) | null = null
  private prog!: SyncProgress

  constructor(private deps: TimelineDeps) {}

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
              await this.save()
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

  /** 同步指定账号公开发帖; handleOrUrl 可为 @name / name / 主页链接 */
  async start(handleOrUrl: string): Promise<SyncProgress> {
    const handle = parseHandleOrUrl(handleOrUrl)
    if (!handle) {
      const now = this.now()
      this.prog = {
        status: 'error',
        phase: 'timeline',
        mode: 'full',
        kind: 'timeline',
        run_id: `${now.toString(36)}`,
        started_at: now,
        updated_at: now,
        pages: 0,
        fetched: 0,
        added: 0,
        updated: 0,
        error: `无法解析账号: ${handleOrUrl}`,
        error_code: 'data',
      }
      await this.deps.saveProgress(this.prog)
      return this.prog
    }
    return this.run(handle)
  }

  /** 用当前登录会话解析自己的 screen_name, 再同步 */
  async startSelf(): Promise<SyncProgress> {
    if (this.running) return this.prog
    // 先占位进度, 便于 UI 立刻显示
    const now = this.now()
    this.running = true
    this.pauseRequested = false
    this.cancelRequested = false
    this.prog = {
      status: 'running',
      phase: 'timeline',
      mode: 'full',
      kind: 'timeline',
      run_id: (this.deps.newRunId ?? (() => `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`))(),
      started_at: now,
      updated_at: now,
      pages: 0,
      fetched: 0,
      added: 0,
      updated: 0,
      message: '正在解析当前登录账号…',
    }
    await this.save()
    try {
      const settings = await this.deps.getSettings()
      const { screen_name } = await this.call(() => this.deps.api.getAccountSettings())
      await this.save({ handle: screen_name, message: `当前账号 @${screen_name}` })
      await this.syncUser(screen_name, settings)
      await this.save({ status: 'done', phase: 'done', cursor: undefined, message: `同步完成 (@${screen_name})` })
    } catch (e) {
      await this.handleError(e)
    } finally {
      this.running = false
      await this.deps.onDbChanged?.()
    }
    return this.prog
  }

  private async run(handle: string): Promise<SyncProgress> {
    if (this.running) return this.prog
    this.running = true
    this.pauseRequested = false
    this.cancelRequested = false
    const settings = await this.deps.getSettings()
    const saved = await this.deps.loadProgress()
    const now = this.now()
    const canResume =
      saved &&
      saved.kind === 'timeline' &&
      saved.handle?.toLowerCase() === handle.toLowerCase() &&
      saved.status !== 'done' &&
      saved.status !== 'idle' &&
      !!saved.user_id
    if (canResume && saved) {
      this.prog = {
        ...saved,
        status: 'running',
        error: undefined,
        error_code: undefined,
        wait_until: undefined,
        message: '从断点继续',
        updated_at: now,
      }
    } else {
      this.prog = {
        status: 'running',
        phase: 'timeline',
        mode: 'full',
        kind: 'timeline',
        run_id: (this.deps.newRunId ?? (() => `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`))(),
        started_at: now,
        updated_at: now,
        pages: 0,
        fetched: 0,
        added: 0,
        updated: 0,
        handle,
        message: `解析 @${handle}…`,
      }
    }
    await this.save()
    try {
      await this.syncUser(handle, settings)
      await this.save({ status: 'done', phase: 'done', cursor: undefined, message: `同步完成 (@${this.prog.handle ?? handle})` })
    } catch (e) {
      await this.handleError(e)
    } finally {
      this.running = false
      await this.deps.onDbChanged?.()
    }
    return this.prog
  }

  private async handleError(e: unknown) {
    if (e instanceof Cancelled) {
      await this.save({ status: 'cancelled', message: '已取消 (可从断点继续)' })
    } else if (e instanceof XApiError) {
      await this.save({ status: 'error', error: e.message, error_code: e.code, message: undefined })
    } else {
      await this.save({ status: 'error', error: (e as Error)?.message ?? String(e), error_code: 'data' })
    }
  }

  private async syncUser(handle: string, settings: Settings) {
    let userId = this.prog.user_id
    let screenName = this.prog.handle ?? handle
    if (!userId) {
      const json = await this.call(() => this.deps.api.getUserByScreenName(handle))
      const u = parseUserByScreenName(json)
      if (!u) throw new XApiError('data', `无法解析用户 @${handle} (账号不存在或响应结构变化)`)
      userId = u.userId
      screenName = u.screenName
      await this.save({ user_id: userId, handle: screenName, message: `同步 @${screenName}…` })
    }

    const folder = timelineFolder(screenName)
    await upsertFolder({ name: folder, source: 'local', created_at: this.now() })

    const runId = this.prog.run_id
    let cursor = this.prog.cursor
    let fetched = this.prog.fetched
    await this.save({ phase: 'timeline', folder })

    for (;;) {
      await this.checkpoint()
      const json = await this.call(() => this.deps.api.getUserTweets(userId!, cursor, settings.pageSize))
      const page = parseTimelinePage(json)
      if (!page.recognized) {
        throw new XApiError('data', '无法识别 UserTweets 响应结构 (X 可能改版), 请查看 README')
      }
      const tweets = page.entries
        .filter((e): e is { kind: 'tweet'; post: ParsedPost } => e.kind === 'tweet')
        .map((e) => e.post)
      const r = await upsertParsed(tweets, runId, {
        folder,
        keepSortIndex: false,
        source: 'timeline',
      })
      fetched += tweets.length
      const nextCursor = page.cursor && page.cursor !== cursor ? page.cursor : undefined
      await this.save({
        pages: this.prog.pages + 1,
        fetched,
        added: this.prog.added + r.added,
        updated: this.prog.updated + r.updated,
        cursor: nextCursor,
        message: `@${screenName}: 已抓取 ${fetched} 条`,
      })
      await this.deps.onDbChanged?.()
      if (!tweets.length) break
      if (!nextCursor) break
      cursor = nextCursor
      await this.pageDelay(settings)
    }
    await this.save({ cursor: undefined })
  }
}
