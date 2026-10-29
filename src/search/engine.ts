import MiniSearch from 'minisearch'
import type { Post, PostSource } from '@/shared/types'
import { postSource } from '@/shared/types'
import { NO_FOLDER, parseQuery, type HasKind, type ParsedQuery, type SourceFilter, type StatusFilter } from './query-parser'
import { tokenize } from './tokenizer'

export type SortKey = 'relevance' | 'saved_desc' | 'saved_asc' | 'created_desc' | 'created_asc' | 'likes_desc' | 'views_desc'

/** UI 过滤面板的结构化过滤 (与查询语法里的过滤取 AND) */
export interface Filters {
  authors?: string[]
  since?: number
  until?: number
  /** NO_FOLDER 表示未归类 */
  folders?: string[]
  has?: HasKind[]
  tags?: string[]
  status?: StatusFilter | 'all'
  source?: SourceFilter | 'all'
}

export interface SearchInput {
  query: string
  filters?: Filters
  sort?: SortKey
}

export interface Hit {
  post: Post
  score: number
  /** 用于高亮的词 */
  terms: string[]
}

export interface SearchResult {
  hits: Hit[]
  total: number
  parsed: ParsedQuery
  highlightTerms: string[]
}

interface IndexDoc {
  id: string
  text: string
  author: string
  tags: string
  folder: string
  extra: string
}

function toDoc(p: Post): IndexDoc {
  return {
    id: p.tweet_id,
    text: p.text,
    author: `${p.name} ${p.screen_name}`,
    tags: (p.tags ?? []).join(' '),
    folder: p.folder ?? '',
    extra: [p.quoted?.text, p.note, ...(p.thread ?? []).map((t) => t.text), ...(p.urls ?? [])].filter(Boolean).join('\n'),
  }
}

const INDEX_OPTS = {
  fields: ['text', 'author', 'tags', 'folder', 'extra'],
  storeFields: [] as string[],
  idField: 'id',
  tokenize,
  searchOptions: { tokenize, boost: { tags: 2, author: 1.5, text: 1, folder: 1, extra: 0.6 } },
}

function newIndex() {
  return new MiniSearch<IndexDoc>(INDEX_OPTS)
}

function searchableText(p: Post): string {
  return [p.text, p.name, p.screen_name, (p.tags ?? []).join(' '), p.folder, p.quoted?.text, p.note, ...(p.thread ?? []).map((t) => t.text)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

export function matchesFilters(p: Post, q: ParsedQuery, f: Filters = {}): boolean {
  if (q.from.length && !q.from.includes(p.screen_name.toLowerCase())) return false
  if (f.authors?.length && !f.authors.some((a) => a.replace(/^@/, '').toLowerCase() === p.screen_name.toLowerCase())) return false
  const since = Math.max(q.since ?? -Infinity, f.since ?? -Infinity)
  const until = Math.min(q.until ?? Infinity, f.until ?? Infinity)
  if (p.created_at < since || p.created_at > until) return false
  const folderOk = (list: string[]) => list.some((fo) => (fo === NO_FOLDER ? !p.folder : p.folder.toLowerCase() === fo.toLowerCase()))
  if (q.folders.length && !folderOk(q.folders)) return false
  if (f.folders?.length && !folderOk(f.folders)) return false
  const hasOk = (k: HasKind) =>
    k === 'image' ? !!p.has_image : k === 'video' ? !!p.has_video : k === 'link' ? !!p.has_link : k === 'quote' ? !!p.has_quote : !!(p.has_image || p.has_video)
  for (const k of [...q.has, ...(f.has ?? [])]) if (!hasOk(k)) return false
  const tags = (p.tags ?? []).map((t) => t.toLowerCase())
  for (const t of [...q.tags, ...(f.tags ?? [])]) if (!tags.includes(t.toLowerCase())) return false
  const status = q.status ?? (f.status && f.status !== 'all' ? f.status : undefined)
  if (status && p.status !== status) return false
  const src = q.source ?? (f.source && f.source !== 'all' ? f.source : undefined)
  if (src && postSource(p) !== src) return false
  return true
}

export function yieldToMain(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: 50 })
    } else {
      setTimeout(resolve, ms)
    }
  })
}

export class SearchEngine {
  private index = newIndex()
  private posts = new Map<string, Post>()
  private _ready = false

  constructor(posts: Post[] = []) {
    if (posts.length) this.setPosts(posts)
  }

  get size() {
    return this.posts.size || this.index.documentCount
  }

  get ready() {
    return this._ready
  }

  get documentCount() {
    return this.index.documentCount
  }

  setPosts(posts: Post[]) {
    this.index = newIndex()
    this.posts = new Map(posts.map((p) => [p.tweet_id, p]))
    this.index.addAll(posts.map(toDoc))
    this._ready = true
  }

  /** 清空索引与缓存 (重建前调用) */
  clear() {
    this.index = newIndex()
    this.posts = new Map()
    this._ready = false
  }

