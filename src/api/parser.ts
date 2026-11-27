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

export interface ExtractedArticle {
  title: string
  body: string
  isFull: boolean
  images: MediaItem[]
}

function collectArticleMedia(article: AnyObj): {
  coverUrl: string
  mediaLookup: Map<string, string>
  images: MediaItem[]
} {
  const images: MediaItem[] = []
  const seenUrls = new Set<string>()
  const addImage = (url: string, alt = '', width?: number, height?: number) => {
    const clean = String(url || '').trim()
    if (!clean || seenUrls.has(clean)) return
    seenUrls.add(clean)
    images.push({
      type: 'photo',
      url: clean,
      ...(alt ? { alt } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    })
  }

  const coverInfo = article.cover_media?.media_info ?? article.cover_media
  const coverUrl = String(
    coverInfo?.original_img_url ?? coverInfo?.url ?? article.cover_media?.media_url_https ?? '',
  ).trim()
  if (coverUrl) {
    addImage(coverUrl, typeof article.title === 'string' ? article.title : '', coverInfo?.original_img_width, coverInfo?.original_img_height)
  }

  const mediaLookup = new Map<string, string>()
  const mediaEntities = Array.isArray(article.media_entities) ? article.media_entities : []
  for (const me of mediaEntities) {
    const mid = String(me?.media_id ?? me?.id ?? '')
    const info = me?.media_info ?? me
    const murl = String(info?.original_img_url ?? info?.url ?? me?.media_url_https ?? '').trim()
    if (mid && murl) mediaLookup.set(mid, murl)
    if (murl) {
      addImage(murl, String(me?.ext_alt_text ?? ''), info?.original_img_width, info?.original_img_height)
    }
  }
  return { coverUrl, mediaLookup, images }
}

function parseContentState(raw: unknown): AnyObj | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as AnyObj) : null
    } catch {
      return null
    }
  }
  return typeof raw === 'object' ? (raw as AnyObj) : null
}

/**
 * 解析 X Article (`article.article_results.result`) 完整内容与配图：
 * 1. 优先从 Draft.js `content_state.blocks` 还原 Markdown 段落/标题/引用/列表/代码块/内嵌图片与外链；
 * 2. 次选 `plain_text` 纯文本全文；
 * 3. 兜底 `preview_text` 摘要；
 * 4. 同步提取 `cover_media` 与 `media_entities` 配图供阅读器与画廊展示。
 */
