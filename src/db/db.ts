import Dexie, { type Table } from 'dexie'
import type { Folder, Post } from '@/shared/types'

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
  }
}

export const db = new BookmarkDB()
