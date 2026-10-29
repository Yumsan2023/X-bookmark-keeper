import type { LlmConfig, Post } from '@/shared/types'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export const UNSORTED = ''

export function buildClassifyMessages(posts: Post[], folders: string[], allowNew: boolean): ChatMessage[] {
  const system = [
    'You are a bookmark classifier. Assign each tweet to exactly one folder.',
    folders.length ? `Existing folders: ${JSON.stringify(folders)}.` : 'There are no existing folders.',
    allowNew
      ? 'If none fit, you may propose a short new folder name (<= 20 chars).'
      : 'You MUST choose only from the existing folders; use null if none fits.',
    'Reply with ONLY a JSON object: {"assignments":[{"id":"<tweet id>","folder":"<folder name or null>"}]}. No prose.',
  ].join('\n')
  const items = posts.map((p) => ({
    id: p.tweet_id,
    author: `@${p.screen_name}`,
    text: (p.text + (p.quoted ? ` [quote: ${p.quoted.text}]` : '')).slice(0, 600),
  }))
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(items) },
  ]
}

/** 容错解析: 代码围栏、前后缀文字、{id: folder} 映射形态 */
export function parseClassifyResponse(
  content: string,
  validIds: string[],
  folders: string[],
  allowNew: boolean,
): Map<string, string> {
  const result = new Map<string, string>()
  let text = content.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return result
  let obj: any
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return result
  }
  const pairs: [string, unknown][] = []
  if (Array.isArray(obj.assignments)) for (const a of obj.assignments) pairs.push([String(a?.id), a?.folder])
  else if (Array.isArray(obj)) for (const a of obj) pairs.push([String(a?.id), a?.folder])
  else for (const [k, v] of Object.entries(obj)) pairs.push([k, v])
  const valid = new Set(validIds)
  const lower = new Map(folders.map((f) => [f.toLowerCase(), f]))
  for (const [id, f] of pairs) {
    if (!valid.has(id) || typeof f !== 'string') continue
    const name = f.trim()
    if (!name) continue
    const existing = lower.get(name.toLowerCase())
    if (existing) result.set(id, existing)
    else if (allowNew) result.set(id, name.slice(0, 40))
  }
  return result
}

export async function classifyBatch(
  cfg: LlmConfig,
  posts: Post[],
  folders: string[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const base = cfg.endpoint.replace(/\/+$/, '')
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: buildClassifyMessages(posts, folders, cfg.allowNewFolders),
    }),
    signal,
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const content: string = json?.choices?.[0]?.message?.content ?? ''
  return parseClassifyResponse(content, posts.map((p) => p.tweet_id), folders, cfg.allowNewFolders)
}

export interface ClassifyProgress {
  done: number
  total: number
  assigned: number
}

/** 分批 + 限速执行归类。返回 tweet_id → folder 的建议 (不落库, 交给 UI 预览确认) */
export async function classifyAll(
  cfg: LlmConfig,
  posts: Post[],
  folders: string[],
  opts: {
    onProgress?: (p: ClassifyProgress) => void
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<Map<string, string>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const all = new Map<string, string>()
  const size = Math.max(1, cfg.batchSize)
  for (let i = 0; i < posts.length; i += size) {
    if (opts.signal?.aborted) break
    const batch = posts.slice(i, i + size)
    const known = [...new Set([...folders, ...all.values()])]
    const part = await classifyBatch(cfg, batch, known, opts.fetchImpl, opts.signal)
    for (const [k, v] of part) all.set(k, v)
    opts.onProgress?.({ done: Math.min(i + size, posts.length), total: posts.length, assigned: all.size })
    if (i + size < posts.length) await sleep(cfg.intervalMs)
  }
  return all
}

export function llmConfigured(cfg: LlmConfig | undefined): boolean {
  return !!(cfg && cfg.apiKey.trim() && cfg.endpoint.trim() && cfg.model.trim())
}
