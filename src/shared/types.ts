/** 本地存储的书签推文记录 */
export type PostStatus = 'active' | 'tweet_deleted' | 'unbookmarked'
/** bookmark = 书签库; timeline = UserTweets 抓取的公开发帖 */
export type PostSource = 'bookmark' | 'timeline'

export interface MediaItem {
  type: 'photo' | 'video' | 'animated_gif'
  /** 预览图 (photo 即原图 URL) */
  url: string
  /** 视频/GIF 最高码率 mp4 */
  video_url?: string
  duration_ms?: number
  width?: number
  height?: number
  alt?: string
}

export interface QuotedPost {
  tweet_id: string
  screen_name: string
  name: string
  text: string
}

export interface ThreadItem {
  tweet_id: string
  text: string
  created_at: number
  media: MediaItem[]
}

export interface Metrics {
  replies: number
  retweets: number
  likes: number
  quotes: number
  bookmarks: number
  views: number
}

export interface Post {
  /** 主键 */
  tweet_id: string
  /** X 书签排序值 (补零到定长字符串, 越大越新加入书签) */
  sort_index: string
  user_id: string
  screen_name: string
  name: string
  avatar: string
  /** 毫秒时间戳 */
  created_at: number
  text: string
  lang: string
  urls: string[]
  media: MediaItem[]
  quoted?: QuotedPost
  metrics: Metrics
  /** 布尔索引一律存 0/1 (IndexedDB 不能索引 boolean) */
  has_image: 0 | 1
  has_video: 0 | 1
  has_link: 0 | 1
  has_quote: 0 | 1
  /**
   * Twitter Article / article-like attachment.
   * Optional for older records; classify falls back to URL heuristics when missing.
   */
  has_article?: 0 | 1
  /** 文件夹名,空字符串=未归类 */
  folder: string
  tags: string[]
  status: PostStatus
  deleted_at?: number
  /** 同作者线程中的其余推文 */
  thread?: ThreadItem[]
  thread_fetched_at?: number
  note?: string
  /** 首次入库时间 */
  saved_at: number
  /** 最近一次被同步看到的 run id (用于全量同步后检测被移除的书签) */
  sync_run: string
  url: string
  /**
   * 数据来源。缺省/旧数据视为 bookmark。
   * timeline 帖会放入文件夹 timeline:@handle, 与书签分区。
   */
  source?: PostSource
}

export interface Folder {
  /** 本地主键 = 名称 */
  name: string
  /** X 端文件夹 id; 本地自建为空 */
  x_id?: string
  source: 'x' | 'local'
  created_at: number
}

// ---------------- 同步 ----------------
export type SyncMode = 'incremental' | 'full' | 'resume'
export type SyncPhase = 'idle' | 'bookmarks' | 'folders' | 'threads' | 'detect' | 'timeline' | 'done'
export type SyncStatus = 'idle' | 'running' | 'paused' | 'waiting' | 'error' | 'cancelled' | 'done'

export interface SyncProgress {
  status: SyncStatus
  phase: SyncPhase
  mode: SyncMode
  run_id: string
  started_at: number
  updated_at: number
  pages: number
  fetched: number
  added: number
  updated: number
  /** 断点续传游标 (书签) */
  cursor?: string
  /** 当前文件夹 */
  folder?: string
  /** 限流等待到的时间戳 */
  wait_until?: number
  error?: string
  error_code?: 'auth' | 'rate_limit' | 'network' | 'data' | 'timeout' | 'query_id'
  message?: string
  /** timeline 同步目标 handle (不含 @) */
  handle?: string
  /** timeline 同步目标 userId */
  user_id?: string
  /** 同步种类: 缺省/旧数据视为 bookmark */
  kind?: 'bookmark' | 'timeline'
}

export interface AuthInfo {
  token: string
  csrf: string
  uuid: string
  transaction_id: string
  captured_at: number
}

// ---------------- 设置 ----------------
export type Lang = 'zh' | 'en'

export interface LlmConfig {
  endpoint: string // OpenAI 兼容 base, 例如 https://api.openai.com/v1
  apiKey: string
  model: string
  batchSize: number
  /** 每批之间的最小间隔 (ms) */
  intervalMs: number
  allowNewFolders: boolean
}

