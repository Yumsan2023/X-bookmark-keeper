/**
 * IndexedDB 分页查询 + 大库轻量内存元数据缓存:
 * - 小库 (<= 1500 条): 直接走 Dexie 索引分页，零缓存开销
 * - 大库 (> 1500 条): 后台一次性构建轻量 PostStub 索引 (~80B/条，6 万条仅 ~5MB)，
 *   之后任意文件夹、X文章/长推文/长Quote、按年筛选、点赞/曝光排序与翻页均在 <5ms 完成，
 *   最后只对当前页可见的 30~200 条执行 db.posts.bulkGet()！
 */
import Dexie, { type Collection } from 'dexie'
import { UNKNOWN_ACCOUNT, normalizeHandle } from '@/shared/accounts'
import type { Post, PostStatus } from '@/shared/types'
import { NO_FOLDER, NO_TAG, type HasKind, type ParsedQuery } from '@/search/query-parser'
import type { Filters, SortKey } from '@/search/engine'
import { matchesFilters, yieldToMain } from '@/search/engine'
import { db } from './db'

const STUB_CACHE_THRESHOLD = 1500

interface PostStub {
  tweet_id: string
  sort_index: string
  screen_name: string
  created_at: number
  folder: string
  status: PostStatus
  source: Post['source']
  has_image: 0 | 1
  has_video: 0 | 1
  has_link: 0 | 1
  has_quote: 0 | 1
  has_article?: 0 | 1
  tags: string[]
  accounts: string[]
  likes: number
  views: number
}

let stubCache: PostStub[] | null = null
let stubCacheCount = -1
let stubBuildPromise: Promise<PostStub[]> | null = null

function toStub(p: Post): PostStub {
  return {
    tweet_id: p.tweet_id,
    sort_index: p.sort_index,
    screen_name: p.screen_name,
    created_at: p.created_at,
    folder: p.folder || '',
    status: p.status,
    source: p.source,
    has_image: p.has_image,
    has_video: p.has_video,
    has_link: p.has_link,
    has_quote: p.has_quote,
    has_article: p.has_article,
    tags: p.tags ?? [],
    accounts: p.accounts ?? [],
    likes: p.metrics?.likes ?? 0,
    views: p.metrics?.views ?? 0,
  }
}

function stubAsPost(s: PostStub): Post {
  return {
    tweet_id: s.tweet_id,
    sort_index: s.sort_index,
    user_id: '',
    screen_name: s.screen_name,
    name: '',
    avatar: '',
    created_at: s.created_at,
    saved_at: 0,
    sync_run: '',
    url: '',
    text: '',
    lang: '',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: s.likes, quotes: 0, bookmarks: 0, views: s.views },
    has_image: s.has_image,
    has_video: s.has_video,
    has_link: s.has_link,
    has_quote: s.has_quote,
    has_article: s.has_article,
    folder: s.folder,
    tags: s.tags,
    status: s.status,
    source: s.source,
    accounts: s.accounts,
  }
}

export function invalidateStubCache(): void {
  stubCache = null
  stubCacheCount = -1
}

export async function warmStubCache(): Promise<PostStub[] | null> {
  const count = await db.posts.count()
  if (count <= STUB_CACHE_THRESHOLD) return null
  if (stubCache && stubCacheCount === count) return stubCache
  if (stubBuildPromise) return stubBuildPromise
  stubBuildPromise = (async () => {
    const out: PostStub[] = []
    let n = 0
    await db.posts.each((p) => {
      out.push(toStub(p))
      n++
    })
    // 预排序为默认 saved_desc，常见查询无需二次排序
    out.sort((a, b) => (a.sort_index < b.sort_index ? 1 : a.sort_index > b.sort_index ? -1 : 0))
    stubCache = out
    stubCacheCount = n
    stubBuildPromise = null
    return out
  })().catch((e) => {
    stubBuildPromise = null
    throw e
  })
  return stubBuildPromise
}

function stubComparator(sort: SortKey): ((a: PostStub, b: PostStub) => number) | null {
  switch (sort) {
    case 'saved_desc':
    case 'relevance':
      return null // stubCache 已按 saved_desc 预排序
    case 'saved_asc':
      return (a, b) => (a.sort_index < b.sort_index ? -1 : a.sort_index > b.sort_index ? 1 : 0)
    case 'created_asc':
      return (a, b) => a.created_at - b.created_at
    case 'created_desc':
      return (a, b) => b.created_at - a.created_at
    case 'likes_desc':
      return (a, b) => b.likes - a.likes
    case 'views_desc':
      return (a, b) => b.views - a.views
  }
}

export interface YearBucket {
  key: string
  label: string
  since?: number
  until?: number
  count: number
}

