/**
 * 本地 Mock "X" 服务: 仅用于端到端冒烟测试 (e2e/run.ts), 不是对真实 X 的验证。
 * Chrome 通过 --host-resolver-rules 把 x.com / abs.twimg.com 映射到这里。
 */
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { bookmarksPage, cursorEntry, folderTimelinePage, foldersResponse, threadResponse, tweet, tweetEntry } from '../tests/fixtures/builders'

export const FRESH_QID: Record<string, string> = {
  Bookmarks: 'FRESH_BOOKMARKS_QID_01',
  BookmarkFoldersSlice: 'FRESH_FOLDERS_QID_001',
  BookmarkFolderTimeline: 'FRESH_FOLDERTL_QID_01',
  TweetDetail: 'FRESH_TWEETDETAIL_QID',
  DeleteBookmark: 'FRESH_DELETEBM_QID_001',
}

export interface MockState {
  total: number
  removed: Set<string>
  log: { op: string; qid: string; ok: boolean; note?: string }[]
  deletedIds: string[]
  rateLimitOnce: boolean
  rateLimitResetMs: number
  authHeadersSeen: { authorization?: string; csrf?: string; origin?: string; referer?: string }[]
}

const TEXTS = [
  '机器学习入门:从线性回归到神经网络',
  'Learning Rust async programming with tokio',
  '深度学习与自然语言处理的最新进展 https://example.com/nlp',
  'Best pasta recipe ever',
  'TypeScript tips: satisfies operator &amp; const type params',
]

export function bookmarkId(i: number) {
  return String(1800000000000000000n + BigInt(i))
}

export function makeBookmark(i: number) {
  const authors = ['alice', 'bob', 'carol']
  const a = authors[i % 3]
  return tweet({
    id: bookmarkId(i),
    text: `#${i} ${TEXTS[i % TEXTS.length]}`,
    screen_name: a,
    name: a.toUpperCase(),
    user_id: `u_${a}`,
    created_at: new Date(Date.UTC(2024, i % 12, 1 + (i % 27))).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT/, '$1 $3 $2 $5 +0000 $4'),
    photos: i % 4 === 0 ? [`https://pbs.twimg.com/media/IMG${i}.jpg`] : undefined,
    video: i % 7 === 0 ? { thumb: `https://pbs.twimg.com/thumb/${i}.jpg`, variants: [{ bitrate: 100, content_type: 'video/mp4', url: `https://video.twimg.com/v${i}.mp4` }] } : undefined,
    urls: i % 5 === 0 ? [{ url: `https://t.co/l${i}`, expanded_url: `https://example.com/p/${i}` }] : undefined,
    likes: i * 3,
    conversation_id: i === 2 ? bookmarkId(2) : undefined,
  })
}

