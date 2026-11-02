import { mergePostTags } from '@/ai/classify'
import type { Folder, Post, PostSource } from '@/shared/types'
import { postSource } from '@/shared/types'
import type { ParsedPost } from '@/api/parser'
import {
  postMatchesAccountExport,
  resolveAccountExportTarget,
  type AccountExportSelection,
} from '@/backup/account-library'
import { UNKNOWN_ACCOUNT, addAccount, decideDelete, normalizeHandle, postAccounts } from '@/shared/accounts'
import { db } from './db'

/** 把解析结果合并进本地记录: 保留本地字段 (标签/文件夹/备注/线程/saved_at/source) */
export function mergePost(
  existing: Post | undefined,
  p: ParsedPost,
  runId: string,
  opts: { folder?: string; keepSortIndex?: boolean; source?: PostSource; account?: string } = {},
): Post {
  const now = Date.now()
  const incomingSource: PostSource = opts.source ?? 'bookmark'
  const account = incomingSource === 'bookmark' ? normalizeHandle(opts.account) : ''
  if (!existing) {
    return {
      ...p,
      folder: opts.folder ?? '',
      tags: [],
      status: 'active',
      saved_at: now,
      sync_run: runId,
      source: incomingSource,
      accounts: account ? [account] : [],
    }
  }
  // 已是书签的帖: 不被 timeline 降级; 文件夹不被 timeline 覆盖
  // timeline 帖再被书签同步命中: 升级为 bookmark, 并清掉 timeline:@ 文件夹(除非显式指定 folder)
  const wasBookmark = postSource(existing) === 'bookmark'
  const nextSource: PostSource = wasBookmark || incomingSource === 'bookmark' ? 'bookmark' : 'timeline'
  let nextFolder: string
  if (incomingSource === 'timeline' && wasBookmark) {
    nextFolder = existing.folder
  } else if (incomingSource === 'bookmark' && opts.folder !== undefined) {
    nextFolder = opts.folder
  } else if (incomingSource === 'bookmark' && postSource(existing) === 'timeline') {
    nextFolder = existing.folder.startsWith('timeline:@') ? '' : existing.folder
  } else {
    nextFolder = opts.folder ?? existing.folder
  }
  return {
    ...existing,
    ...p,
    // 文件夹时间线里的 sortIndex 与书签总表不同, 不覆盖已有值
    sort_index: opts.keepSortIndex || (incomingSource === 'timeline' && wasBookmark) ? existing.sort_index : p.sort_index,
    folder: nextFolder,
    tags: existing.tags,
    note: existing.note,
    thread: existing.thread,
    thread_fetched_at: existing.thread_fetched_at,
    saved_at: existing.saved_at,
    status: 'active',
    deleted_at: undefined,
    sync_run: runId,
    source: nextSource,
    accounts: account ? addAccount(existing.accounts, account) : postAccounts(existing),
  }
}

export interface UpsertResult {
  added: number
  updated: number
  /** 页内已存在的 tweet_id (用于增量同步提前结束) */
  existingIds: string[]
}

export async function upsertParsed(
  parsed: ParsedPost[],
  runId: string,
  opts: { folder?: string; keepSortIndex?: boolean; source?: PostSource; account?: string } = {},
): Promise<UpsertResult> {
  if (!parsed.length) return { added: 0, updated: 0, existingIds: [] }
  const ids = parsed.map((p) => p.tweet_id)
  const existing = await db.posts.bulkGet(ids)
  const existingIds: string[] = []
  let added = 0
  let updated = 0
  const merged = parsed.map((p, i) => {
    const ex = existing[i]
    if (ex) {
      updated++
      // 之前被标记为 "unbookmarked" 的算作新书签, 不触发增量提前结束
      if (ex.status === 'active') existingIds.push(p.tweet_id)
    } else added++
    return mergePost(ex, p, runId, opts)
  })
  await db.posts.bulkPut(merged)
  return { added, updated, existingIds }
}

export async function markTweetsDeleted(ids: string[], runId: string): Promise<number> {
  if (!ids.length) return 0
  const now = Date.now()
  let n = 0
  await db.transaction('rw', db.posts, async () => {
    for (const id of ids) {
      const p = await db.posts.get(id)
      if (p && p.status !== 'tweet_deleted') {
        await db.posts.update(id, { status: 'tweet_deleted', deleted_at: now, sync_run: runId })
        n++
      } else if (p) {
        await db.posts.update(id, { sync_run: runId })
      }
    }
  })
  return n
}

