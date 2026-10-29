// @ts-nocheck
/**
 * 端到端冒烟: 真实 Chrome + 加载 dist/ 扩展 + 本地 Mock X (HTTPS, 自签名证书)。
 * 覆盖: 凭证捕获 → queryId 失效(404)自动重新扫描 → 全量同步分页 → 429 退避 → 文件夹 → 线程 → UI 搜索 → 批量取消书签 → 增量同步 → 全量同步检测移除。
 * 用法: npm run build && npm run e2e
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import puppeteer, { type Page } from 'puppeteer-core'
import { bookmarkId, startMock, type MockState } from './mock-x-server'

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const OUT = process.env.E2E_OUT || '/tmp/bk-e2e'
mkdirSync(OUT, { recursive: true })
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${OUT}/key.pem -out ${OUT}/cert.pem -days 2 -subj "/CN=x.com" -addext "subjectAltName=DNS:x.com,DNS:abs.twimg.com" 2>/dev/null`)

const state: MockState = { total: 250, removed: new Set(), log: [], deletedIds: [], rateLimitOnce: true, rateLimitResetMs: 1000, authHeadersSeen: [] }
const server = await startMock(state, 8443)
const results: [string, boolean, string?][] = []
const check = (name: string, ok: boolean, note?: string) => {
  results.push([name, ok, note])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [process.cwd() + '/dist'],
  args: ['--no-sandbox', '--ignore-certificate-errors', '--host-resolver-rules=MAP x.com 127.0.0.1:8443, MAP abs.twimg.com 127.0.0.1:8443'],
})
try {
  await sleep(1500)
  const sw = browser.targets().find((t) => t.type() === 'service_worker')!
  const id = sw.url().split('/')[2]
  const ext = (p: string) => `chrome-extension://${id}/${p}`

  // 1. 打开模拟的 x.com 书签页 → webRequest 捕获凭证
  const xpage = await browser.newPage()
  await xpage.goto('https://x.com/i/bookmarks')
  await sleep(1500)
  const ui = await browser.newPage()
  await ui.evaluateOnNewDocument(() => { (window as any).__name = (t: unknown) => t }) // tsx keepNames 兼容
  const errors: string[] = []
  ui.on('pageerror', (e) => errors.push(e.message))
  await ui.goto(ext('options.html'))
  const msg = (m: object) => ui.evaluate((x) => chrome.runtime.sendMessage(x), m as any)
  const auth = await msg({ type: 'auth/status' })
  check('webRequest 捕获 Bearer/csrf', auth.data.hasAuth === true)
  const learned = await ui.evaluate(() => chrome.storage.local.get('bk_query_ids'))
  check('从页面请求学到 queryId (PAGE_OLD)', learned.bk_query_ids?.Bookmarks === 'PAGE_OLD_QID_XXXXXX', JSON.stringify(learned.bk_query_ids))

  // 设置: 关闭延迟加速, 开启线程
  await ui.evaluate(() => chrome.storage.local.set({ bk_settings: { lang: 'zh', syncFolders: true, detectDeleted: true, fetchThreads: false, delayMinSec: 0, delayMaxSec: 0, pageSize: 100, pushFolderMoveToX: false, confirmBulkDelete: true, llm: { endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'm', batchSize: 20, intervalMs: 0, allowNewFolders: false } } }))

  // 2. 全量同步: 默认 queryId 过期(页面学到的也是旧的) → 404 → 重新扫描 bundle → 429 → 分页
  await msg({ type: 'sync/start', mode: 'full' })
  const waitProgress = async (pred: (p: any) => boolean, timeout = 60000) => {
    const t0 = Date.now()
    for (;;) {
      const p = (await ui.evaluate(() => chrome.storage.local.get('bk_sync_progress'))).bk_sync_progress
      if (p && pred(p)) return p
      if (Date.now() - t0 > timeout) return p
      await sleep(300)
    }
  }
  let sawWaiting = false
  const p1 = await waitProgress((p) => { if (p.status === 'waiting') sawWaiting = true; return ['done', 'error'].includes(p.status) })
  check('全量同步完成', p1?.status === 'done', JSON.stringify({ status: p1?.status, error: p1?.error, fetched: p1?.fetched, pages: p1?.pages }))
  check('429 限流进入 waiting 并自动继续', sawWaiting)
  check('queryId 404 → 重新扫描 bundle → 使用 FRESH id', state.log.some((l) => l.op === 'Bookmarks' && l.qid === 'FRESH_BOOKMARKS_QID_01' && l.ok))
  const rt = state.authHeadersSeen[state.authHeadersSeen.length - 1] // 扩展自己的最后一次请求
  check('请求带 Authorization/csrf 且 Origin 被 DNR 改写为 https://x.com', rt?.authorization === 'Bearer TEST_BEARER' && rt?.csrf === 'csrf-e2e' && rt?.origin === 'https://x.com', JSON.stringify(rt))

  // 3. UI: 列表/搜索
  await ui.reload()
  await sleep(2500)
  const text = async (page: Page) => page.evaluate(() => document.body.innerText)
  const body = await text(ui)
  check('UI 显示库内 250 条', /库内共 250/.test(body), body.slice(0, 160).replace(/\n/g, ' | '))
  await ui.screenshot({ path: `${OUT}/library.png` })

  const searchFor = async (q: string) => {
    await ui.focus('input.q')
    await ui.keyboard.down('Control')
    await ui.keyboard.press('KeyA')
    await ui.keyboard.up('Control')
    await ui.keyboard.press('Backspace')
    if (q) await ui.type('input.q', q)
    await sleep(700)
    const t = await text(ui)
    if (process.env.E2E_DEBUG) console.log('SEARCH', JSON.stringify(q), JSON.stringify(await ui.$eval('input.q', (e) => e.value)), t.match(/\d+ 条结果/)?.[0], t.match(/⚠.*/)?.[0])
    return Number(/(\d+) 条结果/.exec(t)?.[1] ?? -1)
  }
  const nCn = await searchFor('机器学习')
  check('中文搜索 "机器学习" (正文 50 + 文件夹名命中 2)', nCn === 52, String(nCn))
  const nFrom = await searchFor('from:alice has:image')
  check('from:alice has:image 语法', nFrom > 0 && nFrom < 250, String(nFrom))
  const nFolder = await searchFor('folder:机器学习')
  check('folder: 语法 (X 文件夹同步)', nFolder === 3, String(nFolder))
  const nRust = await searchFor('rust asyn')
  check('英文前缀搜索 "rust asyn"', nRust === 50, String(nRust))
  await ui.screenshot({ path: `${OUT}/search.png` })
  await searchFor('')

  // 4. 批量取消 X 书签 (经消息接口; UI 的二次确认在 SearchView)
  const del = [bookmarkId(0), bookmarkId(1), bookmarkId(2)]
  await msg({ type: 'bookmarks/delete', tweetIds: del, removeLocal: false })
  await sleep(2500)
  check('DeleteBookmark 调用到达 Mock', del.every((d) => state.deletedIds.includes(d)), state.deletedIds.join(','))
  const local = await ui.evaluate(async () => {
    const req = indexedDB.open('bookmark-keeper')
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)))
    const get = (id: string) => new Promise<any>((r) => { const q = db.transaction('posts').objectStore('posts').get(id); q.onsuccess = () => r(q.result) })
    return get('1800000000000000000')
  })
  check('本地保留并标记 unbookmarked', local?.status === 'unbookmarked' && !!local?.text, local?.status)

  // 5. 增量同步: 新增 3 条, 只请求第一页
  state.total = 253
  state.log.length = 0
  await msg({ type: 'sync/start', mode: 'incremental' })
  const p2 = await waitProgress((p) => p.started_at > p1.started_at && ['done', 'error'].includes(p.status))
  const bmCalls = state.log.filter((l) => l.op === 'Bookmarks').length
  check('增量同步遇到已有书签即停 (只 1 页)', p2.status === 'done' && bmCalls === 1 && p2.added >= 3, JSON.stringify({ added: p2.added, bmCalls }))

  // 6. 全量同步检测被移除: X 端删除 id 10 → 本地 unbookmarked
  state.removed.add(bookmarkId(10))
  await msg({ type: 'sync/start', mode: 'full' })
  const p3 = await waitProgress((p) => p.started_at > p2.started_at && ['done', 'error'].includes(p.status))
  const rem = await ui.evaluate(async (id) => {
    const req = indexedDB.open('bookmark-keeper')
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)))
    return new Promise<any>((r) => { const q = db.transaction('posts').objectStore('posts').get(id); q.onsuccess = () => r(q.result?.status) })
  }, bookmarkId(10))
  check('全量同步后标记 X 端已移除书签', p3.status === 'done' && rem === 'unbookmarked', `${p3.status}/${rem}`)

  // 7. 线程抓取
  await msg({ type: 'threads/fetch', tweetIds: [bookmarkId(2 + 3)] })
  await sleep(2500)
  const th = await ui.evaluate(async (id) => {
    const req = indexedDB.open('bookmark-keeper')
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)))
    return new Promise<any>((r) => { const q = db.transaction('posts').objectStore('posts').get(id); q.onsuccess = () => r(q.result?.thread) })
  }, bookmarkId(5))
  check('TweetDetail 线程抓取', Array.isArray(th), JSON.stringify(th)?.slice(0, 100))

  // 8. 其余页面渲染
  for (const [name, file] of [['sidepanel', 'sidepanel.html'], ['popup', 'popup.html']] as const) {
    const pg = await browser.newPage()
    pg.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
    await pg.goto(ext(file))
    await sleep(1200)
    await pg.screenshot({ path: `${OUT}/${name}.png` })
    check(`${name} 页面渲染`, (await text(pg)).includes('Bookmark Keeper'))
  }
  check('页面无未捕获异常', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
  server.close()
}
const failed = results.filter((r) => !r[1])
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
