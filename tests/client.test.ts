import { describe, expect, it, vi } from 'vitest'
import { XClient } from '@/api/client'
import { XApiError } from '@/api/errors'
import { parseMissingFeatures } from '@/api/features'
import { extractBundleUrls, extractQueryIds } from '@/api/queryid-discovery'
import { parseGraphqlUrl, buildUrl, DEFAULT_QUERY_IDS } from '@/api/endpoints'
import { extractAuthFromHeaders, learnQueryId } from '@/background/auth-capture'

const auth = { token: 'Bearer AAA', csrf: 'csrf1', uuid: 'uuid1', transaction_id: 'tx1', captured_at: 1 }

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

function mk(fetchImpl: any, extra: Partial<ConstructorParameters<typeof XClient>[0]> = {}) {
  return new XClient({
    getAuth: async () => auth,
    getQueryId: async (op) => DEFAULT_QUERY_IDS[op],
    fetchImpl,
    ...extra,
  })
}

describe('XClient', () => {
  it('sends auth headers, credentials include, GET with variables/features in query', async () => {
    const f = vi.fn(async () => res(200, { data: { ok: 1 } }, { 'x-rate-limit-limit': '500', 'x-rate-limit-remaining': '499', 'x-rate-limit-reset': '1999999999' }))
    const onRateLimit = vi.fn()
    const c = mk(f, { onRateLimit })
    await c.getBookmarks('CUR', 100)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith(`https://x.com/i/api/graphql/${DEFAULT_QUERY_IDS.Bookmarks}/Bookmarks?`)).toBe(true)
    const q = new URL(url).searchParams
    expect(JSON.parse(q.get('variables')!)).toMatchObject({ cursor: 'CUR', count: 100 })
    expect(JSON.parse(q.get('features')!).graphql_timeline_v2_bookmark_timeline).toBe(true)
    expect(init.credentials).toBe('include')
    const h = init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer AAA')
    expect(h['x-csrf-token']).toBe('csrf1')
    expect(h['x-client-uuid']).toBe('uuid1')
    expect(h['x-client-transaction-id']).toBe('tx1')
    expect(h['x-twitter-auth-type']).toBe('OAuth2Session')
    expect(h['x-twitter-active-user']).toBe('yes')
    expect(onRateLimit).toHaveBeenCalledWith('Bookmarks', expect.objectContaining({ limit: 500, remaining: 499, reset: 1999999999 }))
  })

  it('POST body carries variables and queryId (DeleteBookmark)', async () => {
    const f = vi.fn(async () => res(200, { data: { tweet_bookmark_delete: 'Done' } }))
    await mk(f).deleteBookmark('42')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(buildUrl('DeleteBookmark', DEFAULT_QUERY_IDS.DeleteBookmark))
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ variables: { tweet_id: '42' }, queryId: DEFAULT_QUERY_IDS.DeleteBookmark })
  })

  it('throws auth error without credentials', async () => {
    const c = new XClient({ getAuth: async () => null, getQueryId: async () => 'x', fetchImpl: vi.fn() as any })
    await expect(c.getBookmarks()).rejects.toMatchObject({ code: 'auth' })
  })

  it('maps 401/403 to auth, 429 to rate_limit with reset time', async () => {
    await expect(mk(async () => res(403)).getBookmarks()).rejects.toMatchObject({ code: 'auth' })
    const e = await mk(async () => res(429, {}, { 'x-rate-limit-reset': '2000000000' })).getBookmarks().catch((x) => x)
    expect(e).toBeInstanceOf(XApiError)
    expect(e.code).toBe('rate_limit')
    expect(e.resetAt).toBe(2000000000 * 1000)
  })

  it('treats 404 as stale queryId: refreshes once and retries with new id', async () => {
    let id = 'OLD'
    const f = vi.fn(async (url: string) => (url.includes('/OLD/') ? res(404, 'not found') : res(200, { data: { ok: true } })))
    const refresh = vi.fn(async () => {
      id = 'NEW'
      return true
    })
    const c = new XClient({ getAuth: async () => auth, getQueryId: async () => id, refreshQueryIds: refresh, fetchImpl: f as any })
    const r = await c.getBookmarks()
    expect(r).toEqual({ data: { ok: true } })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('reports query_id error when refresh yields nothing', async () => {
    const c = mk(async () => res(404, ''), { refreshQueryIds: async () => false })
    await expect(c.getBookmarks()).rejects.toMatchObject({ code: 'query_id' })
  })

  it('retries 400 "features cannot be null" with the missing flags set to false', async () => {
    const f = vi.fn(async (url: string) => {
      const feats = JSON.parse(new URL(url).searchParams.get('features') ?? '{}')
      if (!('brand_new_flag' in feats)) return res(400, '{"errors":[{"message":"The following features cannot be null: brand_new_flag, other_flag"}]}')
      return res(200, { data: { ok: true } })
    })
    const c = mk(f)
    expect((await c.getBookmarks()).data.ok).toBe(true)
    // 之后的请求直接带上
    await c.getBookmarks()
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('maps timeouts and network failures', async () => {
    const slow = (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await expect(mk(slow as any, { timeoutMs: 20 }).getBookmarks()).rejects.toMatchObject({ code: 'timeout' })
    await expect(mk(async () => { throw new TypeError('Failed to fetch') }).getBookmarks()).rejects.toMatchObject({ code: 'network' })
  })

  it('errors-only body -> data error; errors with data are tolerated', async () => {
    await expect(mk(async () => res(200, { errors: [{ message: 'boom' }] })).getBookmarks()).rejects.toMatchObject({ code: 'data', message: 'boom' })
    await expect(mk(async () => res(200, { data: { a: 1 }, errors: [{ message: 'partial' }] })).getBookmarks()).resolves.toBeTruthy()
    await expect(mk(async () => res(200, '<html>login</html>')).getBookmarks()).rejects.toMatchObject({ code: 'data' })
  })
})

describe('features', () => {
  it('parseMissingFeatures', () => {
    expect(parseMissingFeatures('The following features cannot be null: a_b, c_d')).toEqual(['a_b', 'c_d'])
    expect(parseMissingFeatures('nothing')).toEqual([])
  })
})

describe('queryId discovery', () => {
  it('extracts ids in both property orders and ignores unknown operations', () => {
    const js = `a={queryId:"UyNF_BgJ5d5MbtuVukyl7A",operationName:"Bookmarks",operationType:"query",metadata:{}},
      b={operationName:"BookmarkFoldersSlice",operationType:"query",queryId:"FOLDERS_QUERY_ID_123",metadata:{}},
      c={queryId:"ZZZZZZZZZZZZZZZZZZZZZZ",operationName:"SomethingElse"}`
    expect(extractQueryIds(js)).toEqual({ Bookmarks: 'UyNF_BgJ5d5MbtuVukyl7A', BookmarkFoldersSlice: 'FOLDERS_QUERY_ID_123' })
  })
  it('finds bundle urls in html', () => {
    const html = '<script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script><script src="https://abs.twimg.com/responsive-web/client-web-legacy/polyfills.zz.js"></script>'
    expect(extractBundleUrls(html)).toEqual([
      'https://abs.twimg.com/responsive-web/client-web/main.abc123.js',
      'https://abs.twimg.com/responsive-web/client-web-legacy/polyfills.zz.js',
    ])
  })
  it('parseGraphqlUrl', () => {
    expect(parseGraphqlUrl('https://x.com/i/api/graphql/abc-DEF_1/Bookmarks?variables=%7B%7D')).toEqual({ queryId: 'abc-DEF_1', op: 'Bookmarks' })
    expect(parseGraphqlUrl('https://x.com/home')).toBeNull()
  })
})

describe('auth capture', () => {
  it('extracts bearer, csrf, uuid and transaction id (case-insensitive)', () => {
    const a = extractAuthFromHeaders(
      [
        { name: 'Authorization', value: 'Bearer XYZ' },
        { name: 'X-Csrf-Token', value: 'abc' },
        { name: 'x-client-uuid', value: 'u-1' },
        { name: 'X-Client-Transaction-Id', value: 'tx' },
      ],
      99,
    )
    expect(a).toEqual({ token: 'Bearer XYZ', csrf: 'abc', uuid: 'u-1', transaction_id: 'tx', captured_at: 99 })
  })
  it('rejects incomplete / non bearer', () => {
    expect(extractAuthFromHeaders([{ name: 'authorization', value: 'Bearer A' }])).toBeNull()
    expect(extractAuthFromHeaders([{ name: 'authorization', value: 'Basic A' }, { name: 'x-csrf-token', value: 'c' }])).toBeNull()
    expect(extractAuthFromHeaders(undefined)).toBeNull()
  })
  it('learns query ids only for known operations', () => {
    expect(learnQueryId('https://x.com/i/api/graphql/NEWID_abc/Bookmarks?x=1')).toEqual({ op: 'Bookmarks', queryId: 'NEWID_abc' })
    expect(learnQueryId('https://x.com/i/api/graphql/NEWID_abc/HomeTimeline')).toBeNull()
  })
})
