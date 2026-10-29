/**
 * 分批导出: 默认每批 1000 条, 优先打成一个总 zip (内含 batch_001…), 
 * 超过 ZIP_GROUP 批则拆成多个总 zip。
 */
import type { Post } from '@/shared/types'
import { postsToCsv } from './csv'
import { postsToJson } from './json'
import { postsToMarkdown, postsToObsidianFiles } from './markdown'
import { createZip, type ZipFile } from './zip'

export type BatchExportKind = 'json' | 'csv' | 'md' | 'obsidian'
export const DEFAULT_EXPORT_BATCH_SIZE = 1000
/** 每个下载包最多装多少批文件; 超出则再下一个 zip */
export const BATCHES_PER_ZIP = 10

export interface BatchMeta {
  batchIndex: number // 1-based
  batchTotal: number
  start: number // 1-based overall
  end: number
  fromTime?: string
  toTime?: string
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export function batchFileName(kind: BatchExportKind, meta: BatchMeta, totalPosts: number): string {
  const tw = Math.max(3, String(meta.batchTotal).length)
  const nw = Math.max(4, String(totalPosts).length)
  const range = `${pad(meta.start, nw)}-${pad(meta.end, nw)}`
  const base = `bookmarks_${pad(meta.batchIndex, tw)}_of_${pad(meta.batchTotal, tw)}_${range}`
  switch (kind) {
    case 'json':
      return `${base}.json`
    case 'csv':
      return `${base}.csv`
    case 'md':
      return `${base}.md`
    case 'obsidian':
      return `${base}_obsidian`
  }
}

function timeRange(posts: Post[]): { fromTime?: string; toTime?: string } {
  if (!posts.length) return {}
  let min = posts[0].created_at
  let max = posts[0].created_at
  for (const p of posts) {
    if (p.created_at < min) min = p.created_at
    if (p.created_at > max) max = p.created_at
  }
  return { fromTime: new Date(min).toISOString().slice(0, 10), toTime: new Date(max).toISOString().slice(0, 10) }
}

export function chunkPosts<T>(arr: T[], size: number): T[][] {
  const s = Math.max(1, size)
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s))
  return out
}

function renderBatch(kind: BatchExportKind, posts: Post[]): string | ZipFile[] {
  switch (kind) {
    case 'json':
      return postsToJson(posts)
    case 'csv':
      return postsToCsv(posts, { bom: true })
    case 'md':
      return postsToMarkdown(posts, { frontmatter: false })
    case 'obsidian':
      return postsToObsidianFiles(posts).map((f) => ({ name: f.name, data: f.data }))
  }
}

export interface BuiltZip {
  filename: string
  data: Uint8Array
  batchFrom: number
  batchTo: number
}

export interface BuildBatchExportResult {
  zips: BuiltZip[]
  batchTotal: number
  postTotal: number
}

/**
 * 把 posts 按 batchSize 切片, 生成一个或多个 zip。
 * 每个 zip 内含若干 batch 文件 (或 obsidian 时每批一个子目录)。
 */
export function buildBatchExport(
  kind: BatchExportKind,
  posts: Post[],
  batchSize = DEFAULT_EXPORT_BATCH_SIZE,
  batchesPerZip = BATCHES_PER_ZIP,
): BuildBatchExportResult {
  const chunks = chunkPosts(posts, batchSize)
  const batchTotal = Math.max(1, chunks.length)
  const stamp = new Date().toISOString().slice(0, 10)
  const zips: BuiltZip[] = []

  if (!posts.length) {
    const empty = kind === 'obsidian' ? createZip([{ name: 'empty/.keep', data: '' }]) : createZip([{ name: batchFileName(kind, { batchIndex: 1, batchTotal: 1, start: 0, end: 0 }, 0), data: kind === 'json' ? '[]' : '' }])
    return {
      zips: [{ filename: `bookmarks_batch_${stamp}_1of1.zip`, data: empty, batchFrom: 1, batchTo: 1 }],
      batchTotal: 1,
      postTotal: 0,
    }
  }

  for (let z = 0; z < batchTotal; z += batchesPerZip) {
    const group = chunks.slice(z, z + batchesPerZip)
    const files: ZipFile[] = []
    const batchFrom = z + 1
    const batchTo = z + group.length
    for (let i = 0; i < group.length; i++) {
      const batchIndex = z + i + 1
      const start = z * batchSize + i * batchSize + 1
      const end = start + group[i].length - 1
      const tr = timeRange(group[i])
      const meta: BatchMeta = { batchIndex, batchTotal, start, end, ...tr }
      const name = batchFileName(kind, meta, posts.length)
      const rendered = renderBatch(kind, group[i])
      if (kind === 'obsidian' && Array.isArray(rendered)) {
        const dir = name
        for (const f of rendered) files.push({ name: `${dir}/${f.name}`, data: f.data })
        files.push({
          name: `${dir}/_batch_meta.json`,
          data: JSON.stringify({ ...meta, count: group[i].length }, null, 2),
        })
      } else {
        const body = typeof rendered === 'string' ? rendered : ''
        // 在 JSON 导出时附加 meta 头注释不合适; 另写 sidecar meta
        files.push({ name, data: body })
        files.push({
          name: name.replace(/\.(json|csv|md)$/, '.meta.json'),
          data: JSON.stringify({ ...meta, count: group[i].length, kind }, null, 2),
        })
      }
    }
    const zipCount = Math.ceil(batchTotal / batchesPerZip)
    const zipIdx = Math.floor(z / batchesPerZip) + 1
    const filename =
      zipCount === 1
        ? `bookmarks_batch_${kind}_${stamp}_${pad(batchTotal, 3)}batches.zip`
        : `bookmarks_batch_${kind}_${stamp}_part${pad(zipIdx, 2)}_of_${pad(zipCount, 2)}_b${pad(batchFrom, 3)}-${pad(batchTo, 3)}.zip`
    zips.push({ filename, data: createZip(files), batchFrom, batchTo })
  }

  return { zips, batchTotal, postTotal: posts.length }
}
