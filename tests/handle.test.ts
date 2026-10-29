import { describe, expect, it } from 'vitest'
import { parseHandleOrUrl, parseUserByScreenName } from '@/api/handle'

describe('parseHandleOrUrl', () => {
  it('parses @handle, bare handle, and profile URLs', () => {
    expect(parseHandleOrUrl('@Alice')).toBe('Alice')
    expect(parseHandleOrUrl('bob_1')).toBe('bob_1')
    expect(parseHandleOrUrl('https://x.com/Charlie')).toBe('Charlie')
    expect(parseHandleOrUrl('https://twitter.com/dave/status/123')).toBe('dave')
    expect(parseHandleOrUrl('x.com/eve')).toBe('eve')
  })

  it('rejects reserved paths and garbage', () => {
    expect(parseHandleOrUrl('https://x.com/i/bookmarks')).toBeNull()
    expect(parseHandleOrUrl('https://x.com/home')).toBeNull()
    expect(parseHandleOrUrl('')).toBeNull()
    expect(parseHandleOrUrl('not a handle!!!')).toBeNull()
  })
})

describe('parseUserByScreenName', () => {
  it('reads rest_id and screen_name from common shapes', () => {
    const json = {
      data: {
        user: {
          result: {
            rest_id: '42',
            legacy: { screen_name: 'alice' },
          },
        },
      },
    }
    expect(parseUserByScreenName(json)).toEqual({ userId: '42', screenName: 'alice' })
    const neo = {
      data: {
        user: {
          result: {
            rest_id: '99',
            core: { screen_name: 'neo' },
          },
        },
      },
    }
    expect(parseUserByScreenName(neo)).toEqual({ userId: '99', screenName: 'neo' })
    expect(parseUserByScreenName({})).toBeNull()
  })
})
