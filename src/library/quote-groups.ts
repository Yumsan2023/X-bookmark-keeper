import type { Post } from '@/shared/types'
import { postSource } from '@/shared/types'

const STATUS_RE = /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^?#]*?\/status(?:es)?\/(\d+)/i
const ARTICLE_RE = /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:i\/articles?|[^/?#]+\/articles?)\/(\d+)/i

export interface QuoteTarget {
  tweet_id: string
  screen_name: string
  name: string
  text: string
  article_title?: string
  url: string
  local: boolean
}

export interface QuoteGroup {
  key: string
  posts: Post[]
  original?: Post
  info: QuoteTarget
  quoting: Post[]
}

export function statusAndArticleIds(urls: string[] | undefined): { statusIds: string[]; articleIds: string[] } {
  const statusIds: string[] = []
  const articleIds: string[] = []
  for (const raw of urls ?? []) {
    const value = String(raw)
    const article = ARTICLE_RE.exec(value)
    if (article) {
      if (!articleIds.includes(article[1])) articleIds.push(article[1])
      continue
    }
    const status = STATUS_RE.exec(value)
    if (status && !statusIds.includes(status[1])) statusIds.push(status[1])
  }
  return { statusIds, articleIds }
}

function articleIndex(posts: Post[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const post of posts) {
    if (post.quoted?.article_id) map.set(post.quoted.article_id, post.quoted.tweet_id)
  }
  return map
}

function linkedIds(post: Post, articles: Map<string, string>): string[] {
  const ids: string[] = []
  const add = (id?: string) => {
    if (id && id !== post.tweet_id && !ids.includes(id)) ids.push(id)
  }
  add(post.quoted?.tweet_id)
  const { statusIds, articleIds } = statusAndArticleIds(post.urls)
  statusIds.forEach(add)
  for (const articleId of articleIds) add(articles.get(articleId) ?? `article:${articleId}`)
  return ids
}

function groupKey(post: Post, originals: Set<string>, articles: Map<string, string>): string {
  if (originals.has(post.tweet_id)) return post.tweet_id
  return linkedIds(post, articles)[0] ?? post.tweet_id
}

function targetInfo(key: string, posts: Post[], original?: Post): QuoteTarget {
  if (original) {
    return {
      tweet_id: original.tweet_id,
      screen_name: original.screen_name,
      name: original.name,
      text: original.text,
      url: original.url,
      local: true,
    }
  }
  const quoted = posts.find((post) => post.quoted?.tweet_id === key)?.quoted
  if (quoted) {
    return {
      tweet_id: quoted.tweet_id,
      screen_name: quoted.screen_name,
      name: quoted.name,
      text: quoted.text,
      article_title: quoted.article_title,
      url: `https://x.com/${quoted.screen_name || 'i/web'}/status/${quoted.tweet_id}`,
      local: false,
    }
  }
  if (key.startsWith('article:')) {
    return { tweet_id: '', screen_name: '', name: '', text: '', url: `https://x.com/i/article/${key.slice(8)}`, local: false }
  }
  return { tweet_id: key, screen_name: '', name: '', text: '', url: `https://x.com/i/web/status/${key}`, local: false }
}

/** Group posts that quote or link the same original. */
export function groupByOriginal(posts: Post[]): QuoteGroup[] {
  const articles = articleIndex(posts)
  const originals = new Set<string>()
  for (const post of posts) for (const id of linkedIds(post, articles)) originals.add(id)
  const keys = new Map<string, string>()
  for (const post of posts) keys.set(post.tweet_id, groupKey(post, originals, articles))
  const buckets = new Map<string, Post[]>()
  for (const post of posts) {
    const key = keys.get(post.tweet_id)!
    const list = buckets.get(key)
    if (list) list.push(post)
    else buckets.set(key, [post])
  }
  const groups: QuoteGroup[] = []
  for (const [key, members] of buckets) {
    const original = members.find((post) => post.tweet_id === key)
    groups.push({
      key,
      posts: members,
      original,
      info: targetInfo(key, members, original),
      quoting: members.filter((post) => post !== original),
    })
  }
  return groups
}

export function duplicateGroups(groups: QuoteGroup[]): QuoteGroup[] {
  return groups.filter((group) => group.posts.length >= 2)
}

/** Tweet ids to drop: every bookmark in the group except the original, or the newest bookmark if the original is missing. */
export function extraIds(group: QuoteGroup): string[] {
  if (group.posts.length < 2) return []
  const keep =
    group.original ??
    [...group.posts].sort((a, b) => (a.sort_index < b.sort_index ? 1 : a.sort_index > b.sort_index ? -1 : 0))[0]
  return group.posts
    .filter((post) => post !== keep && postSource(post) === 'bookmark' && post.status !== 'unbookmarked')
    .map((post) => post.tweet_id)
}
