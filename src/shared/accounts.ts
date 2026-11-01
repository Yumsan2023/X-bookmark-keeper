import type { Post } from './types'
import { postSource } from './types'

/** Bookmarks synced before v0.5 have no owning account. */
export const UNKNOWN_ACCOUNT = '__unknown__'

export function normalizeHandle(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
}

export function postAccounts(post: { accounts?: string[] } | null | undefined): string[] {
  return Array.isArray(post?.accounts) ? post.accounts : []
}

export function addAccount(accounts: string[] | undefined, handle: unknown): string[] {
  const next = Array.isArray(accounts) ? [...accounts] : []
  const name = normalizeHandle(handle)
  if (name && !next.includes(name)) next.push(name)
  return next
}

export function removeAccount(accounts: string[] | undefined, handle: unknown): string[] {
  const name = normalizeHandle(handle)
  return (Array.isArray(accounts) ? accounts : []).filter((a) => a !== name)
}

/** X `twid` cookie → numeric user id. */
export function twidFromCookie(cookie: string | undefined | null): string | undefined {
  if (!cookie) return undefined
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== 'twid') continue
    let raw = part.slice(eq + 1).trim().replace(/^"|"$/g, '')
    try {
      raw = decodeURIComponent(raw)
    } catch {
      /* keep raw */
    }
    return (/u=(\d+)/.exec(raw) ?? /^(\d+)$/.exec(raw))?.[1]
  }
  return undefined
}

export interface DeletePartition {
  allowed: string[]
  skipped: string[]
  unknown: string[]
}

/**
 * Posts with no recorded account are allowed (legacy) and listed as unknown.
 * Posts owned by other accounts are skipped entirely.
 */
export function partitionDeletes(ids: string[], posts: Array<Pick<Post, 'tweet_id' | 'accounts'> | undefined>, account: string): DeletePartition {
  const owner = normalizeHandle(account)
  const byId = new Map<string, Pick<Post, 'tweet_id' | 'accounts'>>()
  for (const post of posts) if (post) byId.set(post.tweet_id, post)
  const out: DeletePartition = { allowed: [], skipped: [], unknown: [] }
  for (const id of [...new Set(ids)]) {
    const post = byId.get(id)
    const owned = post ? postAccounts(post) : []
    if (!owned.length) {
      out.unknown.push(id)
      out.allowed.push(id)
    } else if (owner && owned.includes(owner)) {
      out.allowed.push(id)
    } else {
      out.skipped.push(id)
    }
  }
  return out
}

export type DeleteDecision =
  | { kind: 'keep'; accounts: string[] }
  | { kind: 'remove' }
  | { kind: 'unbookmark'; accounts: string[] }

/** After X accepts the delete for this account: keep the row if another account still owns it. */
export function decideDelete(post: { accounts?: string[] }, account: string, removeLocal: boolean): DeleteDecision {
  const accounts = removeAccount(postAccounts(post), account)
  if (accounts.length) return { kind: 'keep', accounts }
  if (removeLocal) return { kind: 'remove' }
  return { kind: 'unbookmark', accounts }
}

export function matchesAccountFilter(post: Post, accounts: string[] | undefined): boolean {
  if (!accounts?.length) return true
  const owned = postAccounts(post)
  return accounts.some((item) =>
    item === UNKNOWN_ACCOUNT ? owned.length === 0 && postSource(post) === 'bookmark' : owned.includes(normalizeHandle(item)),
  )
}