export function extractArticleContent(article: AnyObj | undefined | null): ExtractedArticle | null {
  if (!article || typeof article !== 'object') return null
  const title = typeof article.title === 'string' ? decodeHtmlEntities(article.title).trim() : ''
  const { coverUrl, mediaLookup, images } = collectArticleMedia(article)
  const contentState = parseContentState(article.content_state)

  // Build entity lookup map (supports both array [{key, value}] and record { "0": {...} })
  const entityLookup = new Map<string, AnyObj>()
  const rawEntityMap = contentState?.entityMap
  if (Array.isArray(rawEntityMap)) {
    for (const entry of rawEntityMap) {
      if (entry && entry.key != null && entry.value) entityLookup.set(String(entry.key), entry.value)
    }
  } else if (rawEntityMap && typeof rawEntityMap === 'object') {
    for (const [k, v] of Object.entries(rawEntityMap)) {
      if (v && typeof v === 'object') entityLookup.set(String(k), v as AnyObj)
    }
  }

  const blocks = contentState?.blocks
  if (Array.isArray(blocks) && blocks.length > 0) {
    const rendered: string[] = []
    const inlineImgUrls = new Set<string>()
    if (coverUrl) {
      rendered.push(`![${title || '封面图'}](${coverUrl})`)
      inlineImgUrls.add(coverUrl)
    }
    let orderedIdx = 0
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      const type = String(b.type || 'unstyled')
      let text = typeof b.text === 'string' ? decodeHtmlEntities(b.text) : ''

      const entityRanges = Array.isArray(b.entityRanges) ? b.entityRanges : []
      if (type === 'atomic') {
        orderedIdx = 0
        for (const er of entityRanges) {
          const ent = entityLookup.get(String(er?.key))
          const etype = String(ent?.type || '').toUpperCase()
          const data = ent?.data ?? {}
          if (etype === 'MARKDOWN' && typeof data.markdown === 'string' && data.markdown.trim()) {
            rendered.push(data.markdown.trim())
          } else if (etype === 'LINK' && typeof data.url === 'string') {
            rendered.push(data.url)
          } else if (etype === 'MEDIA' || etype === 'IMAGE') {
            const items = Array.isArray(data.mediaItems) ? data.mediaItems : []
            let matchedAny = false
            for (const mi of items) {
              const mid = String(mi?.mediaId ?? mi?.media_id ?? '')
              const u = mediaLookup.get(mid) || String(mi?.url ?? mi?.original_img_url ?? '')
              if (u) {
                rendered.push(`![${data.caption || ''}](${u})`)
                inlineImgUrls.add(u)
                matchedAny = true
              }
            }
            if (!matchedAny && typeof data.url === 'string' && data.url) {
              rendered.push(`![${data.caption || ''}](${data.url})`)
              inlineImgUrls.add(data.url)
            }
            if (typeof data.caption === 'string' && data.caption.trim()) {
              rendered.push(`*${data.caption.trim()}*`)
            }
          } else if (etype === 'TWEET' && data.tweetId) {
            rendered.push(`https://x.com/i/status/${data.tweetId}`)
          }
        }
        continue
      }

      if (type !== 'ordered-list-item') orderedIdx = 0

      // Append link URLs if block has LINK entities not already embedded verbatim
      const extraLinks: string[] = []
      for (const er of entityRanges) {
        const ent = entityLookup.get(String(er?.key))
        const u = ent?.type === 'LINK' ? ent?.data?.url : undefined
        if (typeof u === 'string' && u && !text.includes(u) && !extraLinks.includes(u)) {
          extraLinks.push(u)
        }
      }
      if (extraLinks.length && text.trim()) {
        text = `${text} (${extraLinks.join(' ')})`
      }

      const trimmed = text.trim()
      if (!trimmed) continue

      if (type === 'header-one') rendered.push(`# ${trimmed}`)
      else if (type === 'header-two') rendered.push(`## ${trimmed}`)
      else if (type === 'header-three') rendered.push(`### ${trimmed}`)
      else if (type === 'blockquote') rendered.push(`> ${trimmed}`)
      else if (type === 'unordered-list-item') rendered.push(`- ${trimmed}`)
      else if (type === 'ordered-list-item') {
        orderedIdx += 1
        rendered.push(`${orderedIdx}. ${trimmed}`)
      } else if (type === 'code-block') {
        rendered.push(`\`\`\`\n${text}\n\`\`\``)
      } else {
        rendered.push(trimmed)
      }
    }
    // 兜底：若 media_entities 中还有未在 atomic block 里引用到的配图，附在文末防丢图
    for (const img of images) {
      if (!inlineImgUrls.has(img.url)) {
        rendered.push(`![${img.alt || ''}](${img.url})`)
      }
    }
    const body = rendered.join('\n\n').trim()
    if (body) return { title, body, isFull: true, images }
  }

  const plain = typeof article.plain_text === 'string' ? decodeHtmlEntities(article.plain_text).trim() : ''
  if (plain) {
    const imgPrefix = coverUrl ? `![${title || '封面图'}](${coverUrl})\n\n` : ''
    const extraImgs = images
      .filter((img) => img.url !== coverUrl)
      .map((img) => `![${img.alt || ''}](${img.url})`)
      .join('\n\n')
    const body = [imgPrefix + plain, extraImgs].filter(Boolean).join('\n\n').trim()
    return { title, body, isFull: true, images }
  }

  const preview = typeof article.preview_text === 'string' ? decodeHtmlEntities(article.preview_text).trim() : ''
  if (title || preview) return { title, body: preview, isFull: false, images }
  return null
}

function findArticleNode(tweet: AnyObj): AnyObj | null {
  const direct = tweet.article?.article_results?.result
  if (direct && typeof direct === 'object') return direct
  const nested = tweet.article?.result
  if (nested && typeof nested === 'object') return nested
  return null
}

