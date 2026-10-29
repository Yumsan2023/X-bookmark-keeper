import { describe, expect, it } from 'vitest'
import { EMPTY_FILTER, filterStateToSearch, type LibraryFilterState } from '@/ui/components/library/FilterPanel'

describe('library filterStateToSearch', () => {
  it('maps empty filter to defaults', () => {
    const { filters, sortOldest } = filterStateToSearch(EMPTY_FILTER)
    expect(sortOldest).toBe(false)
    expect(filters.authors).toEqual([])
    expect(filters.since).toBeUndefined()
    expect(filters.status).toBe('all')
    expect(filters.source).toBe('all')
  })

  it('maps oldest-first and media content type', () => {
    const f: LibraryFilterState = {
      ...EMPTY_FILTER,
      oldestFirst: true,
      contentType: 'media',
      authors: '@alice bob',
      since: '2024-01-01',
      until: '2024-12-31',
      availability: 'active',
      postType: 'bookmark',
    }
    const { filters, sortOldest } = filterStateToSearch(f)
    expect(sortOldest).toBe(true)
    expect(filters.has).toEqual(['media'])
    expect(filters.authors).toEqual(['@alice', 'bob'])
    expect(filters.since).toBe(new Date('2024-01-01T00:00:00').getTime())
    expect(filters.status).toBe('active')
    expect(filters.source).toBe('bookmark')
  })
})
