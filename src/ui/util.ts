import { buildBatchExport, type BatchExportKind } from '@/export/batch'
import { postsToCsv } from '@/export/csv'
import { postsToJson } from '@/export/json'
import { postsToMarkdown, postsToObsidianFiles } from '@/export/markdown'
import { createZip } from '@/export/zip'
import { collectMediaDownloads } from '@/export/media'
import type { Post } from '@/shared/types'
import { STORAGE_KEYS } from '@/shared/types'

export function saveBlob(filename: string, data: BlobPart, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const stamp = () => new Date().toISOString().slice(0, 10)

export type ExportKind = 'json' | 'csv' | 'md' | 'obsidian'

export function exportPosts(kind: ExportKind, posts: Post[]) {
  switch (kind) {
    case 'json':
      return saveBlob(`bookmarks-${stamp()}.json`, postsToJson(posts), 'application/json')
    case 'csv':
      return saveBlob(`bookmarks-${stamp()}.csv`, postsToCsv(posts, { bom: true }), 'text/csv;charset=utf-8')
    case 'md':
      return saveBlob(`bookmarks-${stamp()}.md`, postsToMarkdown(posts, { frontmatter: false }), 'text/markdown')
    case 'obsidian': {
      const zip = createZip(postsToObsidianFiles(posts).map((f) => ({ name: f.name, data: f.data })))
      return saveBlob(`bookmarks-obsidian-${stamp()}.zip`, zip as unknown as BlobPart, 'application/zip')
    }
  }
}

/** 通过 chrome.downloads 下载 (扩展页可用); 失败时回退 <a download> */
async function downloadBytes(filename: string, data: Uint8Array, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' })
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return
    }
  } catch {
    /* fall through */
  }
  saveBlob(filename, data as unknown as BlobPart, mime)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 分批导出: 优先一个(或少数)总 zip 内含多批文件。
 * onProgress(batchDone, batchTotal, phase)
 */
export async function exportPostsBatched(
  kind: BatchExportKind,
  posts: Post[],
  batchSize: number,
  onProgress?: (done: number, total: number, msg: string) => void,
): Promise<{ zipCount: number; batchTotal: number }> {
  onProgress?.(0, 1, 'building')
  const { zips, batchTotal } = buildBatchExport(kind, posts, batchSize)
  for (let i = 0; i < zips.length; i++) {
    const z = zips[i]
    onProgress?.(z.batchTo, batchTotal, `zip ${i + 1}/${zips.length}`)
    await downloadBytes(z.filename, z.data, 'application/zip')
    // 连续多个 zip 时稍作间隔, 降低浏览器拦截概率
    if (i + 1 < zips.length) await new Promise((r) => setTimeout(r, 400))
  }
  onProgress?.(batchTotal, batchTotal, 'done')
  return { zipCount: zips.length, batchTotal }
}

export async function openPrint(posts: Post[]) {
  await chrome.storage.local.set({ [STORAGE_KEYS.printIds]: posts.map((p) => p.tweet_id) })
  await chrome.tabs.create({ url: chrome.runtime.getURL('print.html') })
}

/** chrome.downloads 批量下载媒体, 每次间隔 300ms 以免浏览器弹出批量下载拦截 */
export async function downloadMedia(posts: Post[], onProgress?: (done: number, total: number) => void) {
  const items = collectMediaDownloads(posts)
  let done = 0
  for (const it of items) {
    try {
      await chrome.downloads.download({ url: it.url, filename: it.filename, conflictAction: 'uniquify' })
    } catch {
      /* 单个失败跳过 */
    }
    done++
    onProgress?.(done, items.length)
    await new Promise((r) => setTimeout(r, 300))
  }
  return items.length
}

export function fmtDate(ms: number, lang: string) {
  return new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false })
}
export function fmtNum(n: number) {
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n)
}
