/**
 * v2 Notion Integration exporter:
 * Pushes curated bookmarks directly to a user-configured Notion database using a local
 * Notion Integration Token (optional host permission for https://api.notion.com/*).
 */
import type { Post } from '@/shared/types'

export interface NotionConfig {
  token: string
  databaseId: string
}

export interface NotionPushResult {
  pushed: number
  failed: number
  errors: string[]
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

  // Quoted post block
  if (post.quoted) {
    const qText = `${post.quoted.name} (@${post.quoted.screen_name})${post.quoted.article_title ? ` · ${post.quoted.article_title}` : ''}\n${post.quoted.text}`
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
