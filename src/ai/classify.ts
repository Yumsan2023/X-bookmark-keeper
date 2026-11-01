import type { LlmConfig, Post } from '@/shared/types'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** Content tags suggested per tweet. Preview only — callers persist after confirm. */
export const MAX_TAGS_PER_POST = 5
export const MAX_TAG_CHARS = 40

export function normalizeContentTag(raw: string): string {
  const t = raw.trim().replace(/^#/, '').replace(/\s+/g, '-')
  if (!t) return ''
  return [...t].slice(0, MAX_TAG_CHARS).join('')
}

/**
 * Merge suggested tags onto a post. Existing spelling wins on case-insensitive
 * duplicates. New tags are normalized (# stripped, spaces → hyphens).
 */
export function mergePostTags(existing: string[] | undefined, incoming: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of existing ?? []) {
    const t = String(raw ?? '').trim()
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  for (const raw of incoming) {
    const t = normalizeContentTag(String(raw ?? ''))
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** Apply a suggestion map onto posts. Posts with no suggestion keep their tags. */
export function applyTagSuggestions(
  posts: { tweet_id: string; tags?: string[] }[],
  suggestions: Map<string, string[]>,
): { tweet_id: string; tags: string[] }[] {
  return posts.map((p) => ({
    tweet_id: p.tweet_id,
    tags: mergePostTags(p.tags, suggestions.get(p.tweet_id) ?? []),
  }))
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

/** Remote endpoints need a key. Loopback (Ollama) may use an empty key. */
export function llmConfigured(cfg: LlmConfig | undefined): boolean {
  if (!cfg?.endpoint.trim() || !cfg.model.trim()) return false
  if (cfg.apiKey.trim()) return true
  return isLoopbackEndpoint(cfg.endpoint)
}

export function llmRequestHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = apiKey.trim()
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

export function allowNewContentTags(cfg: LlmConfig): boolean {
  return cfg.allowNewTags !== false
}

/**
 * Bilingual prompt so Chinese bookmarks and Chinese tag names classify well,
 * and English-only models still see the JSON contract.
 */
export function buildClassifyMessages(posts: Post[], knownTags: string[], allowNew: boolean): ChatMessage[] {
  const system = [
    '你是书签内容标签助手。You tag bookmarks by what the post is about.',
    '为每条推文标出内容主题，可以有多个标签。不要分配文件夹，不要判断垃圾、营销或广告。',
    'Assign one or more content-topic tags per tweet. Do not assign a folder. Do not judge spam, marketing, or ads.',
    knownTags.length
      ? `已有标签 Existing tags (reuse these spellings): ${JSON.stringify(knownTags)}.`
      : '目前没有已有标签。There are no existing tags yet.',
    '优先复用已有标签，并保持已有写法：中文标签保持中文，英文大小写与已有名称一致。',
    'Prefer an existing tag and keep its exact spelling. Chinese tag names stay Chinese.',
    allowNew
      ? '没有合适的已有标签时，可以提出简短新标签（不超过 12 个汉字或 24 个拉丁字符），语言跟随推文（中文推文用中文标签，英文推文可用英文）。每条 1 到 5 个标签。'
      : '只能从已有标签里选择。都不合适时 tags 用空数组。不要发明新标签。每条最多 5 个。',
    allowNew
      ? 'If none of the existing tags fit, you may propose a short new tag (<= 12 CJK characters or 24 latin characters) in the tweet language. 1 to 5 tags per tweet.'
      : 'You MUST choose only from the existing tags. Use an empty tags array if none fit. Do not invent tags. At most 5.',
    '只回复一个 JSON 对象，不要解释，不要 markdown：',
    '{"assignments":[{"id":"<tweet id>","tags":["标签"]}]}',
    'Reply with ONLY that JSON object. No prose.',
  ].join('\n')
  const items = posts.map((p) => ({
    id: p.tweet_id,
    author: `@${p.screen_name}`,
    lang: p.lang || undefined,
    text: (p.text + (p.quoted ? ` [quote: ${p.quoted.text}]` : '')).slice(0, 600),
  }))
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(items) },
  ]
}

function extractJson(content: string): unknown | null {
  let text = content.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const direct = tryParse(text)
  if (direct !== undefined) return direct
  const objStart = text.indexOf('{')
  const objEnd = text.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) {
    const v = tryParse(text.slice(objStart, objEnd + 1))
    if (v !== undefined) return v
  }
  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    const v = tryParse(text.slice(arrStart, arrEnd + 1))
    if (v !== undefined) return v
  }
  return null
}

