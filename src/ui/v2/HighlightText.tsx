import type { ReactNode } from 'react'
import { highlight } from '@/search/highlight'
import type { Post } from '@/shared/types'

/** 将文本中命中的搜索词用高对比度 <mark> 高亮（兼容明暗主题） */
export function renderHighlightedText(text: string, terms: string[] | undefined, keyPrefix = 'hl'): ReactNode {
  if (!text) return text
  if (!terms || terms.length === 0) return text
  const segs = highlight(text, terms)
  if (segs.length === 1 && !segs[0].hit) return text
  return segs.map((seg, i) =>
    seg.hit ? (
      <mark
        key={`${keyPrefix}-${i}`}
        className="rounded-[3px] px-0.5 font-medium"
        style={{
          background: 'rgba(250, 204, 21, 0.36)',
          color: 'inherit',
          boxShadow: 'inset 0 -1px 0 rgba(234, 179, 8, 0.7)',
        }}
      >
        {seg.text}
      </mark>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{seg.text}</span>
    ),
  )
}

export function HighlightText({ text, terms }: { text: string; terms?: string[] }) {
  return <>{renderHighlightedText(text, terms)}</>
}

function extractWindow(sourceText: string, needleLower: string, radius = 56): string | null {
  const norm = sourceText.normalize('NFKC')
  const idx = norm.toLowerCase().indexOf(needleLower)
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = Math.min(norm.length, idx + needleLower.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < norm.length ? '…' : ''
  return `${prefix}${norm.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/**
 * 当搜索词未出现在卡片前 3 行可见摘要中（例如命中在长文后段、引用文章、笔记、串推或标签）时，
 * 提取一段带上下文的命中片段，让用户一眼看到为什么该条推文被搜到。
 */
export function findMatchedSnippet(
  post: Post,
  terms: string[] | undefined,
): { source: string; snippet: string } | null {
  if (!terms || terms.length === 0) return null
  const cleanTerms = terms.map((t) => t.trim().toLowerCase().normalize('NFKC')).filter(Boolean)
  if (!cleanTerms.length) return null

  const headVisible = [post.name, post.screen_name, (post.text || '').slice(0, 140), post.quoted?.article_title ?? '']
    .join('\n')
    .normalize('NFKC')
    .toLowerCase()

  // 如果所有关键词都在卡片头部可见区，就无需额外展示命中片段行
  if (cleanTerms.every((t) => headVisible.includes(t))) return null

  const primary = cleanTerms.find((t) => !headVisible.includes(t)) ?? cleanTerms[0]

  const candidates: { source: string; text?: string }[] = [
    { source: '正文后段', text: post.text },
    { source: '引用文章', text: post.quoted?.article_text },
    { source: '引用推文', text: [post.quoted?.name, post.quoted?.screen_name, post.quoted?.text].filter(Boolean).join(' ') },
    { source: '个人笔记', text: post.note },
    { source: '串推', text: (post.thread ?? []).map((t) => t.text).join('\n') },
    { source: '标签', text: (post.tags ?? []).map((t) => `#${t}`).join(' ') },
    { source: '外链', text: (post.urls ?? []).join(' ') },
  ]

  for (const c of candidates) {
    if (!c.text) continue
    const win = extractWindow(c.text, primary)
    if (win) return { source: c.source, snippet: win }
  }
  return null
}
