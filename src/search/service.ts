/**
 * 大库搜索编排:
 * - 无关键字: Dexie 索引分页, 不建全库内存索引也能打开
 * - 有关键字: 优先用已就绪/持久化的 MiniSearch; 否则分批建索引并显示进度
 */
import { db } from '@/db/db'
import { getPosts, countPosts } from '@/db/posts'
import { iteratePostsBatches, pagePostsNoText } from '@/db/query'
import { STORAGE_KEYS } from '@/shared/types'
import type { Post } from '@/shared/types'
import {
  SearchEngine,
  matchesFilters,
  yieldToMain,
  type Filters,
  type Hit,
  type SearchInput,
  type SearchResult,
  type SortKey,
  searchableText,
} from './engine'
import { parseQuery, type ParsedQuery } from './query-parser'

export const INDEX_BATCH = 3000
export const SEARCH_META_KEY = 'main'

export interface PagedSearchInput extends SearchInput {
  page: number
  pageSize: number
}

export interface PagedSearchResult extends SearchResult {
  indexBuilding?: boolean
  indexProgress?: number
}

function hitComparator(sort: SortKey): (a: Hit, b: Hit) => number {
  const bySaved = (a: Hit, b: Hit) => (a.post.sort_index < b.post.sort_index ? -1 : a.post.sort_index > b.post.sort_index ? 1 : 0)
  switch (sort) {
    case 'relevance':
      return (a, b) => b.score - a.score || bySaved(b, a)
    case 'saved_desc':
      return (a, b) => bySaved(b, a)
    case 'saved_asc':
      return bySaved
    case 'created_desc':
      return (a, b) => b.post.created_at - a.post.created_at
    case 'created_asc':
      return (a, b) => a.post.created_at - b.post.created_at
    case 'likes_desc':
      return (a, b) => b.post.metrics.likes - a.post.metrics.likes
    case 'views_desc':
      return (a, b) => b.post.metrics.views - a.post.metrics.views
  }
}

async function getDbVersion(): Promise<number> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.dbVersion)
    return Number(r[STORAGE_KEYS.dbVersion] ?? 0)
  } catch {
    return 0
  }
}

/** 尝试从 IndexedDB 加载持久化索引 */
export async function tryLoadPersistedIndex(engine: SearchEngine): Promise<boolean> {
  const row = await db.searchMeta.get(SEARCH_META_KEY)
  if (!row?.indexJson) return false
  const [dbVersion, postCount] = await Promise.all([getDbVersion(), countPosts()])
  if (row.dbVersion !== dbVersion || row.postCount !== postCount) return false
  try {
    await engine.loadFromJSON(row.indexJson)
    return true
  } catch {
    return false
  }
}

export async function persistIndex(engine: SearchEngine): Promise<void> {
  const [dbVersion, postCount] = await Promise.all([getDbVersion(), countPosts()])
  await db.searchMeta.put({
    key: SEARCH_META_KEY,
    dbVersion,
    postCount,
    updatedAt: Date.now(),
    indexJson: engine.toJSON(),
  })
}

export type IndexProgressCb = (done: number, total: number) => void

/** 分批从 DB 建索引, 每批让出主线程; cachePosts=false 避免 5 万条 Post 常驻 Map */
export async function buildIndexBatched(
  engine: SearchEngine,
  onProgress?: IndexProgressCb,
  signal?: { aborted: boolean },
): Promise<void> {
  engine.clear()
  const total = await countPosts()
  let done = 0
  onProgress?.(0, total)
  for await (const batch of iteratePostsBatches(INDEX_BATCH)) {
    if (signal?.aborted) return
    engine.addBatch(batch, false)
    done += batch.length
    onProgress?.(done, total)
    await yieldToMain()
  }
  engine.markReady()
  if (!signal?.aborted) {
    try {
      await persistIndex(engine)
    } catch {
      /* 持久化失败不阻断搜索 */
    }
  }
}

function passesText(p: Post, parsed: ParsedQuery, filters: Filters): boolean {
  if (!matchesFilters(p, parsed, filters)) return false
  const text = searchableText(p)
  if (parsed.excludes.some((ex) => text.includes(ex))) return false
  return true
}

function phraseAndNeedleOk(p: Post, parsed: ParsedQuery): boolean {
  const text = searchableText(p).normalize('NFKC')
  if (!parsed.phrases.every((ph) => text.includes(ph.toLowerCase().normalize('NFKC')))) return false
  const needles = [...parsed.terms, ...parsed.phrases].map((t) => t.toLowerCase().normalize('NFKC'))
  return needles.every((n) => text.includes(n))
}

/**
 * 有关键字时: MiniSearch 取候选 id → bulkGet → 过滤/短语 → 排序分页。
 * 若索引未就绪或结果为空且含中文/短语, 分批子串扫描补充。
 */