function splitTagString(value: string): string[] {
  return value
    .split(/[,，;；、|]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function rawTagList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return splitTagString(value)
  return []
}

function readAssignmentTags(entry: unknown): unknown[] {
  if (Array.isArray(entry) || typeof entry === 'string') return rawTagList(entry)
  if (!entry || typeof entry !== 'object') return []
  const o = entry as Record<string, unknown>
  if (o.tags != null) return rawTagList(o.tags)
  if (o.tag != null) return rawTagList(o.tag)
  if (o.labels != null) return rawTagList(o.labels)
  return []
}

/** 容错解析: 代码围栏、前后缀文字、{id: tags} 映射、逗号分隔字符串 */
export function parseClassifyResponse(
  content: string,
  validIds: string[],
  knownTags: string[],
  allowNew: boolean,
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const obj = extractJson(content)
  if (obj == null) return result

  const pairs: [string, unknown][] = []
  if (Array.isArray(obj)) {
    for (const a of obj) pairs.push([String((a as { id?: unknown })?.id ?? ''), a])
  } else if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>
    const list = Array.isArray(rec.assignments) ? rec.assignments : Array.isArray(rec.results) ? rec.results : null
    if (list) {
      for (const a of list) pairs.push([String((a as { id?: unknown })?.id ?? (a as { tweet_id?: unknown })?.tweet_id ?? ''), a])
    } else {
      for (const [k, v] of Object.entries(rec)) pairs.push([k, v])
    }
  }

  const valid = new Set(validIds)
  const lower = new Map(knownTags.map((t) => [t.toLowerCase(), t]))
  for (const [id, entry] of pairs) {
    if (!valid.has(id)) continue
    const accepted: string[] = []
    const seen = new Set<string>()
    for (const raw of readAssignmentTags(entry)) {
      if (typeof raw !== 'string') continue
      const name = normalizeContentTag(raw)
      if (!name) continue
      const existing = lower.get(name.toLowerCase())
      const tag = existing ?? (allowNew ? name : '')
      if (!tag) continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      accepted.push(tag)
      if (!existing && allowNew) lower.set(key, tag)
      if (accepted.length >= MAX_TAGS_PER_POST) break
    }
    if (!accepted.length) continue
    const prev = result.get(id) ?? []
    const merged = mergePostTags(prev, accepted).slice(0, MAX_TAGS_PER_POST)
    result.set(id, merged)
  }
  return result
}

export async function classifyBatch(
  cfg: LlmConfig,
  posts: Post[],
  knownTags: string[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const base = cfg.endpoint.replace(/\/+$/, '')
  const allowNew = allowNewContentTags(cfg)
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: llmRequestHeaders(cfg.apiKey),
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: buildClassifyMessages(posts, knownTags, allowNew),
    }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const content: string = json?.choices?.[0]?.message?.content ?? ''
  return parseClassifyResponse(content, posts.map((p) => p.tweet_id), knownTags, allowNew)
}

export interface ClassifyProgress {
  done: number
  total: number
  assigned: number
}

/** 分批 + 限速。返回 tweet_id → 内容标签建议 (不落库, 交给 UI 预览确认) */
export async function classifyAll(
  cfg: LlmConfig,
  posts: Post[],
  knownTags: string[],
  opts: {
    onProgress?: (p: ClassifyProgress) => void
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<Map<string, string[]>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const all = new Map<string, string[]>()
  const size = Math.max(1, cfg.batchSize)
  let known = [...knownTags]
  for (let i = 0; i < posts.length; i += size) {
    if (opts.signal?.aborted) break
    const batch = posts.slice(i, i + size)
    const part = await classifyBatch(cfg, batch, known, opts.fetchImpl, opts.signal)
    for (const [k, v] of part) all.set(k, v)
    if (allowNewContentTags(cfg)) {
      known = [...new Set([...known, ...[...all.values()].flat()])]
    }
    opts.onProgress?.({ done: Math.min(i + size, posts.length), total: posts.length, assigned: all.size })
    if (i + size < posts.length) await sleep(cfg.intervalMs)
  }
  return all
}
