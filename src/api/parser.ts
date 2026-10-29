/**
 * X GraphQL 响应 → 本地 Post 记录。全部为纯函数 (无 IO), 便于用 fixture 做单元测试。
 * 响应结构随时可能变化, 因此大量使用可选链并提供多种形态的兜底。
 */
import type { MediaItem, Post, QuotedPost, ThreadItem } from '@/shared/types'

/** 解析后尚未带本地字段 (folder/tags/status…) 的推文 */
export type ParsedPost = Omit<
  Post,
  'folder' | 'tags' | 'status' | 'saved_at' | 'sync_run' | 'note' | 'deleted_at' | 'thread' | 'thread_fetched_at'
>

export type ParsedEntry =
  | { kind: 'tweet'; post: ParsedPost }
  | { kind: 'deleted'; tweet_id: string; sort_index: string }

export interface TimelinePage {
  entries: ParsedEntry[]
  /** 下一页 (Bottom) 游标; 没有则为 undefined */
  cursor?: string
  /** 是否出现了 TimelineAddEntries 指令 (用于判断响应结构是否被识别) */
  recognized: boolean
}

export const SORT_INDEX_WIDTH = 24

export function padSortIndex(s: string | undefined | null): string {
  if (!s) return ''.padStart(SORT_INDEX_WIDTH, '0')
  return String(s).replace(/\D/g, '').padStart(SORT_INDEX_WIDTH, '0')
}

const TWITTER_EPOCH = 1288834974657n
export function snowflakeToMs(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + TWITTER_EPOCH)
  } catch {
    return 0
  }
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

type AnyObj = Record<string, any>

/** 取出真正的 Tweet 节点, 处理 TweetWithVisibilityResults 包装 */
export function unwrapTweetResult(result: AnyObj | undefined | null): AnyObj | null {
  if (!result || typeof result !== 'object') return null
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet
  if (result.tweet && !result.legacy) return result.tweet
  if (result.__typename === 'TweetTombstone' || result.__typename === 'TweetUnavailable') return null
  if (!result.legacy && !result.rest_id) return null
  return result
}

function parseUser(tweet: AnyObj) {
  const u = tweet.core?.user_results?.result ?? {}
  const legacy = u.legacy ?? {}
  return {
    user_id: String(u.rest_id ?? legacy.id_str ?? tweet.legacy?.user_id_str ?? ''),
    // 新结构把 screen_name/name 挪到 user.core.*, 头像到 user.avatar.image_url
    screen_name: String(u.core?.screen_name ?? legacy.screen_name ?? ''),
    name: String(u.core?.name ?? legacy.name ?? ''),
    avatar: String(u.avatar?.image_url ?? legacy.profile_image_url_https ?? ''),
  }
}

function pickBestVariant(variants: AnyObj[] | undefined): string | undefined {
  if (!variants?.length) return undefined
  const mp4 = variants.filter((v) => v.content_type === 'video/mp4' && v.url)
  if (!mp4.length) return variants.find((v) => v.url)?.url
  mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  return mp4[0].url
}

export function parseMedia(legacy: AnyObj | undefined): MediaItem[] {
  const list: AnyObj[] = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? []
  const out: MediaItem[] = []
  for (const m of list) {
    const type = m.type as MediaItem['type']
    if (type !== 'photo' && type !== 'video' && type !== 'animated_gif') continue
    const item: MediaItem = { type, url: String(m.media_url_https ?? m.media_url ?? '') }
    if (type !== 'photo') {
      item.video_url = pickBestVariant(m.video_info?.variants)
      if (m.video_info?.duration_millis) item.duration_ms = m.video_info.duration_millis
    }
    if (m.original_info?.width) item.width = m.original_info.width
    if (m.original_info?.height) item.height = m.original_info.height
    if (m.ext_alt_text) item.alt = String(m.ext_alt_text)
    out.push(item)
  }
  return out
}

/** 展开 t.co 短链、去掉末尾媒体链接, 返回文本与外链列表 */
export function expandText(
  rawText: string,
  urlEntities: AnyObj[] | undefined,
  mediaEntities: AnyObj[] | undefined,
): { text: string; urls: string[] } {
  let text = rawText
  const urls: string[] = []
  for (const m of mediaEntities ?? []) {
    if (m.url) text = text.split(m.url).join('')
  }
  for (const u of urlEntities ?? []) {
    const expanded = u.expanded_url || u.url
    if (u.url) text = text.split(u.url).join(expanded)
    if (expanded && !urls.includes(expanded)) urls.push(expanded)
  }
  text = decodeHtmlEntities(text).replace(/[ \t]+\n/g, '\n').trim()
  return { text, urls }
}

