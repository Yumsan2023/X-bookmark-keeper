import { describe, expect, it } from 'vitest'
import { duplicateGroups, extraIds, groupByOriginal } from '@/library/quote-groups'
import type { Post } from '@/shared/types'

function post(partial: Partial<Post> & Pick<Post, 'tweet_id'>): Post {
  return {
    sort_index: partial.tweet_id.padStart(6, '0'),
    user_id: 'u',
    screen_name: 'someone',
    name: 'Someone',
    avatar: '',
    created_at: 0,
    text: partial.tweet_id,
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
    url: `https://x.com/i/status/${partial.tweet_id}`,
    source: 'bookmark',
    ...partial,
  }
}

describe('quote groups', () => {
  it('groups quotes of the same original and keeps that original out of the extra list', () => {
    const original = post({ tweet_id: '10', screen_name: 'src', text: 'root' })
    const quoteA = post({
      tweet_id: '11',
      text: 'q1',
      has_quote: 1,
      quoted: { tweet_id: '10', screen_name: 'src', name: 'Src', text: 'root' },
    })
    const quoteB = post({
      tweet_id: '12',
      text: 'q2',
      urls: ['https://x.com/src/status/10'],
    })
    const alone = post({ tweet_id: '99', text: 'solo' })
    const groups = groupByOriginal([quoteA, original, quoteB, alone])
    const dupes = duplicateGroups(groups)
    expect(dupes).toHaveLength(1)
    expect(dupes[0].key).toBe('10')
    expect(dupes[0].original?.tweet_id).toBe('10')
    expect(extraIds(dupes[0]).sort()).toEqual(['11', '12'])
    expect(groups.find((g) => g.key === '99')?.posts).toHaveLength(1)
  })
})