/**
 * 全量同步结束后: 本次 run 没看到的 active 书签 = X 端已取消书签, 本地标记 unbookmarked (不删除)。
 * safetyMin: 本次 run 看到的书签数低于该值而本地很多时视为异常, 不执行 (防止接口返回空页造成误标)。
 *
 * 有 owner 时只移掉这个账号的标记; 其他账号还在就保持 active, 也不动没有账号的旧数据。
 * 没有 owner 时, 库里已有账号标记, 或调用方说明「本应有账号」(expectAccount), 一律不把空白账号整库标成已取消。
 * 返回 -2 表示因此跳过。
 */
export async function markUnbookmarkedNotSeen(
  runId: string,
  seenCount: number,
  account?: string,
  opts?: { expectAccount?: boolean },
): Promise<number> {
  const isBookmark = (p: Post) => postSource(p) === 'bookmark'
  const owner = normalizeHandle(account)
  if (!owner) {
    if (opts?.expectAccount) return -2
    // No confirmed account, but the library already has account stamps: do not mass-unbookmark other accounts.
    const stamped = await db.posts.orderBy('accounts').limit(1).count()
    if (stamped > 0) return -2
    const bookmarkActive = await db.posts.where('status').equals('active').filter(isBookmark).count()
    if (bookmarkActive > 20 && seenCount < bookmarkActive * 0.3) return -1
    const now = Date.now()
    let n = 0
    await db.posts
      .where('status')
      .equals('active')
      .filter((p) => isBookmark(p) && p.sync_run !== runId)
      .modify((p) => {
        p.status = 'unbookmarked'
        p.deleted_at = now
        n++
      })
    return n
  }
  const owns = (p: Post) => p.status === 'active' && isBookmark(p) && postAccounts(p).includes(owner)
  const ownedActive = await db.posts.where('accounts').equals(owner).filter(owns).count()
  if (ownedActive > 20 && seenCount < ownedActive * 0.3) return -1
  const now = Date.now()
  let n = 0
  await db.posts
    .where('accounts')
    .equals(owner)
    .filter((p) => owns(p) && p.sync_run !== runId)
    .modify((p) => {
      const left = postAccounts(p).filter((a) => a !== owner)
      p.accounts = left
      if (!left.length) {
        p.status = 'unbookmarked'
        p.deleted_at = now
        n++
      }
    })
  return n
}

/** Drop one owning account after X accepted DeleteBookmark. */
export async function releaseBookmark(tweetId: string, account: string, removeLocal: boolean): Promise<'missing' | 'keep' | 'remove' | 'unbookmark'> {
  const post = await db.posts.get(tweetId)
  if (!post) return 'missing'
  const decision = decideDelete(post, account, removeLocal)
  if (decision.kind === 'remove') await db.posts.delete(tweetId)
  else if (decision.kind === 'keep') await db.posts.update(tweetId, { accounts: decision.accounts })
  else await db.posts.update(tweetId, { accounts: decision.accounts, status: 'unbookmarked', deleted_at: Date.now() })
  return decision.kind
}

export async function listBookmarkAccounts(): Promise<{ account: string; count: number }[]> {
  const keys = (await db.posts.orderBy('accounts').uniqueKeys()) as string[]
  const rows = await Promise.all(
    keys.filter((account) => account && account !== UNKNOWN_ACCOUNT).map(async (account) => ({
      account,
      count: await db.posts.where('accounts').equals(account).count(),
    })),
  )
  return rows.sort((a, b) => b.count - a.count || a.account.localeCompare(b.account))
}

/** Bookmarks synced before an account stamp existed. Timeline rows are not included. */
export async function countUnstampedBookmarks(): Promise<number> {
  return db.posts.filter((post) => postMatchesAccountExport(post, { account: UNKNOWN_ACCOUNT })).count()
}

/**
 * Posts for a one-account library export.
 * A named account uses the `accounts` index. Unstamped rows are not in that
 * index, so including them (or exporting only them) reads the table.
 */
async function postsStampedAs(target: string): Promise<Post[]> {
  const keys = ((await db.posts.orderBy('accounts').uniqueKeys()) as string[]).filter((key) => normalizeHandle(key) === target)
  if (!keys.length) return []
  const batches = await Promise.all(keys.map((key) => db.posts.where('accounts').equals(key).toArray()))
  const byId = new Map<string, Post>()
  for (const post of batches.flat()) {
    if (postMatchesAccountExport(post, { account: target })) byId.set(post.tweet_id, post)
  }
  return [...byId.values()]
}