function extractText(tweet: AnyObj): { text: string; urls: string[] } {
  const note = tweet.note_tweet?.note_tweet_results?.result
  let base: { text: string; urls: string[] }
  if (note?.text) {
    base = expandText(note.text, note.entity_set?.urls, note.entity_set?.media ?? tweet.legacy?.entities?.media)
  } else {
    base = expandText(
      tweet.legacy?.full_text ?? tweet.legacy?.text ?? '',
      tweet.legacy?.entities?.urls,
      tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media,
    )
  }
  // 文章 (Article) 推文: 正文为空时用标题 + 摘要
  const article = tweet.article?.article_results?.result
  if (article && (article.title || article.preview_text)) {
    const extra = [article.title, article.preview_text].filter(Boolean).join('\n')
    base.text = base.text ? `${base.text}\n\n${extra}` : extra
  }
  return base
}

function toNumber(v: unknown): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : Number(v)
  return Number.isFinite(n) ? n : 0
}

function parseCreatedAt(tweet: AnyObj, id: string): number {
  const s = tweet.legacy?.created_at
  if (s) {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) return t
  }
  return snowflakeToMs(id)
}

function parseQuoted(tweet: AnyObj): QuotedPost | undefined {
  const q = unwrapTweetResult(tweet.quoted_status_result?.result)
  if (!q) return undefined
  const user = parseUser(q)
  const id = String(q.rest_id ?? q.legacy?.id_str ?? '')
  if (!id) return undefined
  return { tweet_id: id, screen_name: user.screen_name, name: user.name, text: extractText(q).text }
}


