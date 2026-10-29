import { XApiError } from '@/api/errors'
import { parseThread } from '@/api/parser'
import { db } from '@/db/db'
import { markUnbookmarked, removeLocal } from '@/db/posts'
import { STORAGE_KEYS, type TaskProgress } from '@/shared/types'
import { bumpDbVersion, getSettings } from '@/shared/storage'
import type { XClient } from '@/api/client'

let current: { id: string; cancel: boolean } | null = null

async function publish(t: TaskProgress) {
  await chrome.storage.local.set({ [STORAGE_KEYS.task]: t })
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function cancelTask() {
  if (current) current.cancel = true
}

async function runTask(
  kind: TaskProgress['kind'],
  ids: string[],
  step: (id: string) => Promise<void>,
): Promise<TaskProgress> {
  if (current) throw new Error('已有任务在运行')
  const settings = await getSettings()
  const ctl = { id: `${Date.now()}`, cancel: false }
  current = ctl
  const t: TaskProgress = { id: ctl.id, kind, status: 'running', total: ids.length, done: 0, failed: 0, updated_at: Date.now() }
  await publish(t)
  try {
    for (const id of ids) {
      if (ctl.cancel) {
        t.status = 'cancelled'
        break
      }
      try {
        await step(id)
      } catch (e) {
        if (e instanceof XApiError && (e.code === 'auth' || e.code === 'query_id')) throw e
        if (e instanceof XApiError && e.code === 'rate_limit') {
          const wait = Math.max(5000, (e.resetAt ?? Date.now() + 60_000) - Date.now())
          await sleep(Math.min(wait, 15 * 60_000))
          ids.push(id) // 重试一次: 追加到队尾
          t.total++
        } else t.failed++
      }
      t.done++
      t.updated_at = Date.now()
      await publish(t)
      await sleep(rand(settings.delayMinSec, settings.delayMaxSec) * 1000 * 0.5)
    }
    if (t.status === 'running') t.status = 'done'
  } catch (e) {
    t.status = 'error'
    t.error = (e as Error).message
  } finally {
    current = null
    t.updated_at = Date.now()
    await publish(t)
    await bumpDbVersion()
  }
  return t
}

/** 批量取消 X 端书签。removeLocal=true 则本地也物理删除, 否则仅标记 unbookmarked (保留) */
export function deleteBookmarks(client: XClient, ids: string[], removeLocalToo: boolean) {
  return runTask('delete', [...ids], async (id) => {
    await client.deleteBookmark(id)
    if (removeLocalToo) await removeLocal([id])
    else await markUnbookmarked([id])
  })
}

/** 把本地已归类的书签推送到 X 文件夹 (best-effort) */
export function pushFolder(client: XClient, ids: string[], folderName: string) {
  return runTask('folder', [...ids], async (id) => {
    const f = await db.folders.get(folderName)
    if (!f?.x_id) throw new Error('该文件夹不是 X 端文件夹')
    await client.addToFolder(id, f.x_id)
  })
}

export function fetchThreads(client: XClient, ids: string[]) {
  return runTask('threads', [...ids], async (id) => {
    const json = await client.getTweetDetail(id)
    await db.posts.update(id, { thread: parseThread(json, id), thread_fetched_at: Date.now() })
  })
}
