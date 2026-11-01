import type { Post } from '@/shared/types'
import { distinctAuthorFlagOps } from '@/strike/lib/author-flags.js'

export type AuthorFlagName = 'marketing' | 'spam'

/** One message per author. addStrike is applied only if the ledger setting is on, and never queues mute/block. */
export async function commitAuthorFlags(posts: Post[], flag: AuthorFlagName, value: boolean) {
  const ops = distinctAuthorFlagOps(posts, flag, value) as Array<Record<string, unknown>>
  let ok = 0
  let failed = 0
  for (const op of ops) {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'SET_AUTHOR_FLAG', ...op, addStrike: true })) as { ok?: boolean } | undefined
      if (res?.ok) ok += 1
      else failed += 1
    } catch {
      failed += 1
    }
  }
  return { authors: ops.length, ok, failed }
}
