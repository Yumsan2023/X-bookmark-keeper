import type { Post } from '@/shared/types'

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const CSV_COLUMNS = [
  'tweet_id',
  'url',
  'screen_name',
  'name',
  'created_at',
  'text',
  'folder',
  'tags',
  'urls',
  'media',
  'likes',
  'retweets',
  'replies',
  'views',
  'status',
] as const

export function postsToCsv(posts: Post[], opts: { bom?: boolean } = {}): string {
  const rows = posts.map((p) =>
    [
      p.tweet_id,
      p.url,
      p.screen_name,
      p.name,
      new Date(p.created_at).toISOString(),
      p.text,
      p.folder,
      (p.tags ?? []).join(';'),
      (p.urls ?? []).join(' '),
      (p.media ?? []).map((m) => m.video_url ?? m.url).join(' '),
      p.metrics.likes,
      p.metrics.retweets,
      p.metrics.replies,
      p.metrics.views,
      p.status,
    ]
      .map(csvEscape)
      .join(','),
  )
  const body = [CSV_COLUMNS.join(','), ...rows].join('\r\n')
  return (opts.bom ? '\uFEFF' : '') + body
}
