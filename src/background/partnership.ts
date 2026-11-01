/**
 * Hover-card paid-partnership sample.
 * Read-only UserByScreenName + UserTweets. Does not write the strike ledger,
 * and does not mute, block, or enqueue.
 */
import { client } from './messaging'
import { PARTNERSHIP_CACHE_KEY, runPartnershipStats } from '@/strike/lib/partnership.js'
import { sanitizeHandle } from '@/strike/lib/pure.js'

const inflight = new Map<string, Promise<{ ok: boolean; error?: string; partnership?: unknown; cached?: boolean }>>()
let chain: Promise<unknown> = Promise.resolve()

function locked<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(() => {}, () => {})
  return run
}

function timelineSender(sender?: { url?: string }) {
  try {
    const host = new URL(sender?.url || '').hostname
    return host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com' || host === 'mobile.twitter.com'
  } catch {
    return false
  }
}

async function loadOne(handle: string) {
  const got = await chrome.storage.local.get(['xsl', PARTNERSHIP_CACHE_KEY])
  const settings = (got.xsl as { settings?: Record<string, unknown> } | undefined)?.settings || {}
  const result = await runPartnershipStats({
    handle,
    settings,
    cache: got[PARTNERSHIP_CACHE_KEY],
    now: Date.now(),
    api: {
      getUserByScreenName: (name: string) => client.getUserByScreenName(name),
      getUserTweets: (id: string, cursor?: string, count?: number) => client.getUserTweets(id, cursor, count),
    },
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  })
  if (result.cacheChanged) {
    await chrome.storage.local.set({ [PARTNERSHIP_CACHE_KEY]: result.cache })
  }
  if (!result.ok) return { ok: false, error: result.error || 'no-handle' }
  return { ok: true, partnership: result.partnership, cached: !!result.cached }
}

export function handlePartnershipStats(
  message: { handle?: string },
  sender?: { url?: string },
) {
  if (!timelineSender(sender)) return Promise.resolve({ ok: false, error: 'forbidden' })
  const handle = sanitizeHandle(message?.handle)
  if (!handle) return Promise.resolve({ ok: false, error: 'no-handle' })
  const key = handle.toLowerCase()
  const existing = inflight.get(key)
  if (existing) return existing
  const run = locked(() => loadOne(handle))
  inflight.set(key, run)
  void run.finally(() => {
    if (inflight.get(key) === run) inflight.delete(key)
  })
  return run
}
