import { describe, expect, it, vi } from 'vitest'
import {
  applyTagSuggestions,
  buildClassifyMessages,
  classifyAll,
  isLoopbackEndpoint,
  llmConfigured,
  llmRequestHeaders,
  mergePostTags,
  parseClassifyResponse,
} from '@/ai/classify'
import { DEFAULT_SETTINGS, type Post } from '@/shared/types'

const p = (id: string, text: string, lang = 'zh') => ({ tweet_id: id, screen_name: 'a', text, lang } as Post)
const cfg = { ...DEFAULT_SETTINGS.llm, apiKey: 'k', batchSize: 2, intervalMs: 10 }

describe('ai content tags', () => {
  it('prompt is bilingual, lists known tags, and restricts when new tags are off', () => {
    const m = buildClassifyMessages([p('1', '你好，机器学习')], ['人工智能', 'Rust'], false)
    expect(m[0].content).toContain('内容主题')
    expect(m[0].content).toContain('人工智能')
    expect(m[0].content).toContain('["人工智能","Rust"]')
    expect(m[0].content).toContain('MUST choose only')
    expect(m[0].content).toContain('不要发明新标签')
    expect(m[0].content).toContain('Do not assign a folder')
    const item = JSON.parse(m[1].content)[0]
    expect(item).toMatchObject({ id: '1', text: '你好，机器学习', lang: 'zh' })
    expect(buildClassifyMessages([p('1', 'x')], [], true)[0].content).toContain('新标签')
    expect(buildClassifyMessages([p('1', 'x')], [], true)[0].content).toContain('Chinese')
  })

  it('parses fenced multi-tag JSON, matches known tags case-insensitively, drops unknown ids and tags', () => {
    const out = parseClassifyResponse(
      '```json\n{"assignments":[{"id":"1","tags":["ai","rust"]},{"id":"2","tags":["Nope"]},{"id":"3","tags":["AI","烹饪"]},{"id":"9","tags":["AI"]},{"id":"4","tags":[]}]}\n```',
      ['1', '2', '3', '4'],
      ['AI', 'Rust'],
      false,
    )
    expect(out.get('1')).toEqual(['AI', 'Rust'])
    expect(out.get('2')).toBeUndefined()
    expect(out.get('3')).toEqual(['AI'])
    expect(out.has('9')).toBe(false)
    expect(out.has('4')).toBe(false)
  })

  it('allows new tags, comma strings, and {id: tags} maps', () => {
    const mapped = parseClassifyResponse('Sure! {"1":["烹饪","AI"],"2":"Rust, 笔记"}', ['1', '2'], ['AI'], true)
    expect(mapped.get('1')).toEqual(['烹饪', 'AI'])
    expect(mapped.get('2')).toEqual(['Rust', '笔记'])
    const singular = parseClassifyResponse('{"assignments":[{"id":"1","tag":"人工智能"}]}', ['1'], [], true)
    expect(singular.get('1')).toEqual(['人工智能'])
  })

  it('caps tags per post and tag length', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const out = parseClassifyResponse(JSON.stringify({ assignments: [{ id: '1', tags: many }] }), ['1'], [], true)
    expect(out.get('1')).toEqual(['a', 'b', 'c', 'd', 'e'])
    const long = '中'.repeat(50)
    const capped = parseClassifyResponse(JSON.stringify({ 1: [long] }), ['1'], [], true)
    expect([...(capped.get('1')![0])].length).toBe(40)
  })

  it('garbage returns empty', () => {
    expect(parseClassifyResponse('no json', ['1'], [], true).size).toBe(0)
    expect(parseClassifyResponse('{bad', ['1'], [], true).size).toBe(0)
  })

  it('classifyAll batches, rate-limits, and sends the bearer token', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const items = JSON.parse(body.messages[1].content) as { id: string }[]
      calls.push(items.map((i) => i.id).join(','))
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ assignments: items.map((i) => ({ id: i.id, tags: ['AI', '笔记'] })) }) } }],
      }))
    })
    const sleep = vi.fn(async () => {})
    const prog: number[] = []
    const posts = ['1', '2', '3', '4', '5'].map((i) => p(i, 't' + i))
    const out = await classifyAll(cfg, posts, ['AI'], { fetchImpl: fetchImpl as typeof fetch, sleep, onProgress: (x) => prog.push(x.done) })
    expect(calls).toEqual(['1,2', '3,4', '5'])
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(prog).toEqual([2, 4, 5])
    expect(out.get('1')).toEqual(['AI', '笔记'])
    expect(out.size).toBe(5)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('later batches see tags proposed earlier when new tags are allowed', async () => {
    let n = 0
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const sys = body.messages[0].content as string
      const items = JSON.parse(body.messages[1].content) as { id: string }[]
      n++
      if (n === 1) {
        expect(sys).not.toContain('烹饪')
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assignments: [{ id: items[0].id, tags: ['烹饪'] }] }) } }] }))
      }
      expect(sys).toContain('烹饪')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assignments: [{ id: items[0].id, tags: ['烹饪', '食谱'] }] }) } }] }))
    })
    const out = await classifyAll(
      { ...cfg, allowNewTags: true, batchSize: 1, intervalMs: 0 },
      [p('1', '红烧肉'), p('2', '清蒸鱼')],
      [],
      { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} },
    )
    expect(out.get('1')).toEqual(['烹饪'])
    expect(out.get('2')).toEqual(['烹饪', '食谱'])
  })

  it('HTTP error surfaces', async () => {
    const f = vi.fn(async () => new Response('bad key', { status: 401 }))
    await expect(classifyAll(cfg, [p('1', 'x')], ['AI'], { fetchImpl: f as typeof fetch })).rejects.toThrow(/401/)
  })

  it('loopback Ollama works without a key and omits Authorization', async () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopbackEndpoint('http://localhost:11434/v1/')).toBe(true)
    expect(isLoopbackEndpoint('https://api.openai.com/v1')).toBe(false)
    const local = { ...cfg, endpoint: 'http://127.0.0.1:11434/v1', apiKey: '' }
    expect(llmConfigured(DEFAULT_SETTINGS.llm)).toBe(false)
    expect(llmConfigured(local)).toBe(true)
    expect(llmConfigured({ ...local, apiKey: 'ollama' })).toBe(true)
    expect(llmRequestHeaders('')).not.toHaveProperty('authorization')
    expect(llmRequestHeaders('ollama').authorization).toBe('Bearer ollama')
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.headers).not.toHaveProperty('authorization')
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"assignments":[{"id":"1","tags":["本地"]}]}' } }],
      }))
    })
    const out = await classifyAll(local, [p('1', 'hi')], [], { fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} })
    const init = fetchImpl.mock.calls[0][1]
    expect(init.headers).not.toHaveProperty('authorization')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(out.get('1')).toEqual(['本地'])
  })

  it('merges suggested tags without dropping or duplicating existing ones', () => {
    expect(mergePostTags(['AI', 'keep'], ['ai', '#新', 'to do'])).toEqual(['AI', 'keep', '新', 'to-do'])
    expect(mergePostTags(undefined, ['#todo', 'todo'])).toEqual(['todo'])
    const applied = applyTagSuggestions(
      [
        { tweet_id: '1', tags: ['keep'] },
        { tweet_id: '2', tags: [] },
        { tweet_id: '3', tags: ['stay'] },
      ],
      new Map([['1', ['keep', 'AI']], ['2', ['烹饪']]]),
    )
    expect(applied).toEqual([
      { tweet_id: '1', tags: ['keep', 'AI'] },
      { tweet_id: '2', tags: ['烹饪'] },
      { tweet_id: '3', tags: ['stay'] },
    ])
  })
})
