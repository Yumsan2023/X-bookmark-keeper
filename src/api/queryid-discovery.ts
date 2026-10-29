import { OPERATIONS, type QueryIdMap, type OperationName } from './endpoints'

/**
 * 在 x.com 前端 JS bundle 文本中扫描 `queryId:"xxx",operationName:"Bookmarks"` 模式。
 * 纯函数, 有单元测试。bundle 里的写法形如:
 *   {queryId:"UyNF_BgJ5d5MbtuVukyl7A",operationName:"Bookmarks",operationType:"query",...}
 * 属性顺序可能不同, 两种顺序都处理。
 */
export function extractQueryIds(js: string): QueryIdMap {
  const out: QueryIdMap = {}
  const re1 = /queryId\s*:\s*["']([A-Za-z0-9_-]{15,30})["']\s*,\s*operationName\s*:\s*["']([A-Za-z0-9_]+)["']/g
  const re2 = /operationName\s*:\s*["']([A-Za-z0-9_]+)["']\s*,[^{}]{0,80}?queryId\s*:\s*["']([A-Za-z0-9_-]{15,30})["']/g
  const wanted = new Set<string>(OPERATIONS)
  for (const m of js.matchAll(re1)) {
    if (wanted.has(m[2])) out[m[2] as OperationName] = m[1]
  }
  for (const m of js.matchAll(re2)) {
    if (wanted.has(m[1]) && !out[m[1] as OperationName]) out[m[1] as OperationName] = m[2]
  }
  return out
}

/** 从 x.com 首页 HTML 中找出 JS bundle 地址 (abs.twimg.com/responsive-web/client-web/*.js) */
export function extractBundleUrls(html: string): string[] {
  const urls = new Set<string>()
  for (const m of html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9._~-]+\.js/g)) {
    urls.add(m[0])
  }
  return [...urls]
}

/**
 * 网络部分: 拉 x.com HTML → 拉 bundle (优先 main.*.js 和 api.*.js) → 扫描。
 * 找到全部所需 operation 即提前结束。
 */
export async function discoverQueryIds(
  fetchImpl: typeof fetch = fetch,
  maxBundles = 12,
): Promise<QueryIdMap> {
  const res = await fetchImpl('https://x.com/i/bookmarks', { credentials: 'include' })
  const html = await res.text()
  let urls = extractBundleUrls(html)
  // 含 operation 定义的 chunk 多半叫 main.* / api.* / bundle.*
  urls.sort((a, b) => score(b) - score(a))
  urls = urls.slice(0, maxBundles)
  const found: QueryIdMap = {}
  for (const u of urls) {
    try {
      const js = await (await fetchImpl(u)).text()
      Object.assign(found, extractQueryIds(js))
    } catch {
      /* 忽略单个 bundle 失败 */
    }
    if (OPERATIONS.every((op) => found[op])) break
  }
  return found
}

function score(u: string): number {
  if (/\/main\./.test(u)) return 3
  if (/\/api\./.test(u)) return 3
  if (/bundle\./.test(u)) return 2
  return 1
}
