/**
 * Bookmark-library export for one collector account.
 * Same posts/folders shape as the older bookmark-keeper file, with
 * `format: bookmark-keeper-account` so restore merges instead of
 * replacing the whole library. Not a full extension backup.
 */
import { UNKNOWN_ACCOUNT, canonicalScreenName, normalizeHandle, postAccounts } from '@/shared/accounts'
import { postSource, type Folder, type Post } from '@/shared/types'

export const ACCOUNT_LIBRARY_FORMAT = 'bookmark-keeper-account' as const

export interface AccountExportSelection {
  /** Screen name, or `__unknown__` for bookmarks that have no account stamp. */
  account: string
  /**
   * When `account` is a handle, also include bookmark rows with an empty
   * `accounts` array. Ignored for the unknown-account export itself.
   */
  includeUnknown?: boolean
}

export interface AccountLibraryFile {
  app: 'bookmark-keeper'
  version: 1
  format: typeof ACCOUNT_LIBRARY_FORMAT
  /** Canonical handle, or `__unknown__`. */
  account: string
  /** True when unstamped bookmark rows are part of this file. */
  includeUnknown: boolean
  exported_at: number
  posts: Post[]
  folders: Folder[]
}

/** `__unknown__` or a canonical X handle. Empty when the value is neither. */
export function resolveAccountExportTarget(account: unknown): string {
  const raw = String(account ?? '').trim()
  if (!raw) return ''
  if (raw === UNKNOWN_ACCOUNT) return UNKNOWN_ACCOUNT
  const name = canonicalScreenName(raw)
  if (name === UNKNOWN_ACCOUNT) return UNKNOWN_ACCOUNT
  return name
}

function owns(post: { accounts?: string[] }): string[] {
  return postAccounts(post).map((item) => normalizeHandle(item)).filter(Boolean)
}

function isUnstampedBookmark(post: { accounts?: string[]; source?: Post['source'] }): boolean {
  return owns(post).length === 0 && postSource(post) === 'bookmark'
}

/** True when this post belongs in the account export. */
export function postMatchesAccountExport(
  post: { accounts?: string[]; source?: Post['source'] },
  selection: AccountExportSelection,
): boolean {
  const target = resolveAccountExportTarget(selection.account)
  if (!target) return false
  if (target === UNKNOWN_ACCOUNT) return isUnstampedBookmark(post)
  if (owns(post).includes(target)) return true
  return !!selection.includeUnknown && isUnstampedBookmark(post)
}

export function filterPostsForAccountExport<T extends { accounts?: string[]; source?: Post['source'] }>(
  posts: T[],
  selection: AccountExportSelection,
): T[] {
  return posts.filter((post) => postMatchesAccountExport(post, selection))
}

/** Folders named on the exported posts. Other folders stay out of the file. */
export function foldersForAccountExport(posts: { folder?: string }[], folders: Folder[]): Folder[] {
  const names = new Set<string>()
  for (const post of posts) if (post.folder) names.add(post.folder)
  const byName = new Map<string, Folder>()
  for (const folder of folders) {
    if (!names.has(folder.name) || byName.has(folder.name)) continue
    byName.set(folder.name, folder)
  }
  return [...byName.values()]
}

function byNewest(a: Post, b: Post): number {
  if (a.sort_index < b.sort_index) return 1
  if (a.sort_index > b.sort_index) return -1
  return a.tweet_id.localeCompare(b.tweet_id)
}

/**
 * Library subset for one account. Posts keep their tags, notes, folder,
 * and the full `accounts` array (other owners are not stripped).
 * Returns null when `account` is not a handle and not the unknown bucket.
 */
export function buildAccountLibraryExport(input: {
  posts: Post[]
  folders: Folder[]
  account: string
  includeUnknown?: boolean
  now?: number
}): AccountLibraryFile | null {
  const target = resolveAccountExportTarget(input.account)
  if (!target) return null
  const includeUnknown = target === UNKNOWN_ACCOUNT ? true : !!input.includeUnknown
  const matched = filterPostsForAccountExport(input.posts, { account: target, includeUnknown })
  const byId = new Map<string, Post>()
  for (const post of matched) byId.set(post.tweet_id, structuredClone(post))
  const posts = [...byId.values()].sort(byNewest)
  const folders = foldersForAccountExport(posts, input.folders)
    .map((folder) => structuredClone(folder))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    app: 'bookmark-keeper',
    version: 1,
    format: ACCOUNT_LIBRARY_FORMAT,
    account: target,
    includeUnknown,
    exported_at: input.now ?? Date.now(),
    posts,
    folders,
  }
}

export function accountLibraryFileName(account: string, now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10)
  const slug = account === UNKNOWN_ACCOUNT ? 'unknown' : account
  return `bookmark-keeper-${slug}-${day}.json`
}

export function serializeAccountLibrary(file: AccountLibraryFile): string {
  return file.posts.length <= 5000 ? JSON.stringify(file, null, 2) : JSON.stringify(file)
}
