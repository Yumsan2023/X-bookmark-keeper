/**
 * Content-type classification for sync report.
 * Mutually exclusive priority (percentages sum to ~100%):
 *   1. Video posts  — has video / gif media
 *   2. Image posts  — has photo media (no video)
 *   3. Articles     — Twitter Article / article-like link / has_article flag
 *   4. Long posts   — text length >= 280 OR has thread items
 *   5. Standard posts — everything else
 */
import type { Post } from '@/shared/types'

export type ContentKind = 'video' | 'image' | 'article' | 'long' | 'standard'

export const CONTENT_KINDS: ContentKind[] = ['article', 'long', 'video', 'image', 'standard']

/** Display order / colors matching the Twillot-style report legend */
export const CONTENT_KIND_META: Record<
  ContentKind,
  { labelEn: string; labelZh: string; color: string }
> = {
  article: { labelEn: 'Articles', labelZh: '长文 / 文章', color: '#1D9BF0' },
  long: { labelEn: 'Long posts', labelZh: '长帖', color: '#00BA7C' },
  video: { labelEn: 'Video posts', labelZh: '视频帖', color: '#F45D22' },
  image: { labelEn: 'Image posts', labelZh: '图片帖', color: '#7856FF' },
  standard: { labelEn: 'Standard posts', labelZh: '普通帖', color: '#F91880' },
}

const LONG_TEXT_MIN = 280

/** Article URL patterns (X Articles, /i/article(s)/, etc.) */
export function isArticleUrl(url: string): boolean {
  try {
    const u = url.toLowerCase()
    if (/\/i\/articles?\//.test(u)) return true
    if (/x\.com\/[^/]+\/article\//.test(u) || /twitter\.com\/[^/]+\/article\//.test(u)) return true
    return false
  } catch {
    return false
  }
}

export function postHasVideo(p: Pick<Post, 'has_video' | 'media'>): boolean {
  if (p.has_video === 1) return true
  return (p.media ?? []).some((m) => m.type === 'video' || m.type === 'animated_gif')
}

export function postHasImage(p: Pick<Post, 'has_image' | 'media'>): boolean {
  if (p.has_image === 1) return true
  return (p.media ?? []).some((m) => m.type === 'photo')
}

export function postHasArticle(
  p: Pick<Post, 'has_article' | 'urls' | 'text'>,
): boolean {
  if (p.has_article === 1) return true
  if ((p.urls ?? []).some(isArticleUrl)) return true
  return false
}

export function postIsLong(
  p: Pick<Post, 'text' | 'thread'>,
): boolean {
  if ((p.thread?.length ?? 0) > 0) return true
  return (p.text?.length ?? 0) >= LONG_TEXT_MIN
}

/** Classify one post with mutually exclusive priority. */
export function classifyPost(
  p: Pick<Post, 'has_video' | 'has_image' | 'has_article' | 'media' | 'urls' | 'text' | 'thread'>,
): ContentKind {
  if (postHasVideo(p)) return 'video'
  if (postHasImage(p)) return 'image'
  if (postHasArticle(p)) return 'article'
  if (postIsLong(p)) return 'long'
  return 'standard'
}