export interface Settings {
  lang: Lang
  syncFolders: boolean
  detectDeleted: boolean
  fetchThreads: boolean
  /** 页间随机延迟(秒) */
  delayMinSec: number
  delayMaxSec: number
  pageSize: number
  /** 手动移动文件夹时是否同步到 X (best-effort, 未验证) */
  pushFolderMoveToX: boolean
  confirmBulkDelete: boolean
  /** 分批导出每批条数 (默认 1000) */
  exportBatchSize: number
  llm: LlmConfig
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'zh',
  syncFolders: true,
  detectDeleted: true,
  fetchThreads: false,
  delayMinSec: 1,
  delayMaxSec: 3,
  pageSize: 100,
  pushFolderMoveToX: false,
  confirmBulkDelete: true,
  exportBatchSize: 1000,
  llm: {
    endpoint: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    batchSize: 20,
    intervalMs: 2000,
    allowNewFolders: false,
  },
}

// ---------------- 消息 ----------------
export type BgRequest =
  | { type: 'sync/start'; mode: SyncMode }
  | { type: 'sync/pause' }
  | { type: 'sync/resume' }
  | { type: 'sync/cancel' }
  | { type: 'sync/status' }
  | { type: 'timeline/start'; handle: string }
  | { type: 'timeline/startSelf' }
  | { type: 'timeline/pause' }
  | { type: 'timeline/resume' }
  | { type: 'timeline/cancel' }
  | { type: 'timeline/status' }
  | { type: 'bookmarks/delete'; tweetIds: string[]; removeLocal: boolean }
  | { type: 'folder/push'; tweetIds: string[]; folder: string }
  | { type: 'threads/fetch'; tweetIds: string[] }
  | { type: 'auth/status' }
  | { type: 'queryids/refresh' }
  | { type: 'queryids/get' }
  | { type: 'ui/openLibrary' }

export interface BgResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export const STORAGE_KEYS = {
  auth: 'bk_auth',
  settings: 'bk_settings',
  progress: 'bk_sync_progress',
  timelineProgress: 'bk_timeline_progress',
  queryIds: 'bk_query_ids',
  dbVersion: 'bk_db_version',
  printIds: 'bk_print_ids',
  rate: 'bk_rate_limit',
  task: 'bk_task',
  /** Last successful full bookmark sync report meta */
  lastFullSync: 'bk_last_full_sync',
  /** Library table visible columns (LibraryColumnId[]) */
  libraryColumns: 'bk_library_columns',
} as const

/** 时间线帖子的本地文件夹前缀, 形如 timeline:@alice */
export const TIMELINE_FOLDER_PREFIX = 'timeline:@'

export function timelineFolder(handle: string): string {
  return `${TIMELINE_FOLDER_PREFIX}${handle.replace(/^@/, '').toLowerCase()}`
}

export function postSource(p: { source?: PostSource }): PostSource {
  return p.source === 'timeline' ? 'timeline' : 'bookmark'
}

/** 后台批量任务 (取消书签 / 推送文件夹 / 抓线程) 的进度 */
export interface TaskProgress {
  id: string
  kind: 'delete' | 'folder' | 'threads'
  status: 'running' | 'done' | 'error' | 'cancelled'
  total: number
  done: number
  failed: number
  error?: string
  updated_at: number
}

/** Persisted after a successful full bookmark sync (for the sync report UI) */
export interface LastFullSyncMeta {
  at: number
  /** Bookmarks processed/fetched in that run */
  syncedInRun: number
  run_id: string
  mode: SyncMode
  /** UI should open the report once (cleared after shown) */
  pendingReport?: boolean
}

/** Library table column visibility prefs (v0.4+) */
export type LibraryColumnId =
  | 'index'
  | 'user'
  | 'folder'
  | 'post'
  | 'media'
  | 'views'
  | 'reposts'
  | 'favorites'
  | 'replies'
  | 'created_at'

export const DEFAULT_LIBRARY_COLUMNS: LibraryColumnId[] = [
  'index',
  'user',
  'folder',
  'post',
  'media',
  'views',
  'reposts',
  'favorites',
  'replies',
  'created_at',
]
