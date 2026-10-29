import { describe, expect, it, vi } from 'vitest'
import { buildClassifyMessages, classifyAll, llmConfigured, parseClassifyResponse } from '@/ai/classify'
import { DEFAULT_SETTINGS, type Post } from '@/shared/types'

const p = (id: string, text: string) => ({ tweet_id: id, screen_name: 'a', text } as Post)
const cfg = { ...DEFAULT_SETTINGS.llm, apiKey: 'k', batchSize: 2, intervalMs: 10 }

describe('ai classify', () => {
  it('prompt includes folders and restricts when new folders are not allowed', () => {
    const m = buildClassifyMessages([p('1', 'hello')], ['AI', 'Dev'], false)
    expect(m[0].content).toContain('["AI","Dev"]')
    expect(m[0].content).toContain('MUST choose only')
    expect(JSON.parse(m[1].content)[0]).toMatchObject({ id: '1', text: 'hello' })
    expect(buildClassifyMessages([p('1', 'x')], [], true)[0].content).toContain('new folder')
  })
  it('parses fenced JSON, matches folder names case-insensitively, drops unknown folders/ids', () => {
    const out = parseClassifyResponse('```json\n{"assignments":[{"id":"1","folder":"ai"},{"id":"2","folder":"Nope"},{"id":"3","folder":"AI"},{"id":"9","folder":"AI"},{"id":"4","folder":null}]}\n```', ['1', '2', '3', '4'], ['AI', 'Dev'], false)
    expect([...out]).toEqual([['1', 'AI'], ['3', 'AI']])
  })
  it('allows new folders when enabled, supports mapping shape', () => {
    const out = parseClassifyResponse('Sure! {"1":"Cooking","2":"AI"}', ['1', '2'], ['AI'], true)
    expect(out.get('1')).toBe('Cooking')
    expect(out.get('2')).toBe('AI')
  })
  it('garbage returns empty', () => {
    expect(parseClassifyResponse('no json', ['1'], [], true).size).toBe(0)
    expect(parseClassifyResponse('{bad', ['1'], [], true).size).toBe(0)
  })
  it('classifyAll batches and rate-limits between batches', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      const items = JSON.parse(body.messages[1].content) as { id: string }[]
      calls.push(items.map((i) => i.id).join(','))
      expect((init.headers as any).authorization).toBe('Bearer k')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assignments: items.map((i) => ({ id: i.id, folder: 'AI' })) }) } }] }))
    })
    const sleep = vi.fn(async () => {})
    const prog: number[] = []
    const posts = ['1', '2', '3', '4', '5'].map((i) => p(i, 't' + i))
    const out = await classifyAll(cfg, posts, ['AI'], { fetchImpl: fetchImpl as any, sleep, onProgress: (x) => prog.push(x.done) })
    expect(calls).toEqual(['1,2', '3,4', '5'])
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(prog).toEqual([2, 4, 5])
    expect(out.size).toBe(5)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
  })
  it('HTTP error surfaces', async () => {
    const f = vi.fn(async () => new Response('bad key', { status: 401 }))
    await expect(classifyAll(cfg, [p('1', 'x')], ['AI'], { fetchImpl: f as any })).rejects.toThrow(/401/)
  })
  it('llmConfigured hides feature without key', () => {
    expect(llmConfigured(DEFAULT_SETTINGS.llm)).toBe(false)
    expect(llmConfigured(cfg)).toBe(true)
  })
})
