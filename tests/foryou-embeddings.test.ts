import { describe, expect, it, vi } from 'vitest'
import { EMBED_BATCH_SIZE, embedBatch, embedConfigured, normalize } from '@/ai/embeddings'

const CFG = { endpoint: 'http://127.0.0.1:1234/v1', model: 'bge-m3' }

function mockFetch(ok: boolean, body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    } as unknown as Response
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

function vecResponse(vectors: number[][]) {
  return { data: vectors.map((embedding) => ({ embedding })), model: 'bge-m3' }
}

describe('embedConfigured', () => {
  it('accepts loopback endpoints, rejects remote ones and empty config', () => {
    expect(embedConfigured(CFG)).toBe(true)
    expect(embedConfigured({ endpoint: 'http://localhost:11434/v1', model: 'bge-m3' })).toBe(true)
    expect(embedConfigured({ endpoint: 'https://api.example.com/v1', model: 'bge-m3' })).toBe(false)
    expect(embedConfigured({ endpoint: 'http://192.168.1.2:1234/v1', model: 'bge-m3' })).toBe(false)
    expect(embedConfigured({ endpoint: '', model: 'bge-m3' })).toBe(false)
    expect(embedConfigured({ endpoint: 'http://127.0.0.1:1234/v1', model: '' })).toBe(false)
    expect(embedConfigured(undefined)).toBe(false)
  })
})

describe('embedBatch', () => {
  it('posts to /embeddings with model and input, in order', async () => {
    const { fn, calls } = mockFetch(true, vecResponse([[1, 0], [0, 1]]))
    const out = await embedBatch(CFG, ['你好', 'hello'], fn)
    expect(out).toEqual([[1, 0], [0, 1]])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/embeddings')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'bge-m3', input: ['你好', 'hello'] })
  })

  it('returns [] without a request for empty input', async () => {
    const { fn, calls } = mockFetch(true, vecResponse([]))
    expect(await embedBatch(CFG, [], fn)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('chunks input into batches of 32', async () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE * 2 + 1 }, (_, i) => `t${i}`)
    const echo = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).input as string[]
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => vecResponse(input.map((_, i) => [i, 0])),
      } as unknown as Response
    })
    const out = await embedBatch(CFG, texts, echo as unknown as typeof fetch)
    expect(out).toHaveLength(texts.length)
    expect(echo).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String((echo.mock.calls[0][1] as RequestInit).body)).input).toHaveLength(32)
    expect(JSON.parse(String((echo.mock.calls[2][1] as RequestInit).body)).input).toHaveLength(1)
  })

  it('retries a transient failure and then succeeds', async () => {
    let n = 0
    const flaky = vi.fn(async () => {
      n++
      if (n < 3) throw new Error('network down')
      return { ok: true, status: 200, text: async () => '', json: async () => vecResponse([[1, 2]]) } as unknown as Response
    })
    const out = await embedBatch(CFG, ['hi'], flaky as unknown as typeof fetch)
    expect(out).toEqual([[1, 2]])
    expect(n).toBe(3)
  })

  it('throws after repeated failures and on non-200', async () => {
    const failing = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(embedBatch(CFG, ['hi'], failing as unknown as typeof fetch)).rejects.toThrow('down')
    const { fn } = mockFetch(false, 'bad', 500)
    await expect(embedBatch(CFG, ['hi'], fn)).rejects.toThrow('500')
  })

  it('throws on a non-loopback endpoint without calling fetch', async () => {
    const { fn, calls } = mockFetch(true, vecResponse([[1]]))
    await expect(embedBatch({ endpoint: 'https://api.example.com/v1', model: 'bge-m3' }, ['hi'], fn)).rejects.toThrow(
      '本机地址',
    )
    expect(calls).toHaveLength(0)
  })

  it('throws when the response has the wrong shape or count', async () => {
    const { fn } = mockFetch(true, { data: [{ noEmbedding: true }] })
    await expect(embedBatch(CFG, ['hi'], fn)).rejects.toThrow('格式不对')
    const badCount = vi.fn(async () => {
      return { ok: true, status: 200, text: async () => '', json: async () => vecResponse([[1]]) } as unknown as Response
    })
    await expect(embedBatch(CFG, ['a', 'b'], badCount as unknown as typeof fetch)).rejects.toThrow('条数不对')
  })

  it('aborts promptly when the signal is aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { fn, calls } = mockFetch(true, vecResponse([[1]]))
    await expect(embedBatch(CFG, ['hi'], fn, ctrl.signal)).rejects.toThrow('取消')
    expect(calls).toHaveLength(0)
  })
})

describe('normalize', () => {
  it('returns a unit vector, and zeros for the zero vector', () => {
    const v = normalize([3, 4])
    expect(v[0]).toBeCloseTo(0.6, 6)
    expect(v[1]).toBeCloseTo(0.8, 6)
    expect(normalize([0, 0])).toEqual([0, 0])
  })
})
