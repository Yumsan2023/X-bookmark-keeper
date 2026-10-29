import type { AuthInfo } from '@/shared/types'
import { XApiError } from './errors'
import { BOOKMARK_FEATURES, COMMON_FEATURES, TWEET_DETAIL_FIELD_TOGGLES, USER_FEATURES, parseMissingFeatures } from './features'
import { buildUrl, type OperationName } from './endpoints'

export interface RateLimitInfo {
  limit: number
  remaining: number
  /** 秒级时间戳 */
  reset: number
  updated_at: number
}

export interface ClientDeps {
  getAuth(): Promise<AuthInfo | null>
  getQueryId(op: OperationName): Promise<string>
  /** queryId 失效时调用, 返回是否拿到了新值 */
  refreshQueryIds?(): Promise<boolean>
  onRateLimit?(op: OperationName, info: RateLimitInfo): void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  variables: Record<string, unknown>
  features?: Record<string, boolean>
  fieldToggles?: Record<string, boolean>
}

export class XClient {
  /** 运行期补充的 feature (来自服务端 "cannot be null" 报错), 之后的请求也会带上 */
  private extraFeatures: Record<string, boolean> = {}

  constructor(private deps: ClientDeps) {}

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeout = this.deps.timeoutMs ?? 15000
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      return await (this.deps.fetchImpl ?? fetch)(url, { ...init, signal: ctrl.signal })
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new XApiError('timeout', `请求超时 (${timeout}ms)`)
      throw new XApiError('network', e?.message || 'network error')
    } finally {
      clearTimeout(timer)
    }
  }

  async request<T = any>(op: OperationName, opts: RequestOptions, retried = { qid: false, feat: 0 }): Promise<T> {
    const auth = await this.deps.getAuth()
    if (!auth?.token || !auth.csrf) {
      throw new XApiError('auth', '未捕获到登录凭证: 请先在已登录的浏览器中打开 x.com/i/bookmarks 并刷新一次')
    }
    const queryId = await this.deps.getQueryId(op)
    const method = opts.method ?? 'GET'
    const features = { ...(opts.features ?? {}), ...this.extraFeatures }
    let url = buildUrl(op, queryId)
    const headers: Record<string, string> = {
      authorization: auth.token,
      'x-csrf-token': auth.csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'content-type': 'application/json',
    }
    if (auth.uuid) headers['x-client-uuid'] = auth.uuid
    if (auth.transaction_id) headers['x-client-transaction-id'] = auth.transaction_id

    const init: RequestInit = { method, credentials: 'include', headers }
    if (method === 'GET') {
      const q = new URLSearchParams()
      q.set('variables', JSON.stringify(opts.variables))
      if (Object.keys(features).length) q.set('features', JSON.stringify(features))
      if (opts.fieldToggles) q.set('fieldToggles', JSON.stringify(opts.fieldToggles))
      url += `?${q.toString()}`
    } else {
      init.body = JSON.stringify({
        variables: opts.variables,
        ...(Object.keys(features).length ? { features } : {}),
        queryId,
      })
    }

    const res = await this.fetchWithTimeout(url, init)
    const limit = res.headers.get('x-rate-limit-limit')
    const remaining = res.headers.get('x-rate-limit-remaining')
    const reset = res.headers.get('x-rate-limit-reset')
    if (limit && remaining && reset) {
      this.deps.onRateLimit?.(op, {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        updated_at: Date.now(),
      })
    }

    if (res.status === 401 || res.status === 403) {
      throw new XApiError('auth', `鉴权失败 (HTTP ${res.status}): 请确认已在浏览器登录 X, 并刷新 x.com 页面以重新捕获凭证`, { status: res.status })
    }
    if (res.status === 429) {
      const resetAt = reset ? parseInt(reset, 10) * 1000 : Date.now() + 15 * 60_000
      throw new XApiError('rate_limit', '触发限流 (HTTP 429)', { resetAt, status: 429 })
    }
    if (res.status === 204) return undefined as T

    // queryId 失效: X 对未知 queryId 通常返回 404
    if (res.status === 404 && !retried.qid && this.deps.refreshQueryIds) {
      if (await this.deps.refreshQueryIds()) return this.request<T>(op, opts, { ...retried, qid: true })
      throw new XApiError('query_id', `${op} 的 queryId 可能已失效 (HTTP 404), 自动刷新失败`, { status: 404 })
    }

    let text = ''
    try {
      text = await res.text()
    } catch (e: any) {
      throw new XApiError('network', e?.message || 'read body failed')
    }

    if (res.status === 400) {
      const missing = parseMissingFeatures(text)
      if (missing.length && retried.feat < 3) {
        for (const f of missing) this.extraFeatures[f] = false
        return this.request<T>(op, opts, { ...retried, feat: retried.feat + 1 })
      }
      if (/GRAPHQL_VALIDATION_FAILED|PersistedQueryNotFound|query id/i.test(text) && !retried.qid && this.deps.refreshQueryIds) {
        if (await this.deps.refreshQueryIds()) return this.request<T>(op, opts, { ...retried, qid: true })
        throw new XApiError('query_id', `${op} 的 queryId 可能已失效 (HTTP 400)`, { status: 400 })
      }
    }
    if (res.status >= 400) {
      throw new XApiError('data', `HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status })
    }

    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new XApiError('data', '响应不是合法 JSON (可能被重定向到登录页)')
    }
    if (json?.errors?.length && !json.data) {
      const msg = json.errors.map((e: any) => e.message).join('; ')
      if (/authorization|not authorized|login/i.test(msg)) throw new XApiError('auth', msg)
      throw new XApiError('data', msg)
    }
    return json as T
  }

  // ---------------- 具体接口 ----------------

  getBookmarks(cursor?: string, count = 100) {
    return this.request('Bookmarks', {
      variables: { count, includePromotedContent: true, ...(cursor ? { cursor } : {}) },
      features: BOOKMARK_FEATURES,
    })
  }

  getFolders(cursor?: string) {
    return this.request('BookmarkFoldersSlice', {
      variables: cursor ? { cursor } : {},
      features: BOOKMARK_FEATURES,
    })
  }

  getFolderTimeline(folderId: string, cursor?: string) {
    return this.request('BookmarkFolderTimeline', {
      variables: {
        bookmark_collection_id: folderId,
        includePromotedContent: true,
        ...(cursor ? { cursor } : {}),
      },
      features: BOOKMARK_FEATURES,
    })
  }

  getTweetDetail(tweetId: string, cursor?: string) {
    return this.request('TweetDetail', {
      variables: {
        focalTweetId: tweetId,
        with_rux_injections: false,
        rankingMode: 'Relevance',
        includePromotedContent: true,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
        ...(cursor ? { cursor } : {}),
      },
      features: COMMON_FEATURES,
      fieldToggles: TWEET_DETAIL_FIELD_TOGGLES,
    })
  }

  /** 取消 X 端书签 */
  deleteBookmark(tweetId: string) {
    return this.request('DeleteBookmark', { method: 'POST', variables: { tweet_id: tweetId } })
  }

  /** 把书签放入 X 端文件夹 (best-effort, 未经验证) */
  addToFolder(tweetId: string, folderId: string) {
    return this.request('bookmarkTweetToFolder', {
      method: 'POST',
      variables: { tweet_id: tweetId, bookmark_collection_id: folderId },
    })
  }

  removeFromFolder(tweetId: string, folderId: string) {
    return this.request('RemoveTweetFromBookmarkFolder', {
      method: 'POST',
      variables: { tweet_id: tweetId, bookmark_collection_id: folderId },
    })
  }

  /** 按 screen_name 解析 userId */
  getUserByScreenName(screenName: string) {
    return this.request('UserByScreenName', {
      variables: {
        screen_name: screenName.replace(/^@/, ''),
        withSafetyModeUserFields: true,
      },
      features: USER_FEATURES,
      fieldToggles: { withAuxiliaryUserLabels: false },
    })
  }

  /** 用户公开发帖时间线 (UserTweets), cursor 翻页 */
  getUserTweets(userId: string, cursor?: string, count = 100) {
    return this.request('UserTweets', {
      variables: {
        userId,
        count,
        includePromotedContent: true,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
        ...(cursor ? { cursor } : {}),
      },
      features: USER_FEATURES,
      fieldToggles: { withArticlePlainText: false },
    })
  }

  /**
   * 用当前会话拉账号设置, 拿到自己的 screen_name。
   * 走 REST /1.1/account/settings.json (与 GraphQL 共用鉴权头与 cookie)。
   */
  async getAccountSettings(): Promise<{ screen_name: string }> {
    const auth = await this.deps.getAuth()
    if (!auth?.token || !auth.csrf) {
      throw new XApiError('auth', '未捕获到登录凭证: 请先在已登录的浏览器中打开 x.com 并刷新一次')
    }
    const headers: Record<string, string> = {
      authorization: auth.token,
      'x-csrf-token': auth.csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
    }
    if (auth.uuid) headers['x-client-uuid'] = auth.uuid
    if (auth.transaction_id) headers['x-client-transaction-id'] = auth.transaction_id
    const url = 'https://x.com/i/api/1.1/account/settings.json'
    const timeout = this.deps.timeoutMs ?? 15000
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    let res: Response
    try {
      res = await (this.deps.fetchImpl ?? fetch)(url, { method: 'GET', credentials: 'include', headers, signal: ctrl.signal })
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new XApiError('timeout', `请求超时 (${timeout}ms)`)
      throw new XApiError('network', e?.message || 'network error')
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 401 || res.status === 403) {
      throw new XApiError('auth', `鉴权失败 (HTTP ${res.status})`, { status: res.status })
    }
    if (res.status === 429) {
      const reset = res.headers.get('x-rate-limit-reset')
      const resetAt = reset ? parseInt(reset, 10) * 1000 : Date.now() + 15 * 60_000
      throw new XApiError('rate_limit', '触发限流 (HTTP 429)', { resetAt, status: 429 })
    }
    if (res.status >= 400) {
      const text = await res.text().catch(() => '')
      throw new XApiError('data', `HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status })
    }
    const json = await res.json()
    const screen_name = String(json?.screen_name ?? '').replace(/^@/, '')
    if (!screen_name) throw new XApiError('data', 'account/settings 未返回 screen_name')
    return { screen_name }
  }
}