/** Detect Twitter Article node or article-like URLs */
export function detectHasArticle(tweet: AnyObj, urls: string[]): 0 | 1 {
  const article = tweet.article?.article_results?.result
  if (article && (article.title || article.preview_text || article.rest_id)) return 1
  for (const u of urls) {
    const s = String(u).toLowerCase()
    if (/\/i\/articles?\//.test(s)) return 1
    if (/x\.com\/[^/]+\/article\//.test(s) || /twitter\.com\/[^/]+\/article\//.test(s)) return 1
  }
  return 0
}

/** 把一个 Tweet 节点 (已 unwrap) 转成 ParsedPost。无法识别返回 null */
export function tweetToPost(tweet: AnyObj, sortIndex = ''): ParsedPost | null {
  const id = String(tweet.rest_id ?? tweet.legacy?.id_str ?? '')
  if (!id || !tweet.legacy) return null
  const user = parseUser(tweet)
  const { text, urls } = extractText(tweet)
  const media = parseMedia(tweet.legacy)
  const quoted = parseQuoted(tweet)
  const hasQuote = !!(quoted || tweet.legacy.is_quote_status)
  return {
    tweet_id: id,
    sort_index: padSortIndex(sortIndex || id),
    ...user,
    created_at: parseCreatedAt(tweet, id),
    text,
    lang: String(tweet.legacy.lang ?? ''),
    urls,
    media,
    quoted,
    metrics: {
      replies: toNumber(tweet.legacy.reply_count),
      retweets: toNumber(tweet.legacy.retweet_count),
      likes: toNumber(tweet.legacy.favorite_count),
      quotes: toNumber(tweet.legacy.quote_count),
      bookmarks: toNumber(tweet.legacy.bookmark_count),
      views: toNumber(tweet.views?.count),
    },
    has_image: media.some((m) => m.type === 'photo') ? 1 : 0,
    has_video: media.some((m) => m.type !== 'photo') ? 1 : 0,
    has_link: urls.length > 0 ? 1 : 0,
    has_quote: hasQuote ? 1 : 0,
    has_article: detectHasArticle(tweet, urls),
    url: `https://x.com/${user.screen_name || 'i/web'}/status/${id}`,
  }
}

// ---------------- Timeline ----------------

/** 找 instructions 数组: 优先已知路径, 否则深度搜索 */
export function findInstructions(json: AnyObj): AnyObj[] {
  const data = json?.data
  const known = [
    data?.bookmark_timeline_v2?.timeline?.instructions,
    data?.bookmark_timeline?.timeline?.instructions,
    data?.bookmark_collection_timeline?.timeline?.instructions,
    data?.threaded_conversation_with_injections_v2?.instructions,
    data?.user?.result?.timeline_v2?.timeline?.instructions,
    data?.user?.result?.timeline?.timeline?.instructions,
  ]
  for (const k of known) if (Array.isArray(k)) return k
  return deepFind(data, (key, val) => key === 'instructions' && Array.isArray(val)) ?? []
}

function deepFind(node: any, pred: (k: string, v: any) => boolean, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 8) return undefined
  for (const [k, v] of Object.entries(node)) {
    if (pred(k, v)) return v
    const r = deepFind(v, pred, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

function entryTweetId(entryId: string): string {
  const m = /^(?:tweet|bookmark-tweet|conversationthread-\d+-tweet)-(\d+)$/.exec(entryId) ?? /tweet-(\d+)/.exec(entryId)
  return m?.[1] ?? ''
}

/**
 * 解析书签 / 文件夹时间线的一页。
 * - TimelineAddEntries 中的 TimelineTimelineItem → 推文 (或已删除占位)
 * - TimelineTimelineCursor(Bottom) → 下一页游标
 */
export function parseTimelinePage(json: AnyObj): TimelinePage {
  const instructions = findInstructions(json)
  const add = instructions.find((i) => i.type === 'TimelineAddEntries')
  const entries: ParsedEntry[] = []
  let cursor: string | undefined
  if (!add) return { entries, recognized: false }
  for (const e of add.entries ?? []) {
    const content = e.content ?? {}
    if (content.entryType === 'TimelineTimelineCursor' || content.__typename === 'TimelineTimelineCursor') {
      if (content.cursorType === 'Bottom' && content.value) cursor = content.value
      continue
    }
    const item = content.itemContent ?? content.content
    if (content.entryType !== 'TimelineTimelineItem' && !item) continue
    if (item?.itemType && item.itemType !== 'TimelineTweet') continue
    if (item?.promotedMetadata || e.entryId?.startsWith?.('promoted')) continue // 广告
    const result = item?.tweet_results?.result
    const tweet = unwrapTweetResult(result)
    const idFromEntry = entryTweetId(String(e.entryId ?? ''))
    if (!tweet) {
      // 推文已删除 / 不可见: 保留占位 id, 供上层标记 deleted
      if (idFromEntry && (result === undefined || result?.__typename === 'TweetTombstone' || result?.__typename === 'TweetUnavailable' || !result || Object.keys(result).length === 0)) {
        entries.push({ kind: 'deleted', tweet_id: idFromEntry, sort_index: padSortIndex(e.sortIndex || idFromEntry) })
      }
      continue
    }
    const post = tweetToPost(tweet, String(e.sortIndex ?? ''))
    if (post) entries.push({ kind: 'tweet', post })
  }
  return { entries, cursor, recognized: true }
}

// ---------------- 文件夹 ----------------

export interface ParsedFolder {
  id: string
  name: string
}

export function parseFolders(json: AnyObj): { folders: ParsedFolder[]; cursor?: string } {
  const slice =
    json?.data?.viewer?.user_results?.result?.bookmark_collections_slice ??
    deepFind(json?.data, (k) => k === 'bookmark_collections_slice')
  const items: AnyObj[] = slice?.items ?? []
  const folders: ParsedFolder[] = []
  for (const it of items) {
    if (it?.id && it?.name) folders.push({ id: String(it.id), name: String(it.name) })
  }
  const next = slice?.slice_info?.next_cursor
  return { folders, cursor: next || undefined }
}

// ---------------- 线程 (TweetDetail) ----------------

/**
 * 从 TweetDetail 响应中取出与焦点推文同作者、同会话的"自回复线程"推文 (不含焦点本身),
 * 按时间升序返回。
 */
export function parseThread(json: AnyObj, focalId: string): ThreadItem[] {
  const instructions = findInstructions(json)
  const found = new Map<string, { tweet: AnyObj }>()
  let focal: AnyObj | null = null

  const consider = (result: AnyObj | undefined) => {
    const t = unwrapTweetResult(result)
    if (!t) return
    const id = String(t.rest_id ?? '')
    if (!id) return
    if (id === focalId) focal = t
    found.set(id, { tweet: t })
  }

  for (const ins of instructions) {
    if (ins.type !== 'TimelineAddEntries') continue
    for (const e of ins.entries ?? []) {
      const c = e.content ?? {}
      if (c.entryType === 'TimelineTimelineItem') {
        consider(c.itemContent?.tweet_results?.result)
      } else if (c.entryType === 'TimelineTimelineModule') {
        for (const it of c.items ?? []) consider(it.item?.itemContent?.tweet_results?.result)
      }
    }
  }
  if (!focal) return []
  const focalUser = parseUser(focal).user_id
  const convId = (focal as AnyObj).legacy?.conversation_id_str
  const items: ThreadItem[] = []
  for (const [id, { tweet }] of found) {
    if (id === focalId) continue
    if (parseUser(tweet).user_id !== focalUser) continue
    if (convId && tweet.legacy?.conversation_id_str !== convId) continue
    const p = tweetToPost(tweet)
    if (!p) continue
    items.push({ tweet_id: id, text: p.text, created_at: p.created_at, media: p.media })
  }
  items.sort((a, b) => a.created_at - b.created_at || (BigInt(a.tweet_id) < BigInt(b.tweet_id) ? -1 : 1))
  return items
}