export function startMock(state: MockState, port = 8443) {
  const opts = { key: readFileSync('/tmp/bk-e2e/key.pem'), cert: readFileSync('/tmp/bk-e2e/cert.pem') }
  const server = https.createServer(opts, (req, res) => {
    const url = new URL(req.url!, 'https://x.com')
    const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' }
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()

    if (url.pathname === '/i/bookmarks') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return void res.end(`<!doctype html><script src="https://abs.twimg.com/responsive-web/client-web/main.e2e123.js"></script>
        <script>
        // 模拟 x.com 页面自己发出的请求 (带 Bearer / csrf / uuid), 扩展用 webRequest 捕获
        fetch('/i/api/graphql/PAGE_OLD_QID_XXXXXX/Bookmarks?variables=%7B%7D', { headers: { authorization: 'Bearer TEST_BEARER', 'x-csrf-token': 'csrf-e2e', 'x-client-uuid': 'uuid-e2e', 'x-client-transaction-id': 'tx-e2e' }, credentials: 'include' }).catch(() => {})
        </script>`)
    }
    if (url.pathname.endsWith('.js') && url.pathname.includes('client-web')) {
      const defs = Object.entries(FRESH_QID).map(([op, id]) => `{queryId:"${id}",operationName:"${op}",operationType:"query",metadata:{}}`).join(',')
      res.writeHead(200, { 'content-type': 'application/javascript', ...cors })
      return void res.end(`var x=[${defs}];`)
    }
    const m = /^\/i\/api\/graphql\/([^/]+)\/(\w+)$/.exec(url.pathname)
    if (!m) return void res.writeHead(404).end('nf')
    const [, qid, op] = m
    if (process.env.E2E_DEBUG) console.log('REQ', op, qid, JSON.stringify({ m: req.method, origin: req.headers.origin, referer: req.headers.referer, site: req.headers['sec-fetch-site'] }))
    state.authHeadersSeen.push({ authorization: req.headers.authorization as string, csrf: req.headers['x-csrf-token'] as string, origin: req.headers.origin as string, referer: req.headers.referer as string })
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      state.log.push({ op, qid, ok: status === 200 })
      res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
        if (FRESH_QID[op] !== qid) return void send(404, 'unknown query id')
    if (req.headers.authorization !== 'Bearer TEST_BEARER' || req.headers['x-csrf-token'] !== 'csrf-e2e') return void send(403, '{"errors":[{"message":"forbidden"}]}')

    if (op === 'Bookmarks') {
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false
        return void send(429, '{}', { 'x-rate-limit-reset': String(Math.ceil((Date.now() + state.rateLimitResetMs) / 1000)) })
      }
      const vars = JSON.parse(url.searchParams.get('variables') ?? '{}')
      const start = vars.cursor ? Number(vars.cursor.replace('c', '')) : 0
      const count = Math.min(vars.count ?? 100, 100)
      const alive = Array.from({ length: state.total }, (_, i) => state.total - 1 - i).filter((i) => !state.removed.has(bookmarkId(i)))
      const slice = alive.slice(start, start + count)
      const entries: any[] = slice.map((i, k) => tweetEntry(makeBookmark(i), String(9_000_000_000_000_000_000n - BigInt(start + k)), k % 2 === 0))
      entries.push(cursorEntry(`c${start + slice.length}`), cursorEntry('top', 'Top'))
      return void send(200, bookmarksPage(entries), { 'x-rate-limit-limit': '500', 'x-rate-limit-remaining': '400', 'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 900) })
    }
    if (op === 'BookmarkFoldersSlice') return void send(200, foldersResponse([{ id: 'F1', name: '机器学习' }, { id: 'F2', name: 'Dev' }]))
    if (op === 'BookmarkFolderTimeline') {
      const vars = JSON.parse(url.searchParams.get('variables') ?? '{}')
      if (vars.cursor) return void send(200, folderTimelinePage([]))
      const ids = vars.bookmark_collection_id === 'F1' ? [0, 4, 8] : [1, 5]
      return void send(200, folderTimelinePage([...ids.map((i) => tweetEntry(makeBookmark(i), String(50 - i))), cursorEntry('fc1')]))
    }
    if (op === 'TweetDetail') {
      const vars = JSON.parse(url.searchParams.get('variables') ?? '{}')
      const focal = makeBookmark(Number(BigInt(vars.focalTweetId) - 1800000000000000000n))
      const other = tweet({ id: String(BigInt(vars.focalTweetId) + 500n), text: '续: thread part 2', screen_name: (focal as any).core.user_results.result.legacy.screen_name, user_id: (focal as any).legacy.user_id_str, conversation_id: (focal as any).legacy.conversation_id_str })
      return void send(200, threadResponse(focal, [{ tweet: other, module: true }]))
    }
    if (op === 'DeleteBookmark') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const j = JSON.parse(body)
        state.removed.add(j.variables.tweet_id)
        state.deletedIds.push(j.variables.tweet_id)
        send(200, { data: { tweet_bookmark_delete: 'Done' } })
      })
      return
    }
    send(404, 'op?')
  })
  return new Promise<https.Server>((r) => server.listen(port, '127.0.0.1', () => r(server)))
}