async function searchWithText(
  engine: SearchEngine,
  input: PagedSearchInput,
  parsed: ParsedQuery,
): Promise<PagedSearchResult> {
  const filters = input.filters ?? {}
  const sort = input.sort ?? 'relevance'
  const highlightTerms = [...parsed.terms, ...parsed.phrases]
  const page = Math.max(0, input.page)
  const pageSize = Math.max(1, input.pageSize)

  const hits: Hit[] = []
  const seen = new Set<string>()

  if (engine.ready && engine.documentCount > 0 && parsed.terms.length) {
    const scored = engine.searchIndex(parsed)
    // 分块 bulkGet
    const chunk = 500
    for (let i = 0; i < scored.length; i += chunk) {
      const part = scored.slice(i, i + chunk)
      const posts = await getPosts(part.map((s) => s.id))
      const byId = new Map(posts.map((p) => [p.tweet_id, p]))
      for (const s of part) {
        const p = byId.get(s.id)
        if (!p || !passesText(p, parsed, filters)) continue
        if (parsed.phrases.length && !parsed.phrases.every((ph) => searchableText(p).normalize('NFKC').includes(ph.toLowerCase().normalize('NFKC'))))
          continue
        seen.add(p.tweet_id)
        hits.push({ post: p, score: s.score, terms: s.terms })
      }
      if (i > 0 && i % 2000 === 0) await yieldToMain()
    }
  }

  // 子串补充 / 仅短语 / 索引未覆盖: 分批扫库 (有上限保护, 让出主线程)
  const needScan = !hits.length || parsed.phrases.length > 0 || !engine.ready
  if (needScan && (parsed.terms.length || parsed.phrases.length)) {
    for await (const batch of iteratePostsBatches(INDEX_BATCH)) {
      for (const p of batch) {
        if (seen.has(p.tweet_id)) continue
        if (!passesText(p, parsed, filters)) continue
        if (!phraseAndNeedleOk(p, parsed)) continue
        seen.add(p.tweet_id)
        hits.push({ post: p, score: 0.5, terms: [] })
      }
      await yieldToMain()
    }
  }

  const effective: SortKey = sort === 'relevance' ? 'relevance' : sort
  hits.sort(hitComparator(effective))
  const start = page * pageSize
  return {
    hits: hits.slice(start, start + pageSize),
    total: hits.length,
    parsed,
    highlightTerms,
  }
}

/** 异步分页搜索 — UI 主入口 */
export async function searchPage(engine: SearchEngine, input: PagedSearchInput): Promise<PagedSearchResult> {
  const parsed = parseQuery(input.query)
  const hasText = parsed.terms.length + parsed.phrases.length > 0
  const highlightTerms = [...parsed.terms, ...parsed.phrases]
  const page = Math.max(0, input.page)
  const pageSize = Math.max(1, input.pageSize)

  if (!hasText) {
    const { posts, total } = await pagePostsNoText({
      offset: page * pageSize,
      limit: pageSize,
      sort: input.sort === 'relevance' ? 'saved_desc' : input.sort,
      parsed,
      filters: input.filters,
    })
    return {
      hits: posts.map((post) => ({ post, score: 0, terms: [] })),
      total,
      parsed,
      highlightTerms,
    }
  }

  return searchWithText(engine, input, parsed)
}

/** 收集当前筛选下的全部 Post (导出用), 分批让出主线程 */
export async function collectAllMatching(
  engine: SearchEngine,
  input: SearchInput,
  onProgress?: (done: number, total: number) => void,
): Promise<Post[]> {
  const parsed = parseQuery(input.query)
  const hasText = parsed.terms.length + parsed.phrases.length > 0
  if (!hasText) {
    const out: Post[] = []
    const pageSize = 1000
    let page = 0
    let total = Infinity
    while (out.length < total) {
      const r = await pagePostsNoText({
        offset: page * pageSize,
        limit: pageSize,
        sort: input.sort === 'relevance' ? 'saved_desc' : input.sort,
        parsed,
        filters: input.filters,
      })
      total = r.total
      out.push(...r.posts)
      onProgress?.(out.length, total)
      if (!r.posts.length) break
      page++
      await yieldToMain()
    }
    return out
  }
  return collectTextMatches(engine, parsed, input.filters ?? {}, input.sort ?? 'relevance', onProgress)
}

async function collectTextMatches(
  engine: SearchEngine,
  parsed: ParsedQuery,
  filters: Filters,
  sort: SortKey,
  onProgress?: (done: number, total: number) => void,
): Promise<Post[]> {
  const hits: Hit[] = []
  const seen = new Set<string>()
  if (engine.ready && engine.documentCount > 0 && parsed.terms.length) {
    const scored = engine.searchIndex(parsed)
    const chunk = 500
    for (let i = 0; i < scored.length; i += chunk) {
      const part = scored.slice(i, i + chunk)
      const posts = await getPosts(part.map((s) => s.id))
      const byId = new Map(posts.map((p) => [p.tweet_id, p]))
      for (const s of part) {
        const p = byId.get(s.id)
        if (!p || !passesText(p, parsed, filters)) continue
        if (parsed.phrases.length && !parsed.phrases.every((ph) => searchableText(p).normalize('NFKC').includes(ph.toLowerCase().normalize('NFKC'))))
          continue
        seen.add(p.tweet_id)
        hits.push({ post: p, score: s.score, terms: s.terms })
      }
    }
  }
  const totalEst = await countPosts()
  let scanned = 0
  for await (const batch of iteratePostsBatches(INDEX_BATCH)) {
    for (const p of batch) {
      if (seen.has(p.tweet_id)) continue
      if (!passesText(p, parsed, filters)) continue
      if (!phraseAndNeedleOk(p, parsed)) continue
      seen.add(p.tweet_id)
      hits.push({ post: p, score: 0.5, terms: [] })
    }
    scanned += batch.length
    onProgress?.(hits.length, Math.max(hits.length, Math.round((hits.length / Math.max(scanned, 1)) * totalEst)))
    await yieldToMain()
  }
  hits.sort(hitComparator(sort === 'relevance' ? 'relevance' : sort))
  onProgress?.(hits.length, hits.length)
  return hits.map((h) => h.post)
}
