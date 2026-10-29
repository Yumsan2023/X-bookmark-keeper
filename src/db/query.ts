/**
 * IndexedDB 分页查询: 空关键字/仅过滤时走索引 + offset/limit, 避免 toArray 全表。
 */
import type { Collection } from 'dexie'
import type { Post, PostStatus } from '@/shared/types'
import { NO_FOLDER, type HasKind, type ParsedQuery } from '@/search/query-parser'
import type { Filters, SortKey } from '@/search/engine'
import { matchesFilters } from '@/search/engine'
import { db } from './db'

export interface PageOpts {
  offset: number
  limit: number
  sort?: SortKey
  parsed?: ParsedQuery
  filters?: Filters
}

export interface PageResult {
  posts: Post[]
  total: number
}

function emptyParsed(): ParsedQuery {
  return { terms: [], phrases: [], excludes: [], from: [], folders: [], has: [], tags: [], warnings: [] }
}

function comparator(sort: SortKey): (a: Post, b: Post) => number {
  switch (sort) {
    case 'saved_asc':
      return (a, b) => (a.sort_index < b.sort_index ? -1 : a.sort_index > b.sort_index ? 1 : 0)
    case 'saved_desc':
    case 'relevance':
      return (a, b) => (a.sort_index < b.sort_index ? 1 : a.sort_index > b.sort_index ? -1 : 0)
    case 'created_asc':
      return (a, b) => a.created_at - b.created_at
    case 'created_desc':
      return (a, b) => b.created_at - a.created_at
    case 'likes_desc':
      return (a, b) => b.metrics.likes - a.metrics.likes
    case 'views_desc':
      return (a, b) => b.metrics.views - a.metrics.views
  }
}

/** 尝试用最有选择性的索引开局 */
function indexedCollection(parsed: ParsedQuery, filters: Filters): Collection<Post, string> | null {
  const tags = [...parsed.tags, ...(filters.tags ?? [])]
  if (tags.length === 1) return db.posts.where('tags').equals(tags[0])

  const folders = [...parsed.folders, ...(filters.folders ?? [])]
  if (folders.length === 1 && folders[0] !== NO_FOLDER) return db.posts.where('folder').equals(folders[0])
  if (folders.length === 1 && folders[0] === NO_FOLDER) return db.posts.where('folder').equals('')

  const authors = [
    ...parsed.from,
    ...(filters.authors ?? []).map((a) => a.replace(/^@/, '').toLowerCase()),
  ]
  if (authors.length === 1) return db.posts.where('screen_name').equalsIgnoreCase(authors[0])

  const status = (parsed.status ?? (filters.status && filters.status !== 'all' ? filters.status : undefined)) as
    | PostStatus
    | undefined
  if (status) return db.posts.where('status').equals(status)

  const has = [...parsed.has, ...(filters.has ?? [])]
  if (has.length === 1) {
    const k = has[0] as HasKind
    if (k === 'image') return db.posts.where('has_image').equals(1)
    if (k === 'video') return db.posts.where('has_video').equals(1)
    if (k === 'link') return db.posts.where('has_link').equals(1)
    if (k === 'quote') return db.posts.where('has_quote').equals(1)
  }
  return null
}

function orderSpec(sort: SortKey | undefined): { field: 'sort_index' | 'created_at'; reverse: boolean } | null {
  switch (sort ?? 'saved_desc') {
    case 'saved_desc':
    case 'relevance':
      return { field: 'sort_index', reverse: true }
    case 'saved_asc':
      return { field: 'sort_index', reverse: false }
    case 'created_desc':
      return { field: 'created_at', reverse: true }
    case 'created_asc':
      return { field: 'created_at', reverse: false }
    default:
      return null // likes/views → 内存
  }
}

/**
 * 无全文关键字时的分页。
 * - 无过滤: orderBy + offset/limit (O(page))
 * - 有索引过滤且结果 ≤5000: 拉子集内存排序分页
 * - 否则: 按排序字段流式扫描 + matchesFilters
 */
export async function pagePostsNoText(opts: PageOpts): Promise<PageResult> {
  const parsed = opts.parsed ?? emptyParsed()
  const filters = opts.filters ?? {}
  const sort = opts.sort ?? 'saved_desc'
  const offset = Math.max(0, opts.offset)
  const limit = Math.max(1, opts.limit)
  const pass = (p: Post) => matchesFilters(p, parsed, filters)
  const hasFilterHints =
    parsed.from.length +
      parsed.folders.length +
      parsed.has.length +
      parsed.tags.length +
      (parsed.status ? 1 : 0) +
      (parsed.since != null || parsed.until != null ? 1 : 0) +
      (parsed.excludes.length ? 1 : 0) +
      (filters.authors?.length ?? 0) +
      (filters.folders?.length ?? 0) +
      (filters.has?.length ?? 0) +
      (filters.tags?.length ?? 0) +
      (filters.status && filters.status !== 'all' ? 1 : 0) +
      (filters.since != null || filters.until != null ? 1 : 0) >
    0

  const ord = orderSpec(sort)
  const indexed = indexedCollection(parsed, filters)

  // 快路径: 无任何过滤
  if (!hasFilterHints && ord) {
    let coll = db.posts.orderBy(ord.field)
    if (ord.reverse) coll = coll.reverse()
    const total = await db.posts.count()
    const posts = await coll.offset(offset).limit(limit).toArray()
    return { posts, total }
  }

  // 索引子集较小: 内存过滤排序
  if (indexed) {
    const approx = await indexed.count()
    if (approx <= 5000 || !ord) {
      let all = (await indexed.toArray()).filter(pass)
      all.sort(comparator(sort))
      return { posts: all.slice(offset, offset + limit), total: all.length }
    }
  }

  // 流式: 按排序字段遍历, 过滤后取页
  if (ord) {
    let coll = db.posts.orderBy(ord.field)
    if (ord.reverse) coll = coll.reverse()
    const posts: Post[] = []
    let matched = 0
    await coll.each((p) => {
      if (!pass(p)) return
      if (matched >= offset && posts.length < limit) posts.push(p)
      matched++
    })
    return { posts, total: matched }
  }

  // likes/views: 必须全量过滤后排
  const base = indexed ?? db.posts.toCollection()
  let all = (await base.filter(pass).toArray())
  all.sort(comparator(sort))
  return { posts: all.slice(offset, offset + limit), total: all.length }
}

export async function countUnfiled(): Promise<number> {
  return db.posts.where('folder').equals('').count()
}

/** 分批读取全表 (导出/建索引), 每批 yield */
export async function* iteratePostsBatches(batchSize = 3000): AsyncGenerator<Post[], void, unknown> {
  const total = await db.posts.count()
  for (let offset = 0; offset < total; ) {
    const batch = await db.posts.orderBy('tweet_id').offset(offset).limit(batchSize).toArray()
    if (!batch.length) break
    offset += batch.length
    yield batch
  }
}
