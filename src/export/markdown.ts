import type { Post } from '@/shared/types'

function yamlStr(s: string): string {
  return JSON.stringify(s) // JSON 字符串是合法的 YAML 双引号标量
}

export function frontmatter(p: Post): string {
  const lines = [
    '---',
    `tweet_id: ${yamlStr(p.tweet_id)}`,
    `url: ${yamlStr(p.url)}`,
    `author: ${yamlStr(p.name)}`,
    `screen_name: ${yamlStr(p.screen_name)}`,
    `created: ${new Date(p.created_at).toISOString()}`,
    `folder: ${yamlStr(p.folder)}`,
    `tags: [${(p.tags ?? []).map(yamlStr).join(', ')}]`,
    `status: ${p.status}`,
    `likes: ${p.metrics.likes}`,
    `views: ${p.metrics.views}`,
    '---',
  ]
  return lines.join('\n')
}

export interface MarkdownOptions {
  frontmatter?: boolean
  includeThread?: boolean
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

export function postToMarkdown(p: Post, opts: MarkdownOptions = {}): string {
  const parts: string[] = []
  if (opts.frontmatter) parts.push(frontmatter(p))
  const date = new Date(p.created_at).toISOString().slice(0, 10)
  parts.push(`## ${p.name} (@${p.screen_name}) · ${date}`)
  parts.push(p.text)
  if (opts.includeThread !== false && p.thread?.length) {
    parts.push(p.thread.map((t, i) => `**${i + 2}/${p.thread!.length + 1}** ${t.text}`).join('\n\n'))
  }
  if (p.quoted) parts.push(quote(`${p.quoted.name} (@${p.quoted.screen_name}): ${p.quoted.text}`))
  const media = (p.media ?? []).map((m) => (m.type === 'photo' ? `![${m.alt ?? ''}](${m.url})` : `[${m.type}](${m.video_url ?? m.url})`))
  if (media.length) parts.push(media.join('\n'))
  if ((p.tags ?? []).length) parts.push((p.tags ?? []).map((t) => `#${t.replace(/\s+/g, '-')}`).join(' '))
  if (p.note) parts.push(`> **Note**: ${p.note}`)
  parts.push(`[${p.url}](${p.url})`)
  return parts.join('\n\n') + '\n'
}

/** 所有书签合并成一个 Markdown 文件 */
export function postsToMarkdown(posts: Post[], opts: MarkdownOptions = {}): string {
  return `# X Bookmarks (${posts.length})\n\n` + posts.map((p) => postToMarkdown(p, { ...opts, frontmatter: false })).join('\n---\n\n')
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/** Obsidian 友好: 每条书签一个带 frontmatter 的 .md, 路径按文件夹分目录 */
export function postsToObsidianFiles(posts: Post[]): { name: string; data: string }[] {
  return posts.map((p) => {
    const date = new Date(p.created_at).toISOString().slice(0, 10)
    const dir = p.folder ? `${safeFileName(p.folder)}/` : ''
    const snippet = safeFileName(p.text.slice(0, 30))
    return {
      name: `${dir}${date} ${p.screen_name} ${snippet ? snippet + ' ' : ''}${p.tweet_id}.md`,
      data: postToMarkdown(p, { frontmatter: true }),
    }
  })
}