/** 统计当前筛选条件（去除年份范围后）各年份书签条数，供子分类年份条瞬时展示 */
export async function countYearsForQuery(parsed: ParsedQuery, filters: Filters = {}): Promise<YearBucket[]> {
  const cleanParsed: ParsedQuery = { ...parsed, since: undefined, until: undefined }
  const cleanFilters: Filters = { ...filters, since: undefined, until: undefined }
  const stubs = stubCache && stubCache.length > 0 ? stubCache : await warmStubCache()
  const counts = new Map<string, number>()

  const tally = (createdAt: number) => {
    if (!createdAt || !Number.isFinite(createdAt)) return
    const y = new Date(createdAt).getFullYear()
    const key = y >= 2024 ? String(y) : 'older'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  if (stubs) {
    for (const s of stubs) {
      if (matchesFilters(stubAsPost(s), cleanParsed, cleanFilters)) tally(s.created_at)
    }
  } else {
    const all = await db.posts.toArray()
    for (const p of all) {
      if (matchesFilters(p, cleanParsed, cleanFilters)) tally(p.created_at)
    }
  }

  const years = [...counts.keys()]
    .filter((k) => k !== 'older')
    .sort((a, b) => Number(b) - Number(a))
  const out: YearBucket[] = []
  for (const y of years) {
    const yn = Number(y)
    out.push({
      key: y,
      label: `${y} 年`,
      since: new Date(yn, 0, 1).getTime(),
      until: new Date(yn + 1, 0, 1).getTime() - 1,
      count: counts.get(y) ?? 0,
    })
  }
  const olderCount = counts.get('older') ?? 0
  if (olderCount > 0) {
    out.push({
      key: 'older',
      label: '2023 及更早',
      since: 0,
      until: new Date(2024, 0, 1).getTime() - 1,
      count: olderCount,
    })
  }
  return out
}

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
  return { terms: [], phrases: [], excludes: [], from: [], folders: [], has: [], tags: [], authorMarks: [], excludeAuthorMarks: [], warnings: [] }
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
  const tags = [...parsed.tags, ...(filters.tags ?? [])].filter((t) => t !== NO_TAG)
  const anyTags = filters.anyTags ?? []
  // 单个标签才能走 multiEntry 索引。多个复选标签是 OR, 不能用「等于某一个」开局。
  if (tags.length === 1 && anyTags.length === 0 && !parsed.tags.includes(NO_TAG)) return db.posts.where('tags').equals(tags[0])
  if (tags.length === 0 && anyTags.length === 1 && !parsed.tags.includes(NO_TAG)) return db.posts.where('tags').equals(anyTags[0])

  const folders = [...parsed.folders, ...(filters.folders ?? [])]
  if (folders.length === 1 && folders[0] !== NO_FOLDER) return db.posts.where('folder').equals(folders[0])
  if (folders.length === 1 && folders[0] === NO_FOLDER) return db.posts.where('folder').equals('')

  const accountFilters = filters.accounts ?? []
  const namedAccounts = accountFilters.filter((a) => a !== UNKNOWN_ACCOUNT)
  if (namedAccounts.length === 1 && accountFilters.length === 1) {
    return db.posts.where('accounts').equals(normalizeHandle(namedAccounts[0]))
  }

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
      (filters.excludeTags?.length ?? 0) +
      (filters.anyTags?.length ?? 0) +
      (filters.status && filters.status !== 'all' ? 1 : 0) +
      (filters.since != null || filters.until != null ? 1 : 0) +
      (filters.accounts?.length ?? 0) +
      (parsed.authorMarks?.length ?? 0) +
      (parsed.excludeAuthorMarks?.length ?? 0) +
      (filters.authorMarks?.length ?? 0) >
    0

  const ord = orderSpec(sort)

  // 快路径 1: 无任何过滤 — 直接走 Dexie orderBy + offset/limit (O(page))
  if (!hasFilterHints && ord) {
    let coll = db.posts.orderBy(ord.field)
    if (ord.reverse) coll = coll.reverse()
    const total = await db.posts.count()
    const posts = await coll.offset(offset).limit(limit).toArray()
    return { posts, total }
  }

  // 快路径 2: 大库轻量内存 Stub 索引 — 任意文件夹/标签/年份/排序 <5ms，仅 bulkGet 当页可见条数
  const totalInDb = await db.posts.count()
  if (totalInDb > STUB_CACHE_THRESHOLD && !parsed.excludes.length) {
    const stubs = stubCache && stubCacheCount === totalInDb ? stubCache : await warmStubCache()
    if (stubs) {
      const matched = hasFilterHints
        ? stubs.filter((s) => matchesFilters(stubAsPost(s), parsed, filters))
        : stubs.slice()
      const cmp = stubComparator(sort)
      if (cmp) matched.sort(cmp)
      const sliceIds = matched.slice(offset, offset + limit).map((s) => s.tweet_id)
      const fetched = sliceIds.length ? await db.posts.bulkGet(sliceIds) : []
      const posts = fetched.filter((p): p is Post => !!p)
      return { posts, total: matched.length }
    }
  }

  // 快路径 3: 单文件夹无其他复杂条件时走 Dexie v7 [folder+sort_index] 复合索引
  const singleFolders = [...parsed.folders, ...(filters.folders ?? [])]
  if (
    singleFolders.length === 1 &&
    singleFolders[0] !== NO_FOLDER &&
    ord?.field === 'sort_index' &&
    !parsed.from.length &&
    !parsed.has.length &&
    !parsed.tags.length &&
    !parsed.excludes.length &&
    parsed.since == null &&
    parsed.until == null &&
    !(filters.tags?.length || filters.excludeTags?.length || filters.anyTags?.length || filters.accounts?.length || filters.since != null || filters.until != null)
  ) {
    const fname = singleFolders[0]
    let coll = db.posts.where('[folder+sort_index]').between([fname, Dexie.minKey], [fname, Dexie.maxKey])
    if (ord.reverse) coll = coll.reverse()
    const total = await db.posts.where('folder').equals(fname).count()
    const posts = await coll.offset(offset).limit(limit).toArray()
    return { posts, total }
  }

  const indexed = indexedCollection(parsed, filters)

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

/** 分批读取全表 (导出/建索引): 使用游标 keyset 分页 (O(N) 且并发写入不重复读), 每批 yield */
export async function* iteratePostsBatches(batchSize = 3000): AsyncGenerator<Post[], void, unknown> {
  let lastId: string | null = null
  for (;;) {
    const batch: Post[] =
      lastId === null
        ? await db.posts.orderBy('tweet_id').limit(batchSize).toArray()
        : await db.posts.where('tweet_id').above(lastId).limit(batchSize).toArray()
    if (!batch.length) break
    lastId = batch[batch.length - 1].tweet_id
    yield batch
    if (batch.length < batchSize) break
  }
}
