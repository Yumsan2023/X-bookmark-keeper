import type { Post } from '@/shared/types'

export interface MediaDownload {
  url: string
  /** 相对于浏览器下载目录的路径 */
  filename: string
  tweet_id: string
}

function ext(url: string, fallback: string): string {
  const fmt = /[?&]format=([a-z0-9]+)/i.exec(url)
  if (fmt) return fmt[1].toLowerCase()
  const path = url.split(/[?#]/)[0].replace(/:[a-z]+$/i, '')
  const m = /\.([a-z0-9]{2,4})$/i.exec(path)
  return (m?.[1] ?? fallback).toLowerCase()
}

/** 图片取 :orig 原图; 视频/GIF 取最高码率 mp4。文件名: 根目录/作者/tweetId_序号.ext */
export function collectMediaDownloads(posts: Post[], root = 'BookmarkKeeper/media'): MediaDownload[] {
  const out: MediaDownload[] = []
  for (const p of posts) {
    p.media.forEach((m, i) => {
      const isPhoto = m.type === 'photo'
      const url = isPhoto ? (m.url.includes('?') || m.url.endsWith(':orig') ? m.url : `${m.url}:orig`) : (m.video_url ?? m.url)
      if (!url) return
      const e = isPhoto ? ext(m.url, 'jpg') : ext(url, 'mp4')
      out.push({ url, filename: `${root}/${p.screen_name || 'unknown'}/${p.tweet_id}_${i + 1}.${e}`, tweet_id: p.tweet_id })
    })
  }
  return out
}
