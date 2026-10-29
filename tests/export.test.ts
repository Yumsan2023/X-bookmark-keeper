import { describe, expect, it } from 'vitest'
import { csvEscape, postsToCsv } from '@/export/csv'
import { postsToJson } from '@/export/json'
import { collectMediaDownloads } from '@/export/media'
import { frontmatter, postToMarkdown, postsToMarkdown, postsToObsidianFiles, safeFileName } from '@/export/markdown'
import { createZip, crc32 } from '@/export/zip'
import type { Post } from '@/shared/types'

const base: Post = {
  tweet_id: '123',
  sort_index: '1'.padStart(24, '0'),
  user_id: 'u',
  screen_name: 'alice',
  name: 'Alice "A" Smith',
  avatar: '',
  created_at: Date.UTC(2024, 4, 6, 12),
  text: 'Line one, with comma\nLine "two"',
  lang: 'en',
  urls: ['https://example.com/a'],
  media: [
    { type: 'photo', url: 'https://pbs.twimg.com/media/AAA.jpg', alt: 'cat' },
    { type: 'video', url: 'https://pbs.twimg.com/thumb/x.jpg', video_url: 'https://video.twimg.com/v/high.mp4?tag=12' },
  ],
  quoted: { tweet_id: '9', screen_name: 'bob', name: 'Bob', text: 'quoted text' },
  metrics: { replies: 1, retweets: 2, likes: 3, quotes: 0, bookmarks: 0, views: 4 },
  has_image: 1,
  has_video: 1,
  has_link: 1,
  has_quote: 1,
  folder: 'Dev/Tools',
  tags: ['rust', 'to do'],
  status: 'active',
  saved_at: 0,
  sync_run: 'r',
  url: 'https://x.com/alice/status/123',
  note: 'my note',
  thread: [{ tweet_id: '124', text: 'second part', created_at: 0, media: [] }],
}

describe('csv', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('x\ny')).toBe('"x\ny"')
    expect(csvEscape(null)).toBe('')
    expect(csvEscape(5)).toBe('5')
  })
  it('produces header + rows with BOM option', () => {
    const csv = postsToCsv([base], { bom: true })
    expect(csv.startsWith('\uFEFFtweet_id,url,')).toBe(true)
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Line one, with comma\nLine ""two"""'.split('\n')[0])
    expect(csv).toContain('rust;to do')
    expect(csv).toContain('2024-05-06T12:00:00.000Z')
  })
})

describe('json', () => {
  it('roundtrips', () => {
    expect(JSON.parse(postsToJson([base]))[0].tweet_id).toBe('123')
  })
})

describe('markdown', () => {
  it('writes valid YAML frontmatter with quoted strings', () => {
    const fm = frontmatter(base)
    expect(fm.startsWith('---\n')).toBe(true)
    expect(fm.endsWith('\n---')).toBe(true)
    expect(fm).toContain('author: "Alice \\"A\\" Smith"')
    expect(fm).toContain('tags: ["rust", "to do"]')
    expect(fm).toContain('created: 2024-05-06T12:00:00.000Z')
  })
  it('renders body, thread, quote, media, tags and note', () => {
    const md = postToMarkdown(base, { frontmatter: true })
    expect(md).toContain('## Alice "A" Smith (@alice) · 2024-05-06')
    expect(md).toContain('second part')
    expect(md).toContain('> Bob (@bob): quoted text')
    expect(md).toContain('![cat](https://pbs.twimg.com/media/AAA.jpg)')
    expect(md).toContain('[video](https://video.twimg.com/v/high.mp4?tag=12)')
    expect(md).toContain('#rust #to-do')
    expect(md).toContain('**Note**: my note')
  })
  it('combined markdown has a heading and separators', () => {
    const md = postsToMarkdown([base, { ...base, tweet_id: '2' }])
    expect(md.startsWith('# X Bookmarks (2)')).toBe(true)
    expect(md.split('\n---\n').length).toBe(2)
  })
  it('obsidian files: per-folder path, safe names, unique by id', () => {
    const files = postsToObsidianFiles([base])
    expect(files[0].name).toMatch(/^Dev Tools\/2024-05-06 alice Line one, with comma Line .*123\.md$/)
    expect(files[0].name).not.toMatch(/[:*?"<>|]/)
    expect(files[0].data.startsWith('---')).toBe(true)
    expect(safeFileName('a/b:c*d')).toBe('a b c d')
  })
})

describe('media', () => {
  it('collects original photos and best mp4 with stable file names', () => {
    const items = collectMediaDownloads([base])
    expect(items).toEqual([
      { url: 'https://pbs.twimg.com/media/AAA.jpg:orig', filename: 'BookmarkKeeper/media/alice/123_1.jpg', tweet_id: '123' },
      { url: 'https://video.twimg.com/v/high.mp4?tag=12', filename: 'BookmarkKeeper/media/alice/123_2.mp4', tweet_id: '123' },
    ])
  })
})

describe('zip', () => {
  it('crc32 matches known vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('writes a structurally valid archive (local headers, central dir, eocd)', () => {
    const z = createZip([
      { name: 'a.md', data: 'hello' },
      { name: '目录/b.md', data: new Uint8Array([1, 2, 3]) },
    ])
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    const eocd = z.length - 22
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
    expect(dv.getUint16(eocd + 10, true)).toBe(2)
    const cdOffset = dv.getUint32(eocd + 16, true)
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50)
    // 第一个文件: 名称与内容
    const nameLen = dv.getUint16(26, true)
    expect(new TextDecoder().decode(z.slice(30, 30 + nameLen))).toBe('a.md')
    expect(new TextDecoder().decode(z.slice(30 + nameLen, 30 + nameLen + 5))).toBe('hello')
    expect(dv.getUint32(14, true)).toBe(crc32(new TextEncoder().encode('hello')))
  })
})
