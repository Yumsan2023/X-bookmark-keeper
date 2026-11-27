import Dexie, { type Table } from 'dexie'
import type { CleanupQueueRow, ColdTombstoneRow, Folder, Post } from '@/shared/types'
import type { ForYouDecisionRow, ForYouProfileRow, ForYouValidationRow } from '@/foryou/types'

export interface SearchMetaRow {
  key: string
  /** chrome.storage bk_db_version at time of index build */
  dbVersion: number
  postCount: number
  updatedAt: number
  /** MiniSearch.toJSON() payload */
  indexJson: object
}

export class BookmarkDB extends Dexie {
  posts!: Table<Post, string>
  folders!: Table<Folder, string>
  searchMeta!: Table<SearchMetaRow, string>
  foryouProfile!: Table<ForYouProfileRow, string>
  foryouDecisions!: Table<ForYouDecisionRow, string>
  foryouValidations!: Table<ForYouValidationRow, string>
  cleanupQueue!: Table<CleanupQueueRow, string>
  coldTombstones!: Table<ColdTombstoneRow, string>

  constructor(name = 'bookmark-keeper') {
    super(name)
    // 索引: tweet_id(主键), sort_index, screen_name, created_at, folder, status, has_* , tags(multiEntry)
    this.version(1).stores({
      posts:
        'tweet_id, sort_index, screen_name, created_at, folder, status, sync_run, has_image, has_video, has_link, has_quote, *tags',
      folders: 'name, x_id, source',
    })
    // v2: 持久化搜索索引元数据; posts/folders schema 不变, 用户数据兼容
    this.version(2).stores({
      posts:
        'tweet_id, sort_index, screen_name, created_at, folder, status, sync_run, has_image, has_video, has_link, has_quote, *tags',
      folders: 'name, x_id, source',
      searchMeta: 'key',
    })
    // v3: posts 增加 source 索引 (bookmark | timeline), 与书签分区
    this.version(3).stores({
      posts:
        'tweet_id, sort_index, screen_name, created_at, folder, status, sync_run, source, has_image, has_video, has_link, has_quote, *tags',
      folders: 'name, x_id, source',
      searchMeta: 'key',
    })
    // v4: multiEntry accounts (which X account bookmarked the post). Old rows get accounts: [].
    this.version(4)
      .stores({
        posts:
          'tweet_id, sort_index, screen_name, created_at, folder, status, sync_run, source, has_image, has_video, has_link, has_quote, *tags, *accounts',
        folders: 'name, x_id, source',
        searchMeta: 'key',
      })
      .upgrade((tx) =>
        tx
          .table('posts')
          .toCollection()
          .modify((post) => {
            if (!Array.isArray(post.accounts)) post.accounts = []
          }),
      )
    // v5 (M2): 只加 For You 的三张表, posts/folders/searchMeta 不动, 旧数据零迁移。
    this.version(5).stores({
      posts:
        'tweet_id, sort_index, screen_name, created_at, folder, status, sync_run, source, has_image, has_video, has_link, has_quote, *tags, *accounts',
      folders: 'name, x_id, source',
      searchMeta: 'key',
      foryouProfile: 'key',
      foryouDecisions: 'tweet_id, at, decision, feedback',
      foryouValidations: 'id, at',
    })
    // v6 (v2.0): 新增 saved_at 与 [source+status+saved_at] 复合索引加速画像采样与分页;
    // 新增 cleanupQueue (按账号 X 端待清理安全队列) 与 coldTombstones (冷库瘦身墓碑, 防重复回灌).
    this.version(6).stores({
      posts:
        'tweet_id, sort_index, screen_name, created_at, saved_at, folder, status, sync_run, source, [source+status+saved_at], has_image, has_video, has_link, has_quote, *tags, *accounts',
      folders: 'name, x_id, source',
      searchMeta: 'key',
      foryouProfile: 'key',
      foryouDecisions: 'tweet_id, at, decision, feedback',
      foryouValidations: 'id, at',
      cleanupQueue: 'tweet_id, account, status, added_at',
      coldTombstones: 'tweet_id, archived_at',
    })
  }
}

export const db = new BookmarkDB()
