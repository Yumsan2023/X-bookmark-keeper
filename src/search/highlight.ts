export interface Segment {
  text: string
  hit: boolean
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在文本中标记命中词 (大小写不敏感的子串匹配), 返回片段数组, UI 用 <mark> 渲染 */
export function highlight(text: string, terms: string[]): Segment[] {
  const ts = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!text || !ts.length) return [{ text, hit: false }]
  const re = new RegExp(`(${ts.map(escapeRe).join('|')})`, 'gi')
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), hit: false })
    out.push({ text: m[0], hit: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out
}
