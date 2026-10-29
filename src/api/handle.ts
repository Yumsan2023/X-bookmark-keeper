/**
 * 从 @handle / x.com/xxx / twitter.com/xxx 解析 screen_name。
 * 纯函数, 有单测。
 */
const RESERVED = new Set([
  'i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings',
  'compose', 'login', 'signup', 'logout', 'intent', 'share', 'hashtag', 'tos',
  'privacy', 'about', 'help', 'jobs', 'download', 'account', 'following', 'followers',
])

export function parseHandleOrUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const url = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]+)/i.exec(s)
  if (url) {
    const h = url[1]
    if (!RESERVED.has(h.toLowerCase())) return h
  }
  const bare = s.replace(/^@/, '').trim()
  // 也可能是粘贴的 "https://x.com/foo/status/123" 已被上面捕获
  if (/^[A-Za-z0-9_]{1,15}$/.test(bare) && !RESERVED.has(bare.toLowerCase())) return bare
  return null
}

/** 从 UserByScreenName 响应取出 rest_id + screen_name */
export function parseUserByScreenName(json: any): { userId: string; screenName: string } | null {
  const u =
    json?.data?.user?.result ??
    json?.data?.user_result?.result ??
    json?.data?.user_results?.result
  if (!u) return null
  const userId = String(u.rest_id ?? u.id ?? '')
  const screenName = String(u.core?.screen_name ?? u.legacy?.screen_name ?? '').replace(/^@/, '')
  if (!userId || !screenName) return null
  return { userId, screenName }
}
