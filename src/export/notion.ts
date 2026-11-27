/**
 * v2 Notion Integration exporter:
 * Pushes curated bookmarks directly to a user-configured Notion database using a local
 * Notion Integration Token (optional host permission for https://api.notion.com/*).
 */
import type { NotionDatabaseEntry, Post } from '@/shared/types'

export interface NotionConfig {
  token: string
  databaseId: string
}

export interface NotionPushResult {
  pushed: number
  failed: number
  errors: string[]
}

export interface NotionQuotePayloadInput {
  post: Post
  databaseId: string
  quoteText: string
  annotation: string
  includeFullPost?: boolean
}

export interface NotionSinglePushResult {
  pageId: string
  url?: string
}

/** 一键查询当前 Integration Token 有权访问的全部 Notion 数据库，供用户下拉选择 */
export async function listNotionDatabases(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionDatabaseEntry[]> {
  const clean = token.trim()
  if (!clean) throw new Error('请先填写 Notion Integration Token')
  const res = await fetchImpl('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clean}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { value: 'database', property: 'object' },
      page_size: 50,
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`拉取 Notion 数据库失败 (HTTP ${res.status}): ${errText.slice(0, 160)}`)
  }
  const json = (await res.json()) as {
    results?: Array<{ id?: string; title?: Array<{ plain_text?: string }> }>
  }
  const out: NotionDatabaseEntry[] = []
  for (const item of json.results ?? []) {
    const id = String(item?.id ?? '').trim()
    if (!id) continue
    const name =
      (item.title ?? [])
        .map((t) => t?.plain_text ?? '')
        .join('')
        .trim() || `Database ${id.slice(0, 8)}`
    out.push({ id, name })
  }
  return out
}

/** 构建 Antigravity 风格的「划词引用 / 整篇引用 + 批注」Notion 页面结构 */
export function buildNotionQuotePayload(input: NotionQuotePayloadInput): Record<string, unknown> {
  const { post, databaseId, quoteText, annotation, includeFullPost = true } = input
  const cleanQuote = quoteText.trim()
  const cleanNote = annotation.trim()
  const titleCore =
    cleanNote.split('\n')[0]?.slice(0, 48) ||
    post.article_title ||
    post.quoted?.article_title ||
    cleanQuote.replace(/\s+/g, ' ').slice(0, 48) ||
    post.tweet_id
  const titleText = `[X摘录] @${post.screen_name}: ${titleCore}`.slice(0, 96)

  const children: Record<string, unknown>[] = []

  // 来源信息 Callout
  children.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { emoji: '🔖' },
      rich_text: [
        {
          type: 'text',
          text: {
            content: `作者：${post.name} (@${post.screen_name}) · 领域：${post.folder || '未归类'} · 标签：${(post.tags || []).slice(0, 6).join(', ') || '无'}`,
          },
        },
      ],
    },
  })

  // 选中的引用片段
  if (cleanQuote) {
    children.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '摘录原文' } }] },
    })
    for (const part of chunkText(cleanQuote)) {
      children.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: [{ type: 'text', text: { content: part } }] },
      })
    }
  }

  // 用户批注
  if (cleanNote) {
    children.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '我的批注与思考' } }] },
    })
    for (const part of chunkText(cleanNote)) {
      children.push({
        object: 'block',
        type: 'callout',
        callout: {
          icon: { emoji: '💡' },
          rich_text: [{ type: 'text', text: { content: part } }],
        },
      })
    }
  }

  // 可选：把完整原文折叠在 Toggle 块里，保持页面清爽
  if (includeFullPost) {
    const toggleChildren: Record<string, unknown>[] = []
    for (const part of chunkText(post.text)) {
      toggleChildren.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: part } }] },
      })
    }
    if (post.quoted) {
      const qBody = post.quoted.article_text
        ? `${post.quoted.article_title ? `${post.quoted.article_title}\n\n` : ''}${post.quoted.article_text}`
        : post.quoted.text
      for (const part of chunkText(`引用 @${post.quoted.screen_name}：\n${qBody}`)) {
        toggleChildren.push({
          object: 'block',
          type: 'quote',
          quote: { rich_text: [{ type: 'text', text: { content: part } }] },
        })
      }
    }
    if (toggleChildren.length) {
      children.push({
        object: 'block',
        type: 'toggle',
        toggle: {
          rich_text: [{ type: 'text', text: { content: '📄 展开完整推文 / 文章原文' } }],
          children: toggleChildren.slice(0, 80),
        },
      })
    }
  }

  // 原文链接书签
  children.push({
    object: 'block',
    type: 'bookmark',
    bookmark: { url: post.url },
  })

  return {
    parent: { database_id: databaseId.trim() },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: titleText } }],
      },
    },
    children: children.slice(0, 95),
  }
}

