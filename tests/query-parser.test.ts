import { describe, expect, it } from 'vitest'
import { NO_FOLDER, parseDateToken, parseQuery, splitTokens } from '@/search/query-parser'

describe('splitTokens', () => {
  it('keeps quoted segments', () => {
    expect(splitTokens('foo "bar baz" folder:"My Folder" qux')).toEqual(['foo', '"bar baz"', 'folder:"My Folder"', 'qux'])
  })
  it('handles curly quotes', () => {
    expect(splitTokens('“机器 学习” x')).toEqual(['"机器 学习"', 'x'])
  })
})

describe('parseQuery', () => {
  it('parses all operators', () => {
    const q = parseQuery('rust async from:@Alice since:2024-01-15 until:2024-02-20 folder:"Dev Tools" has:image has:video has:link tag:#todo -spam "exact phrase" is:deleted')
    expect(q.terms).toEqual(['rust', 'async'])
    expect(q.phrases).toEqual(['exact phrase'])
    expect(q.excludes).toEqual(['spam'])
    expect(q.from).toEqual(['alice'])
    expect(q.folders).toEqual(['Dev Tools'])
    expect(q.has).toEqual(['image', 'video', 'link'])
    expect(q.tags).toEqual(['todo'])
    expect(q.status).toBe('tweet_deleted')
    expect(q.since).toBe(new Date(2024, 0, 15).getTime())
    expect(q.until).toBe(new Date(2024, 1, 21).getTime() - 1) // 含当天
    expect(q.warnings).toEqual([])
  })
  it('supports folder:none and CJK', () => {
    const q = parseQuery('机器学习 folder:none')
    expect(q.terms).toEqual(['机器学习'])
    expect(q.folders).toEqual([NO_FOLDER])
  })
  it('collects warnings for bad values', () => {
    const q = parseQuery('since:yesterday has:audio is:weird')
    expect(q.warnings).toEqual(['since:yesterday', 'has:audio', 'is:weird'])
    expect(q.since).toBeUndefined()
  })
  it('multiple from are kept (OR)', () => {
    expect(parseQuery('from:a from:b').from).toEqual(['a', 'b'])
  })
  it('empty and weird input', () => {
    expect(parseQuery('').terms).toEqual([])
    expect(parseQuery('  from:  ').from).toEqual([])
    expect(parseQuery('-').terms).toEqual(['-'])
  })
})

describe('parseDateToken', () => {
  it('year/month/day granularity', () => {
    expect(parseDateToken('2024')).toEqual({ start: new Date(2024, 0, 1).getTime(), end: new Date(2025, 0, 1).getTime() - 1 })
    expect(parseDateToken('2024-03')?.start).toBe(new Date(2024, 2, 1).getTime())
    expect(parseDateToken('2024/03/05')?.start).toBe(new Date(2024, 2, 5).getTime())
    expect(parseDateToken('2024-13')).toBeNull()
    expect(parseDateToken('abc')).toBeNull()
  })
})
