import type { AuthInfo } from '@/shared/types'
import { parseGraphqlUrl, OPERATIONS, type OperationName, type QueryIdMap } from '@/api/endpoints'
import { getAuth, getLearnedQueryIds, saveAuth, saveLearnedQueryIds } from '@/shared/storage'

type Header = { name: string; value?: string }

/** 纯函数: 从请求头数组里提取凭证; 缺少 authorization 或 csrf 返回 null */
export function extractAuthFromHeaders(headers: Header[] | undefined, now = Date.now()): AuthInfo | null {
  if (!headers) return null
  const map = new Map<string, string>()
  for (const h of headers) if (h.value) map.set(h.name.toLowerCase(), h.value)
  const token = map.get('authorization')
  const csrf = map.get('x-csrf-token')
  if (!token || !csrf || !/^Bearer\s/i.test(token)) return null
  return {
    token,
    csrf,
    uuid: map.get('x-client-uuid') ?? '',
    transaction_id: map.get('x-client-transaction-id') ?? '',
    captured_at: now,
  }
}

/** 纯函数: 从页面请求 URL 学习 queryId */
export function learnQueryId(url: string): { op: OperationName; queryId: string } | null {
  const p = parseGraphqlUrl(url)
  if (!p) return null
  if (!(OPERATIONS as string[]).includes(p.op)) return null
  return { op: p.op as OperationName, queryId: p.queryId }
}

let lastAuthKey = ''
let learned: QueryIdMap | null = null

export function registerAuthCapture(): void {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      // 忽略扩展自己发出的请求, 只学习 x.com 页面自己的请求
      if (details.initiator?.startsWith('chrome-extension://')) return
      void (async () => {
        const auth = extractAuthFromHeaders(details.requestHeaders as Header[])
        if (auth) {
          const key = `${auth.token}|${auth.csrf}|${auth.uuid}`
          // 凭证没变化时只刷新 transaction id, 避免频繁写 storage
          if (key !== lastAuthKey) {
            lastAuthKey = key
            await saveAuth(auth)
          } else {
            const cur = await getAuth()
            if (!cur || auth.transaction_id !== cur.transaction_id) await saveAuth(auth)
          }
        }
        const l = learnQueryId(details.url)
        if (l) {
          learned ??= await getLearnedQueryIds()
          if (learned[l.op] !== l.queryId) {
            learned[l.op] = l.queryId
            await saveLearnedQueryIds(learned)
          }
        }
      })()
    },
    {
      urls: ['https://x.com/i/api/graphql/*', 'https://twitter.com/i/api/graphql/*'],
    },
    ['requestHeaders', 'extraHeaders'],
  )
}

export async function hasAuth(): Promise<boolean> {
  const a = await getAuth()
  return !!(a?.token && a.csrf)
}
