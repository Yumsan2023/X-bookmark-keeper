/**
 * 搜索语法解析 (纯函数):
 *   关键词 "精确短语" -排除词
 *   from:name   since:2024-01-01   until:2024-12-31
 *   folder:名称 / folder:"My Folder" / folder:none
 *   has:image|video|link|quote|media
 *   tag:xxx     is:deleted|unbookmarked|active
 *   source:bookmark|timeline
 */
export type HasKind = 'image' | 'video' | 'link' | 'quote' | 'media'
export type StatusFilter = 'active' | 'tweet_deleted' | 'unbookmarked'
export type SourceFilter = 'bookmark' | 'timeline'

export interface ParsedQuery {
  terms: string[]
  phrases: string[]
  excludes: string[]
  from: string[]
  since?: number
  until?: number
  folders: string[]
  has: HasKind[]
  tags: string[]
  status?: StatusFilter
  source?: SourceFilter
  warnings: string[]
}

export const NO_FOLDER = '__none__'

/** 按空白切分, 但保留引号内的内容 (含 key:"a b" 形式) */
export function splitTokens(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        cur += ch
        quote = null
      } else cur += ch
    } else if (ch === '"' || ch === '“' || ch === '”') {
      quote = ch === '“' ? '”' : ch
      cur += '"'
    } else if (/\s/.test(ch)) flush()
    else cur += ch
  }
  flush()
  return out.map((t) => t.replace(/[“”]/g, '"'))
}

function unquote(s: string): string {
  return s.replace(/^"/, '').replace(/"$/, '').replace(/"/g, '')
}

/** 解析 YYYY-MM-DD / YYYY/MM/DD / YYYY-MM / YYYY, 返回本地时区当天(月/年)的起止毫秒 */
export function parseDateToken(s: string): { start: number; end: number } | null {
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(s.trim())
  if (!m) return null
  const y = +m[1]
  const mo = m[2] ? +m[2] : undefined
  const d = m[3] ? +m[3] : undefined
  if (mo !== undefined && (mo < 1 || mo > 12)) return null
  if (d !== undefined && (d < 1 || d > 31)) return null
  let start: Date
  let end: Date
  if (d !== undefined) {
    start = new Date(y, mo! - 1, d)
    end = new Date(y, mo! - 1, d + 1)
  } else if (mo !== undefined) {
    start = new Date(y, mo - 1, 1)
    end = new Date(y, mo, 1)
  } else {
    start = new Date(y, 0, 1)
    end = new Date(y + 1, 0, 1)
  }
  if (Number.isNaN(start.getTime())) return null
  return { start: start.getTime(), end: end.getTime() - 1 }
}

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { terms: [], phrases: [], excludes: [], from: [], folders: [], has: [], tags: [], warnings: [] }
  for (const raw of splitTokens(input ?? '')) {
    let tok = raw
    let negate = false
    if (tok.startsWith('-') && tok.length > 1) {
      negate = true
      tok = tok.slice(1)
    }
    const m = /^(from|since|until|folder|has|tag|is|source):(.*)$/i.exec(tok)
    if (m && !negate) {
      const key = m[1].toLowerCase()
      const val = unquote(m[2])
      if (!val) continue
      switch (key) {
        case 'from':
          q.from.push(val.replace(/^@/, '').toLowerCase())
          break
        case 'since': {
          const d = parseDateToken(val)
          if (d) q.since = q.since === undefined ? d.start : Math.max(q.since, d.start)
          else q.warnings.push(`since:${val}`)
          break
        }
        case 'until': {
          const d = parseDateToken(val)
          if (d) q.until = q.until === undefined ? d.end : Math.min(q.until, d.end)
          else q.warnings.push(`until:${val}`)
          break
        }
        case 'folder':
          q.folders.push(/^(none|unfiled|无)$/i.test(val) ? NO_FOLDER : val)
          break
        case 'has': {
          const v = val.toLowerCase()
          if (v === 'image' || v === 'images' || v === 'photo') q.has.push('image')
          else if (v === 'video' || v === 'videos') q.has.push('video')
          else if (v === 'link' || v === 'links' || v === 'url') q.has.push('link')
          else if (v === 'quote') q.has.push('quote')
          else if (v === 'media') q.has.push('media')
          else q.warnings.push(`has:${val}`)
          break
        }
        case 'tag':
          q.tags.push(val.replace(/^#/, ''))
          break
        case 'is': {
          const v = val.toLowerCase()
          if (v === 'deleted') q.status = 'tweet_deleted'
          else if (v === 'unbookmarked' || v === 'removed') q.status = 'unbookmarked'
          else if (v === 'active') q.status = 'active'
          else q.warnings.push(`is:${val}`)
          break
        }
        case 'source': {
          const v = val.toLowerCase()
          if (v === 'bookmark' || v === 'bookmarks') q.source = 'bookmark'
          else if (v === 'timeline' || v === 'tweets' || v === 'posts') q.source = 'timeline'
          else q.warnings.push(`source:${val}`)
          break
        }
      }
      continue
    }
    // 普通词 / 短语
    const isPhrase = tok.startsWith('"')
    const text = unquote(tok).trim()
    if (!text) continue
    if (negate) q.excludes.push(text.toLowerCase())
    else if (isPhrase) q.phrases.push(text)
    else q.terms.push(text)
  }
  return q
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return !q.terms.length && !q.phrases.length
}