export async function postsForAccountExport(selection: AccountExportSelection): Promise<Post[]> {
  const target = resolveAccountExportTarget(selection.account)
  if (!target) return []
  if (target === UNKNOWN_ACCOUNT) {
    return db.posts.filter((post) => postMatchesAccountExport(post, { account: UNKNOWN_ACCOUNT })).toArray()
  }
  const named = await postsStampedAs(target)
  if (!selection.includeUnknown) return named
  const unknown = await db.posts.filter((post) => postMatchesAccountExport(post, { account: UNKNOWN_ACCOUNT })).toArray()
  const byId = new Map<string, Post>()
  for (const post of [...named, ...unknown]) byId.set(post.tweet_id, post)
  return [...byId.values()]
}

export async function getAllPosts(): Promise<Post[]> {
  return db.posts.toArray()
}

export async function getPosts(ids: string[]): Promise<Post[]> {
  return (await db.posts.bulkGet(ids)).filter(Boolean) as Post[]
}

export async function countPosts(): Promise<number> {
  return db.posts.count()
}

export async function newestActiveSortIndex(): Promise<string | undefined> {
  const last = await db.posts.orderBy('sort_index').filter((p) => p.status === 'active').last()
  return last?.sort_index
}

// ---------------- 标签 ----------------

export function normalizeTag(t: string): string {
  return t.trim().replace(/^#/, '').replace(/\s+/g, '-')
}

export async function addTags(ids: string[], tags: string[]): Promise<void> {
  const norm = tags.map(normalizeTag).filter(Boolean)
  if (!norm.length) return
  await db.transaction('rw', db.posts, async () => {
    await db.posts
      .where('tweet_id')
      .anyOf(ids)
      .modify((p) => {
        p.tags = [...new Set([...(p.tags ?? []), ...norm])]
      })
  })
}

/** One transaction: merge suggested tags onto each post. Does not remove existing tags. */
export async function applyTagsToPosts(assignments: Iterable<[string, string[]]>): Promise<number> {
  const rows = [...assignments].filter(([, tags]) => tags.some((t) => normalizeTag(t)))
  if (!rows.length) return 0
  await db.transaction('rw', db.posts, async () => {
    for (const [id, tags] of rows) {
      await db.posts.where('tweet_id').equals(id).modify((p) => {
        p.tags = mergePostTags(p.tags, tags)
      })
    }
  })
  return rows.length
}

export async function removeTags(ids: string[], tags: string[]): Promise<void> {
  const rm = new Set(tags.map(normalizeTag))
  await db.posts
    .where('tweet_id')
    .anyOf(ids)
    .modify((p) => {
      p.tags = (p.tags ?? []).filter((t) => !rm.has(t))
    })
}

export async function renameTag(from: string, to: string): Promise<number> {
  const t = normalizeTag(to)
  if (!t) return 0
  let n = 0
  await db.posts
    .where('tags')
    .equals(from)
    .modify((p) => {
      p.tags = [...new Set(p.tags.map((x) => (x === from ? t : x)))]
      n++
    })
  return n
}

export async function deleteTag(tag: string): Promise<number> {
  let n = 0
  await db.posts
    .where('tags')
    .equals(tag)
    .modify((p) => {
      p.tags = p.tags.filter((x) => x !== tag)
      n++
    })
  return n
}

/** 用 multiEntry 索引取唯一 tag + where.count(), 避免 each 全表载入阻塞 UI */
export async function listTags(): Promise<{ tag: string; count: number }[]> {
  const keys = (await db.posts.orderBy('tags').uniqueKeys()) as string[]
  const counts = await Promise.all(
    keys.map(async (tag) => ({ tag, count: await db.posts.where('tags').equals(tag).count() })),
  )
  return counts.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** 仅标签名, 不计 count (打开 UI 时可先展示) */
export async function listTagNames(): Promise<string[]> {
  return (await db.posts.orderBy('tags').uniqueKeys()) as string[]
}

export async function setNote(id: string, note: string): Promise<void> {
  await db.posts.update(id, { note })
}

// ---------------- 文件夹 ----------------

/** 文件夹列表: 名称先返回, count 用索引 where.count() 并行补齐, 不 toArray 全表 */
export async function listFolders(): Promise<(Folder & { count: number })[]> {
  const folders = await db.folders.toArray()
  const withCounts = await Promise.all(
    folders.map(async (f) => ({ ...f, count: await db.posts.where('folder').equals(f.name).count() })),
  )
  return withCounts.sort((a, b) => a.name.localeCompare(b.name))
}

export async function listFoldersWithoutCounts(): Promise<Folder[]> {
  return (await db.folders.toArray()).sort((a, b) => a.name.localeCompare(b.name))
}

export async function upsertFolder(f: Folder): Promise<void> {
  const ex = await db.folders.get(f.name)
  await db.folders.put({ ...f, x_id: f.x_id ?? ex?.x_id, created_at: ex?.created_at ?? f.created_at })
}

export async function createLocalFolder(name: string): Promise<void> {
  const n = name.trim()
  if (!n) throw new Error('empty folder name')
  if (await db.folders.get(n)) return
  await db.folders.put({ name: n, source: 'local', created_at: Date.now() })
}

export async function renameFolder(from: string, to: string): Promise<void> {
  const n = to.trim()
  if (!n || n === from) return
  await db.transaction('rw', db.posts, db.folders, async () => {
    const f = await db.folders.get(from)
    if (!f) return
    if (await db.folders.get(n)) throw new Error('folder exists')
    await db.folders.delete(from)
    await db.folders.put({ ...f, name: n })
    await db.posts.where('folder').equals(from).modify({ folder: n })
  })
}

export async function deleteFolder(name: string): Promise<void> {
  await db.transaction('rw', db.posts, db.folders, async () => {
    await db.folders.delete(name)
    await db.posts.where('folder').equals(name).modify({ folder: '' })
  })
}

export async function moveToFolder(ids: string[], folder: string): Promise<void> {
  if (folder) await createLocalFolderIfMissing(folder)
  await db.posts.where('tweet_id').anyOf(ids).modify({ folder })
}

async function createLocalFolderIfMissing(name: string) {
  if (!(await db.folders.get(name))) await db.folders.put({ name, source: 'local', created_at: Date.now() })
}

// ---------------- 删除 / 清空 / 备份 ----------------

export async function removeLocal(ids: string[]): Promise<void> {
  await db.posts.bulkDelete(ids)
}

export async function markUnbookmarked(ids: string[]): Promise<void> {
  const now = Date.now()
  await db.posts.where('tweet_id').anyOf(ids).modify({ status: 'unbookmarked', deleted_at: now })
}

export async function clearAll(): Promise<void> {
  await db.transaction('rw', db.posts, db.folders, db.searchMeta, async () => {
    await db.posts.clear()
    await db.folders.clear()
    await db.searchMeta.clear()
  })
}

/** Bookmark-only snapshot kept for older files. The options page backup is src/backup. */
export interface Backup {
  app: 'bookmark-keeper'
  version: 1
  exported_at: number
  posts: Post[]
  folders: Folder[]
}

export async function createBackup(): Promise<Backup> {
  return {
    app: 'bookmark-keeper',
    version: 1,
    exported_at: Date.now(),
    posts: await db.posts.toArray(),
    folders: await db.folders.toArray(),
  }
}

export function validateBackup(b: any): b is Backup {
  return !!b && b.app === 'bookmark-keeper' && Array.isArray(b.posts) && Array.isArray(b.folders)
}

/** 导入备份: 同 tweet_id 以备份为准合并 (标签取并集) */
export async function importBackup(b: Backup): Promise<{ posts: number; folders: number }> {
  if (!validateBackup(b)) throw new Error('不是有效的 X Toolkit 备份文件')
  const chunk = 500
  for (let i = 0; i < b.posts.length; i += chunk) {
    const part = b.posts.slice(i, i + chunk)
    const existing = await db.posts.bulkGet(part.map((p) => p.tweet_id))
    await db.posts.bulkPut(
      part.map((p, j) => {
        const ex = existing[j]
        const accounts = [...new Set([...postAccounts(ex), ...postAccounts(p)].map((a) => normalizeHandle(a)).filter(Boolean))]
        return ex ? { ...p, tags: [...new Set([...(ex.tags ?? []), ...(p.tags ?? [])])], accounts } : { ...p, accounts }
      }),
    )
  }
  await db.folders.bulkPut(b.folders)
  return { posts: b.posts.length, folders: b.folders.length }
}