  /** 分批追加文档到索引; 不强制缓存 Post (大库模式) */
  addBatch(posts: Post[], cachePosts = false) {
    this.index.addAll(posts.map(toDoc))
    if (cachePosts) {
      for (const p of posts) this.posts.set(p.tweet_id, p)
    }
  }

  markReady() {
    this._ready = true
  }

  upsert(p: Post) {
    if (this.index.has(p.tweet_id)) this.index.discard(p.tweet_id)
    this.posts.set(p.tweet_id, p)
    this.index.add(toDoc(p))
  }

  remove(id: string) {
    this.posts.delete(id)
    if (this.index.has(id)) this.index.discard(id)
  }

  allPosts(): Post[] {
    return [...this.posts.values()]
  }

  getCached(id: string): Post | undefined {
    return this.posts.get(id)
  }

  /** 序列化 MiniSearch 供 IndexedDB 持久化 */
  toJSON(): object {
    return this.index.toJSON()
  }

  /** 从持久化 JSON 恢复索引 (不恢复 posts 缓存) */
  async loadFromJSON(json: object): Promise<void> {
    this.index = await MiniSearch.loadJSAsync<IndexDoc>(json as any, INDEX_OPTS)
    this.posts = new Map()
    this._ready = true
  }

  /**
   * 仅用 MiniSearch 检索 id+score (大库模式, 不依赖 posts Map)。
   * 子串/短语补充需调用方对候选 Post 再过滤。
   */
  searchIndex(parsed: ParsedQuery): { id: string; score: number; terms: string[] }[] {
    if (!parsed.terms.length && !parsed.phrases.length) return []
    const scored = new Map<string, { id: string; score: number; terms: string[] }>()
    if (parsed.terms.length) {
      const ms = this.index.search(parsed.terms.join(' '), {
        prefix: true,
        fuzzy: (term) => (term.length >= 5 && /^[a-z]+$/.test(term) ? 0.2 : false),
        combineWith: 'AND',
      })
      for (const r of ms) scored.set(String(r.id), { id: String(r.id), score: r.score, terms: r.terms })
      if (!scored.size && parsed.terms.length > 1) {
        for (const r of this.index.search(parsed.terms.join(' '), { prefix: true, combineWith: 'OR' })) {
          scored.set(String(r.id), { id: String(r.id), score: r.score * 0.3, terms: r.terms })
        }
      }
    }
    // 仅短语、无 terms: 退回空, 由调用方做子串扫描
    return [...scored.values()]
  }

  search(input: SearchInput): SearchResult {
    const parsed = parseQuery(input.query)
    const filters = input.filters ?? {}
    const sort = input.sort ?? 'relevance'
    const hasText = parsed.terms.length + parsed.phrases.length > 0
    const highlightTerms = [...parsed.terms, ...parsed.phrases]
    let hits: Hit[] = []

    const passes = (p: Post) =>
      matchesFilters(p, parsed, filters) && !parsed.excludes.some((ex) => searchableText(p).includes(ex))

    if (!hasText) {
      for (const p of this.posts.values()) if (passes(p)) hits.push({ post: p, score: 0, terms: [] })
    } else {
      const scored = new Map<string, Hit>()
      // 1) MiniSearch: 前缀 + 模糊, 词间 AND
      const ms = this.index.search(parsed.terms.join(' '), {
        prefix: true,
        fuzzy: (term) => (term.length >= 5 && /^[a-z]+$/.test(term) ? 0.2 : false),
        combineWith: 'AND',
      })
      for (const r of ms) {
        const p = this.posts.get(String(r.id))
        if (p && passes(p)) scored.set(p.tweet_id, { post: p, score: r.score, terms: r.terms })
      }
      // 2) 子串匹配补充 (中文无空格、短语、标点等), 并强制满足所有短语
      const needles = [...parsed.terms, ...parsed.phrases].map((t) => t.toLowerCase().normalize('NFKC'))
      for (const p of this.posts.values()) {
        const text = searchableText(p).normalize('NFKC')
        const phraseOk = parsed.phrases.every((ph) => text.includes(ph.toLowerCase().normalize('NFKC')))
        if (!phraseOk) {
          scored.delete(p.tweet_id)
          continue
        }
        if (!scored.has(p.tweet_id) && needles.every((n) => text.includes(n)) && passes(p)) {
          scored.set(p.tweet_id, { post: p, score: 0.5, terms: [] })
        }
      }
      hits = [...scored.values()]
      // 3) 仍然没有: 退化为 OR
      if (!hits.length && parsed.terms.length > 1) {
        for (const r of this.index.search(parsed.terms.join(' '), { prefix: true, combineWith: 'OR' })) {
          const p = this.posts.get(String(r.id))
          if (p && passes(p)) hits.push({ post: p, score: r.score * 0.3, terms: r.terms })
        }
      }
    }

    const effective: SortKey = sort === 'relevance' && !hasText ? 'saved_desc' : sort
    hits.sort(comparator(effective))
    return { hits, total: hits.length, parsed, highlightTerms }
  }
}

function comparator(sort: SortKey): (a: Hit, b: Hit) => number {
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

export { searchableText, toDoc, INDEX_OPTS }