export async function pushQuoteToNotion(
  input: NotionQuotePayloadInput & { token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<NotionSinglePushResult> {
  const token = input.token.trim()
  const databaseId = input.databaseId.trim()
  if (!token || !databaseId) throw new Error('请先配置 Notion Token 并选择目标数据库')
  const res = await fetchImpl('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildNotionQuotePayload(input)),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Notion 写入失败 (HTTP ${res.status}): ${errText.slice(0, 180)}`)
  }
  const data = (await res.json()) as { id?: string; url?: string }
  return { pageId: String(data?.id ?? ''), url: data?.url }
}

function chunkText(text: string, maxLen = 1900): string[] {
  const s = String(text || '').trim()
  if (!s) return []
  const out: string[] = []
  for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen))
  return out
}

export function buildNotionPagePayload(post: Post, databaseId: string): Record<string, unknown> {
  const titleText = `[X] @${post.screen_name}: ${(post.text || post.quoted?.article_title || post.tweet_id).replace(/\s+/g, ' ').slice(0, 80)}`
  const children: Record<string, unknown>[] = []

  // Metadata callout
  children.push({
    object: 'block',
    type: 'callout',
    callout: {
      icon: { emoji: '🔖' },
      rich_text: [
        {
          type: 'text',
          text: {
            content: `作者：${post.name} (@${post.screen_name}) · 领域：${post.folder || '未归类'} · 标签：${(post.tags || []).join(', ') || '无'} · 赞 ${post.metrics.likes} / 藏 ${post.metrics.bookmarks}`,
          },
        },
      ],
    },
  })

  // Main text blocks
  for (const part of chunkText(post.text)) {
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: part } }] },
    })
  }

  // Merged thread blocks
  if (post.thread?.length) {
    children.push({
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: `Thread (${post.thread.length + 1} 条)` } }] },
    })
    for (const item of post.thread) {
      for (const part of chunkText(item.text)) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: part } }] },
        })
      }
    }
  }

  // Quoted post block (includes full quoted X Article body if fetched)
  if (post.quoted) {
    const qBody = post.quoted.article_text
      ? `${post.quoted.text ? `${post.quoted.text}\n\n` : ''}${post.quoted.article_text}`
      : post.quoted.text
    const qText = `${post.quoted.name} (@${post.quoted.screen_name})${post.quoted.article_title ? ` · ${post.quoted.article_title}` : ''}\n${qBody}`
    for (const part of chunkText(qText)) {
      children.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: [{ type: 'text', text: { content: part } }] },
      })
    }
  }

  // Personal note
  if (post.note?.trim()) {
    children.push({
      object: 'block',
      type: 'callout',
      callout: {
        icon: { emoji: '📝' },
        rich_text: [{ type: 'text', text: { content: post.note.trim().slice(0, 1900) } }],
      },
    })
  }

  // Original link
  children.push({
    object: 'block',
    type: 'bookmark',
    bookmark: { url: post.url },
  })

  return {
    parent: { database_id: databaseId.trim() },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: titleText } }],
      },
    },
    children: children.slice(0, 95),
  }
}

export async function pushPostsToNotion(
  posts: Post[],
  cfg: NotionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionPushResult> {
  const token = cfg.token.trim()
  const databaseId = cfg.databaseId.trim()
  if (!token || !databaseId) throw new Error('请先在设置页填写 Notion Integration Token 与 Database ID')

  let pushed = 0
  let failed = 0
  const errors: string[] = []

  for (const post of posts) {
    try {
      const res = await fetchImpl('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildNotionPagePayload(post, databaseId)),
      })
      if (!res.ok) {
        const txt = (await res.text().catch(() => '')).slice(0, 160)
        throw new Error(`HTTP ${res.status}: ${txt}`)
      }
      pushed++
    } catch (e) {
      failed++
      errors.push(`${post.tweet_id}: ${(e as Error).message}`)
    }
  }
  return { pushed, failed, errors }
}
