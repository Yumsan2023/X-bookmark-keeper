/**
 * Batched aggregation for the full sync report.
 * Never loads the entire posts table into memory at once — streams via iteratePostsBatches.
 */
import { iteratePostsBatches } from '@/db/query'
import { postSource, type Post } from '@/shared/types'
import {
  classifyPost,
  CONTENT_KINDS,
  type ContentKind,
} from './classify'

export const REPORT_BATCH = 3000
export const TOP_AUTHORS = 5

export interface KindStat {
  kind: ContentKind
  count: number
  percent: number
}

export interface AuthorStat {
  user_id: string
  screen_name: string
  name: string
  avatar: string
  count: number
  percent: number
}

export interface SyncReportStats {
  /** Active bookmarks considered for distribution / authors */
  total: number
  kinds: KindStat[]
  authors: AuthorStat[]
  /** Sum of bookmarks from authors outside the top N */
  otherAuthors: { count: number; percent: number }
  /** Distinct author count (active bookmarks) */
  authorCount: number
}

/** Round percents with largest-remainder so they sum to 100 (or 0 if total=0). */
export function allocatePercents(counts: number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0)
  const raw = counts.map((c) => (c / total) * 100)
  const floors = raw.map((x) => Math.floor(x))
  let rem = 100 - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  for (let k = 0; k < order.length && rem > 0; k++) {
    out[order[k].i]++
    rem--
  }
  return out
}

function includeInReport(p: Post): boolean {
  if (p.status !== 'active') return false
  // Report covers bookmark library (not timeline-only posts)
  return postSource(p) === 'bookmark'
}

/**
 * Stream all posts in batches; compute content distribution + top authors.
 */
export async function computeSyncReportStats(
  batchSize = REPORT_BATCH,
): Promise<SyncReportStats> {
  const kindCounts: Record<ContentKind, number> = {
    video: 0,
    image: 0,
    article: 0,
    long: 0,
    standard: 0,
  }
  // screen_name (lower) -> aggregate
  const byAuthor = new Map<
    string,
    { user_id: string; screen_name: string; name: string; avatar: string; count: number }
  >()
  let total = 0

  for await (const batch of iteratePostsBatches(batchSize)) {
    for (const p of batch) {
      if (!includeInReport(p)) continue
      total++
      kindCounts[classifyPost(p)]++
      const key = (p.screen_name || p.user_id || '?').toLowerCase()
      const ex = byAuthor.get(key)
      if (ex) {
        ex.count++
        // Prefer non-empty display fields from a later sighting
        if (p.name && (!ex.name || ex.name === ex.screen_name)) ex.name = p.name
        if (p.avatar) ex.avatar = p.avatar
        if (p.user_id) ex.user_id = p.user_id
        if (p.screen_name) ex.screen_name = p.screen_name
      } else {
        byAuthor.set(key, {
          user_id: p.user_id || '',
          screen_name: p.screen_name || key,
          name: p.name || p.screen_name || key,
          avatar: p.avatar || '',
          count: 1,
        })
      }
    }
  }

  const kindOrder: ContentKind[] = ['article', 'long', 'video', 'image', 'standard']
  const kindCountArr = kindOrder.map((k) => kindCounts[k])
  const kindPct = allocatePercents(kindCountArr, total)
  const kinds: KindStat[] = kindOrder.map((kind, i) => ({
    kind,
    count: kindCounts[kind],
    percent: kindPct[i],
  }))

  const ranked = [...byAuthor.values()].sort(
    (a, b) => b.count - a.count || a.screen_name.localeCompare(b.screen_name),
  )
  const top = ranked.slice(0, TOP_AUTHORS)
  const topCounts = top.map((a) => a.count)
  const topPct = allocatePercents(
    [...topCounts, ranked.slice(TOP_AUTHORS).reduce((s, a) => s + a.count, 0)],
    total,
  )
  const authors: AuthorStat[] = top.map((a, i) => ({
    ...a,
    percent: topPct[i] ?? 0,
  }))
  const otherCount = ranked.slice(TOP_AUTHORS).reduce((s, a) => s + a.count, 0)
  const otherPct = topPct[top.length] ?? (total ? Math.round((otherCount / total) * 100) : 0)

  return {
    total,
    kinds,
    authors,
    otherAuthors: { count: otherCount, percent: otherPct },
    authorCount: byAuthor.size,
  }
}

/** Ensure CONTENT_KINDS stays in sync for tests / UI */
export { CONTENT_KINDS }