function extractText(tweet: AnyObj): {
  text: string
  urls: string[]
  articleTitle?: string
  articleFull?: boolean
  articleImages?: MediaItem[]
} {
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
  const article = findArticleNode(tweet)
  const extracted = extractArticleContent(article)
  if (extracted) {
    const extra = [extracted.title, extracted.body].filter(Boolean).join('\n\n')
    // 当推文本身只是裸 /i/article/ 链接且已拿到完整文章时，避免重复堆叠链接
    const cleanBase = base.text.replace(/^https?:\/\/(?:x|twitter)\.com\/i\/articles?\/\d+\s*$/i, '').trim()
    const merged = cleanBase ? `${cleanBase}\n\n${extra}` : extra
    return {
      text: merged,
      urls: base.urls,
      articleTitle: extracted.title || undefined,
      articleFull: extracted.isFull,
      articleImages: extracted.images,
    }
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

function mergeMediaLists(a: MediaItem[], b: MediaItem[] | undefined): MediaItem[] {
  if (!b?.length) return a
  const seen = new Set(a.map((m) => m.url))
  const out = [...a]
  for (const m of b) {
    if (m.url && !seen.has(m.url)) {
      seen.add(m.url)
      out.push(m)
    }
  }
  return out
}

function parseQuoted(tweet: AnyObj): QuotedPost | undefined {
  const q = unwrapTweetResult(tweet.quoted_status_result?.result)
  if (!q) return undefined
  const user = parseUser(q)
  const id = String(q.rest_id ?? q.legacy?.id_str ?? '')
  if (!id) return undefined
  const extracted = extractText(q)
  const quoted: QuotedPost = { tweet_id: id, screen_name: user.screen_name, name: user.name, text: extracted.text }
  const article = findArticleNode(q)
  if (article?.rest_id) quoted.article_id = String(article.rest_id)
  if (article?.title) quoted.article_title = String(article.title)
  if (article?.preview_text) quoted.article_preview = String(article.preview_text)
  const art = extractArticleContent(article)
  if (art?.isFull && art.body) {
    quoted.article_text = art.body
    if (art.title && !quoted.article_title) quoted.article_title = art.title
  }
  const media = mergeMediaLists(parseMedia(q.legacy), art?.images)
  if (media.length) quoted.media = media
  return quoted
}


/** Detect Twitter Article node or article-like URLs */
export function detectHasArticle(tweet: AnyObj, urls: string[]): 0 | 1 {
  const article = findArticleNode(tweet)
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
  const { text, urls, articleTitle, articleFull, articleImages } = extractText(tweet)
  const media = mergeMediaLists(parseMedia(tweet.legacy), articleImages)
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
    ...(articleTitle ? { article_title: articleTitle } : {}),
    ...(articleFull ? { article_fetched_at: Date.now() } : {}),
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
    // 过滤掉作者在评论区回复其他路人的帖子（只保留真正自回复串推）
    const replyToUser = tweet.legacy?.in_reply_to_user_id_str
    if (replyToUser && String(replyToUser) !== focalUser) continue
    const p = tweetToPost(tweet)
    if (!p) continue
    items.push({ tweet_id: id, text: p.text, created_at: p.created_at, media: p.media })
  }
  items.sort((a, b) => a.created_at - b.created_at || (BigInt(a.tweet_id) < BigInt(b.tweet_id) ? -1 : 1))
  return items
}

/** 从 TweetDetail 响应中直接提取目标推文节点（兼容各种包装与深层嵌套） */
export function extractTweetFromDetail(json: AnyObj, targetId: string): { post: ParsedPost; raw: AnyObj } | null {
  const check = (result: AnyObj | undefined): { post: ParsedPost; raw: AnyObj } | null => {
    const t = unwrapTweetResult(result)
    if (!t) return null
    const id = String(t.rest_id ?? t.legacy?.id_str ?? '')
    if (id !== targetId) return null
    const post = tweetToPost(t)
    return post ? { post, raw: t } : null
  }
  const instructions = findInstructions(json)
  for (const ins of instructions) {
    if (ins.type !== 'TimelineAddEntries') continue
    for (const e of ins.entries ?? []) {
      const c = e.content ?? {}
      const itemRes = c.itemContent?.tweet_results?.result ?? c.content?.tweet_results?.result
      if (itemRes) {
        const hit = check(itemRes)
        if (hit) return hit
      }
      if (Array.isArray(c.items)) {
        for (const it of c.items) {
          const hit = check(it?.item?.itemContent?.tweet_results?.result)
          if (hit) return hit
        }
      }
    }
  }
  // 兜底：深搜任意 rest_id === targetId 的 Tweet 节点（兼容 TweetResultByRestId 或新版结构）
  const rawHit = deepFind(
    json?.data,
    (_k, v) =>
      !!(
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        String((v as AnyObj).rest_id ?? '') === targetId &&
        (v as AnyObj).legacy
      ),
  )
  if (rawHit) {
    const post = tweetToPost(rawHit)
    if (post) return { post, raw: rawHit }
  }
  return null
}

const ARTICLE_URL_RE = /(?:x|twitter)\.com\/(?:i\/articles?\/|[^/]+\/article\/)/i

/** 判断一条推文本身是否为「尚未抓全正文」的直接 X 文章 */
export function needsDirectArticleRepair(p: Pick<Post, 'has_article' | 'text' | 'urls' | 'article_fetched_at'>): boolean {
  const isArticle =
    p.has_article === 1 ||
    ARTICLE_URL_RE.test(p.text || '') ||
    (p.urls ?? []).some((u) => ARTICLE_URL_RE.test(u))
  if (!isArticle) return false
  if (p.article_fetched_at && (p.text || '').length >= 400) return false
  return (p.text || '').length < 600
}

/** 判断一条书签的引用对象是否为「尚未抓全正文」的 X 文章 */
export function needsQuotedArticleRepair(q: QuotedPost | undefined): boolean {
  if (!q?.tweet_id) return false
  const hasArticle = !!(q.article_id || q.article_title || ARTICLE_URL_RE.test(q.text || ''))
  if (!hasArticle) return false
  return !q.article_text || q.article_text.length < 300
}
