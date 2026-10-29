/**
 * GraphQL operation 名称 + 写死的默认 queryId (兜底)。
 * queryId 会随 X 前端发版变化; 实际使用的值优先级:
 *   1. 从 x.com 页面自己发出的请求学到的 (webRequest, 见 background/auth-capture.ts)
 *   2. 从 x.com 的 JS bundle 里扫描到的 (queryid-discovery.ts)
 *   3. 本文件中的默认值 (可能已过期)
 */
export const GRAPHQL_BASE = 'https://x.com/i/api/graphql'

export type OperationName =
  | 'Bookmarks'
  | 'DeleteBookmark'
  | 'CreateBookmark'
  | 'BookmarkFoldersSlice'
  | 'BookmarkFolderTimeline'
  | 'bookmarkTweetToFolder'
  | 'RemoveTweetFromBookmarkFolder'
  | 'TweetDetail'
  | 'UserTweets'
  | 'UserByScreenName'

export const OPERATIONS: OperationName[] = [
  'Bookmarks',
  'DeleteBookmark',
  'CreateBookmark',
  'BookmarkFoldersSlice',
  'BookmarkFolderTimeline',
  'bookmarkTweetToFolder',
  'RemoveTweetFromBookmarkFolder',
  'TweetDetail',
  'UserTweets',
  'UserByScreenName',
]

/** 默认值取自公开资料, 均可能过期 (未对真实账号验证) */
export const DEFAULT_QUERY_IDS: Record<OperationName, string> = {
  Bookmarks: 'UyNF_BgJ5d5MbtuVukyl7A',
  DeleteBookmark: 'Wlmlj2-xzyS1GN3a6cj-mQ',
  CreateBookmark: 'aoDbu3RHznuiSkQ9aNM67Q',
  BookmarkFoldersSlice: 'i78YDd0Tza-dV4SYs58kRg',
  BookmarkFolderTimeline: 'e1T8IKkMr-8iQk7tNOyD_g',
  bookmarkTweetToFolder: '4KHZvvNbHNf07bsgnL9gWA',
  RemoveTweetFromBookmarkFolder: '2Qbj9XZvtUvyJB4gFwWfaA',
  TweetDetail: 'bFUhQzgl9zjo-teD0pAQZw',
  // 公开资料中的常见默认值, 可能过期; 运行时优先用页面学习 / bundle 扫描
  UserTweets: 'E3opETHurmVJflFsUv564Q',
  UserByScreenName: 'G3KFLIQZb82oVpVkSy3szQ',
}

export type QueryIdMap = Partial<Record<OperationName, string>>

export function buildUrl(op: OperationName, queryId: string): string {
  return `${GRAPHQL_BASE}/${queryId}/${op}`
}

/** 从 URL 中解析 operation 与 queryId, 例如 https://x.com/i/api/graphql/abc/Bookmarks?variables=.. */
export function parseGraphqlUrl(url: string): { queryId: string; op: string } | null {
  const m = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_]+)/.exec(url)
  return m ? { queryId: m[1], op: m[2] } : null
}
