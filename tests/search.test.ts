import { describe, expect, it } from 'vitest'
import { SearchEngine } from '@/search/engine'
import { highlight } from '@/search/highlight'
import { tokenize } from '@/search/tokenizer'
import type { Post } from '@/shared/types'
import { padSortIndex } from '@/api/parser'

let n = 0
function post(over: Partial<Post>): Post {
  n++
  const id = over.tweet_id ?? String(1000 + n)
  return {
    tweet_id: id,
    sort_index: padSortIndex(String(5000 + n)),
    user_id: 'u',
    screen_name: 'alice',
    name: 'Alice',
    avatar: '',
    created_at: new Date(2024, 0, n, 12).getTime(),
    text: '',
    lang: 'en',
    urls: [],
    media: [],
    metrics: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: 0 },
    has_image: 0,
    has_video: 0,
    has_link: 0,
    has_quote: 0,
    folder: '',
    tags: [],
    status: 'active',
    saved_at: 0,
    sync_run: 'r',
    url: `https://x.com/alice/status/${id}`,
    ...over,
  }
}

const posts = [
  post({ tweet_id: 'a', text: 'Learning Rust async programming with tokio', screen_name: 'rustfan', name: 'Rust Fan', tags: ['rust', 'todo'], folder: 'Dev', has_link: 1 }),
  post({ tweet_id: 'b', text: '机器学习入门:从线性回归到神经网络', screen_name: 'mlcn', name: '机器学习君', folder: 'AI', has_image: 1 }),
  post({ tweet_id: 'c', text: '深度学习和自然语言处理的最新进展', screen_name: 'mlcn', name: '机器学习君', folder: 'AI' }),
  post({ tweet_id: 'd', text: 'Best pasta recipe ever, spam spam', screen_name: 'chef', name: 'Chef', has_video: 1, created_at: new Date(2023, 5, 1, 12).getTime() }),
  post({ tweet_id: 'e', text: 'Rust vs Go performance comparison', screen_name: 'bench', tags: ['rust'], status: 'tweet_deleted' }),
]

const engine = new SearchEngine(posts)
const ids = (q: string, extra: Parameters<SearchEngine['search']>[0] = { query: '' }) => engine.search({ ...extra, query: q }).hits.map((h) => h.post.tweet_id)

describe('tokenizer', () => {
  it('segments Chinese and English', () => {
    const t = tokenize('机器学习入门 Rust Async')
    expect(t).toContain('rust')
    expect(t).toContain('async')
    expect(t.length).toBeGreaterThan(3)
    expect(t.join('')).toContain('机器')
  })
  it('empty', () => expect(tokenize('')).toEqual([]))
})

describe('SearchEngine', () => {
  it('matches English terms with prefix', () => {
    expect(ids('rust')).toEqual(expect.arrayContaining(['a', 'e']))
    expect(ids('program')).toContain('a') // 前缀
  })
  it('fuzzy matching tolerates typos on longer latin words', () => {
    expect(ids('programing')).toContain('a')
  })
  it('matches Chinese by substring even without whitespace', () => {
    expect(ids('机器学习')).toContain('b')
    expect(ids('学习')).toEqual(expect.arrayContaining(['b', 'c']))
    expect(ids('自然语言')).toEqual(['c'])
  })
  it('ranks by relevance (more occurrences / field boost first)', () => {
    const r = ids('rust')
    expect(r[0]).toBe('a') // 标签+作者+正文都命中
  })
  it('AND semantics across terms', () => {
    expect(ids('rust tokio')).toEqual(['a'])
  })
  it('phrases and exclusion', () => {
    expect(ids('"async programming"')).toEqual(['a'])
    expect(ids('rust -tokio')).toEqual(['e'])
    expect(ids('pasta -spam')).toEqual([])
  })
  it('from: since: until: folder: has: tag: is:', () => {
    expect(ids('from:rustfan')).toEqual(['a'])
    expect(ids('from:@MLCN').sort()).toEqual(['b', 'c'])
    expect(ids('since:2024-01-01 until:2024-01-03').sort()).toEqual(['a', 'b', 'c'])
    expect(ids('folder:AI').sort()).toEqual(['b', 'c'])
    expect(ids('folder:none').sort()).toEqual(['d', 'e'])
    expect(ids('has:image')).toEqual(['b'])
    expect(ids('has:video')).toEqual(['d'])
    expect(ids('has:link')).toEqual(['a'])
    expect(ids('has:media').sort()).toEqual(['b', 'd'])
    expect(ids('tag:rust').sort()).toEqual(['a', 'e'])
    expect(ids('tag:rust tag:todo')).toEqual(['a'])
    expect(ids('is:deleted')).toEqual(['e'])
    expect(ids('rust folder:Dev has:link from:rustfan')).toEqual(['a'])
  })
  it('structured filters AND with query operators', () => {
    expect(ids('rust', { query: '', filters: { tags: ['todo'] } })).toEqual(['a'])
    expect(ids('', { query: '', filters: { folders: ['AI'], authors: ['mlcn'] } }).sort()).toEqual(['b', 'c'])
    expect(ids('', { query: '', filters: { status: 'tweet_deleted' } })).toEqual(['e'])
    expect(ids('', { query: '', filters: { since: new Date(2024, 0, 2).getTime(), until: new Date(2024, 0, 3, 23, 59).getTime() } }).sort()).toEqual(['b', 'c'])
  })
  it('sorts', () => {
    expect(ids('', { query: '', sort: 'created_asc' })[0]).toBe('d')
    expect(ids('', { query: '', sort: 'saved_desc' })[0]).toBe('e')
    expect(ids('', { query: '', sort: 'saved_asc' })[0]).toBe('a')
  })
  it('upsert / remove keep index in sync', () => {
    const e = new SearchEngine(posts)
    e.upsert({ ...posts[0], text: 'now about Haskell', tags: [] })
    expect(e.search({ query: 'tokio' }).total).toBe(0)
    expect(e.search({ query: 'haskell' }).total).toBe(1)
    e.remove('a')
    expect(e.search({ query: 'haskell' }).total).toBe(0)
    expect(e.size).toBe(4)
  })
  it('search in tags, author name, notes and thread text', () => {
    const e = new SearchEngine([post({ tweet_id: 'z', text: 'x', note: 'remember zebra', thread: [{ tweet_id: 't', text: 'giraffe in thread', created_at: 0, media: [] }], name: 'Wang Fang', tags: ['reading'] })])
    expect(e.search({ query: 'zebra' }).total).toBe(1)
    expect(e.search({ query: 'giraffe' }).total).toBe(1)
    expect(e.search({ query: 'fang' }).total).toBe(1)
    expect(e.search({ query: 'reading' }).total).toBe(1)
  })
  it('falls back to OR when AND finds nothing', () => {
    expect(ids('pasta tokio').length).toBeGreaterThan(0)
  })
})

describe('highlight', () => {
  it('marks hits case-insensitively and escapes regex chars', () => {
    expect(highlight('Hello World', ['world'])).toEqual([{ text: 'Hello ', hit: false }, { text: 'World', hit: true }])
    expect(highlight('a+b', ['a+b'])).toEqual([{ text: 'a+b', hit: true }])
    expect(highlight('机器学习', ['学习'])).toEqual([{ text: '机器', hit: false }, { text: '学习', hit: true }])
    expect(highlight('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })
})
