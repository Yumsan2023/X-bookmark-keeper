import { useEffect, useState } from 'react'
import { listBookmarkAccounts } from '@/db/posts'
import { UNKNOWN_ACCOUNT } from '@/shared/accounts'
import { NO_FOLDER } from '@/search/query-parser'
import type { Filters } from '@/search/engine'
import type { Library } from '../../hooks'
import { useT } from '../../i18n'

export interface LibraryFilterState {
  since: string
  until: string
  quick: '7d' | '30d' | '1y' | 'all' | 'custom'
  oldestFirst: boolean
  folder: string
  contentType: '' | 'image' | 'video' | 'link' | 'quote' | 'media'
  postType: '' | 'bookmark' | 'timeline'
  authors: string
  availability: 'all' | 'active' | 'tweet_deleted' | 'unbookmarked'
  /** '' | screen name | UNKNOWN_ACCOUNT */
  account: string
  /** Library chip from the strike ledger. */
  authorMark: '' | 'marketing' | 'spam' | 'any'
}

export const EMPTY_FILTER: LibraryFilterState = {
  since: '',
  until: '',
  quick: 'all',
  oldestFirst: false,
  folder: '',
  contentType: '',
  postType: '',
  authors: '',
  availability: 'all',
  account: '',
  authorMark: '',
}

function toYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function applyQuick(q: LibraryFilterState['quick']): Pick<LibraryFilterState, 'since' | 'until' | 'quick'> {
  const end = new Date()
  const until = toYmd(end)
  if (q === 'all') return { since: '', until: '', quick: 'all' }
  if (q === 'custom') return { since: '', until: '', quick: 'custom' }
  const start = new Date(end)
  if (q === '7d') start.setDate(start.getDate() - 7)
  else if (q === '30d') start.setDate(start.getDate() - 30)
  else if (q === '1y') start.setFullYear(start.getFullYear() - 1)
  return { since: toYmd(start), until, quick: q }
}

export function filterStateToSearch(f: LibraryFilterState): {
  filters: Filters
  sortOldest: boolean
} {
  const has = f.contentType ? ([f.contentType] as const) : undefined
  return {
    sortOldest: f.oldestFirst,
    filters: {
      authors: f.authors.split(/[\s,，]+/).filter(Boolean),
      since: f.since ? new Date(f.since + 'T00:00:00').getTime() : undefined,
      until: f.until ? new Date(f.until + 'T23:59:59.999').getTime() : undefined,
      folders: f.folder ? [f.folder] : undefined,
      has: has ? [...has] : undefined,
      status: f.availability,
      source: f.postType || 'all',
      accounts: f.account ? [f.account] : undefined,
      authorMarks: f.authorMark ? [f.authorMark] : undefined,
    },
  }
}

export function filterChips(
  f: LibraryFilterState,
  t: (k: 'account_filter' | 'account_unknown' | 'folder' | 'author' | 'lib_content_type' | 'lib_post_type' | 'lib_availability' | 'unfiled' | 'lib_author_mark' | 'chip_marketing' | 'chip_spam' | 'lib_author_mark_any') => string,
): { id: string; label: string; clear: LibraryFilterState }[] {
  const chips: { id: string; label: string; clear: LibraryFilterState }[] = []
  if (f.account) {
    chips.push({
      id: 'account',
      label: `${t('account_filter')}: ${f.account === UNKNOWN_ACCOUNT ? t('account_unknown') : '@' + f.account}`,
      clear: { ...f, account: '' },
    })
  }
  if (f.folder) chips.push({ id: 'folder', label: `${t('folder')}: ${f.folder === NO_FOLDER ? t('unfiled') : f.folder}`, clear: { ...f, folder: '' } })
  if (f.authors.trim()) chips.push({ id: 'authors', label: `${t('author')}: ${f.authors}`, clear: { ...f, authors: '' } })
  if (f.contentType) chips.push({ id: 'content', label: f.contentType, clear: { ...f, contentType: '' } })
  if (f.postType) chips.push({ id: 'postType', label: f.postType, clear: { ...f, postType: '' } })
  if (f.availability !== 'all') chips.push({ id: 'availability', label: f.availability, clear: { ...f, availability: 'all' } })
  if (f.authorMark) {
    const label = f.authorMark === 'marketing' ? t('chip_marketing') : f.authorMark === 'spam' ? t('chip_spam') : t('lib_author_mark_any')
    chips.push({ id: 'authorMark', label: `${t('lib_author_mark')}: ${label}`, clear: { ...f, authorMark: '' } })
  }
  return chips
}

export function FilterPanel({
  open,
  value,
  lib,
  onClose,
  onApply,
}: {
  open: boolean
  value: LibraryFilterState
  lib: Library
  onClose: () => void
  onApply: (v: LibraryFilterState) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  const [accounts, setAccounts] = useState<{ account: string; count: number }[]>([])
  useEffect(() => {
    if (!open) return
    void listBookmarkAccounts().then(setAccounts)
  }, [open])
  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])
  if (!open) return null

  const set = <K extends keyof LibraryFilterState>(k: K, v: LibraryFilterState[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  const onQuick = (q: LibraryFilterState['quick']) => {
    const r = applyQuick(q)
    setDraft((d) => ({ ...d, ...r }))
  }

  return (
    <div className="lib-modal-bg" onClick={onClose}>
      <aside className="lib-panel lib-filter-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('lib_filter_title')}>
        <header className="lib-panel-head">
          <div>
            <h2>{t('lib_filter_title')}</h2>
            <p className="muted">{t('lib_filter_sub')}</p>
          </div>
          <button type="button" className="lib-icon-btn" onClick={onClose} aria-label={t('close')}>
            ×
          </button>
        </header>

        <section className="lib-panel-section">
          <label className="lib-field-label">{t('lib_time_range')}</label>
          <div className="lib-date-row">
            <input
              type="date"
              value={draft.since}
              onChange={(e) => setDraft((d) => ({ ...d, since: e.target.value, quick: 'custom' }))}
            />
            <span className="muted">→</span>
            <input
              type="date"
              value={draft.until}
              onChange={(e) => setDraft((d) => ({ ...d, until: e.target.value, quick: 'custom' }))}
            />
          </div>
          <div className="lib-chips">
            {(
              [
                ['7d', 'lib_quick_7d'],
                ['30d', 'lib_quick_30d'],
                ['1y', 'lib_quick_1y'],
                ['all', 'lib_quick_all'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={draft.quick === k ? 'lib-chip active' : 'lib-chip'}
                onClick={() => onQuick(k)}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </section>

        <section className="lib-panel-section lib-toggle-row">
          <div>
            <div className="lib-field-label">{t('lib_oldest_first')}</div>
            <p className="muted small">{t('lib_oldest_first_hint')}</p>
          </div>
          <button
            type="button"
            className={draft.oldestFirst ? 'lib-switch on' : 'lib-switch'}
            role="switch"
            aria-checked={draft.oldestFirst}
            onClick={() => set('oldestFirst', !draft.oldestFirst)}
          >
            <span className="lib-switch-knob" />
          </button>
        </section>

        <section className="lib-panel-section lib-fields">
          <label>
            {t('folder')}
            <select value={draft.folder} onChange={(e) => set('folder', e.target.value)}>
              <option value="">{t('lib_all_folders')}</option>
              <option value={NO_FOLDER}>{t('unfiled')}</option>
              {lib.folders.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({f.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('lib_content_type')}
            <select
              value={draft.contentType}
              onChange={(e) => set('contentType', e.target.value as LibraryFilterState['contentType'])}
            >
              <option value="">{t('all')}</option>
              <option value="image">{t('image')}</option>
              <option value="video">{t('video')}</option>
              <option value="media">{t('lib_content_media')}</option>
              <option value="link">{t('link')}</option>
              <option value="quote">{t('quote')}</option>
            </select>
          </label>
          <label>
            {t('lib_post_type')}
            <select
              value={draft.postType}
              onChange={(e) => set('postType', e.target.value as LibraryFilterState['postType'])}
            >
              <option value="">{t('all')}</option>
              <option value="bookmark">{t('source_bookmark')}</option>
              <option value="timeline">{t('source_timeline')}</option>
            </select>
          </label>
          <label>
            {t('lib_user_ids')}
            <input
              value={draft.authors}
              onChange={(e) => set('authors', e.target.value)}
              placeholder={t('lib_user_ids_ph')}
            />
          </label>
          <label>
            {t('account_filter')}
            <select value={draft.account} onChange={(e) => set('account', e.target.value)}>
              <option value="">{t('all')}</option>
              <option value={UNKNOWN_ACCOUNT}>{t('account_unknown')}</option>
              {accounts.map((row) => (
                <option key={row.account} value={row.account}>
                  @{row.account} ({row.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('lib_author_mark')}
            <select
              value={draft.authorMark}
              onChange={(e) => set('authorMark', e.target.value as LibraryFilterState['authorMark'])}
            >
              <option value="">{t('all')}</option>
              <option value="marketing">{t('chip_marketing')}</option>
              <option value="spam">{t('chip_spam')}</option>
              <option value="any">{t('lib_author_mark_any')}</option>
            </select>
          </label>
          <label>
            {t('lib_availability')}
            <select
              value={draft.availability}
              onChange={(e) => set('availability', e.target.value as LibraryFilterState['availability'])}
            >
              <option value="all">{t('all')}</option>
              <option value="active">{t('st_active')}</option>
              <option value="tweet_deleted">{t('st_tweet_deleted')}</option>
              <option value="unbookmarked">{t('st_unbookmarked')}</option>
            </select>
          </label>
        </section>

        <p className="muted small lib-avail-note">{t('lib_availability_note')}</p>

        <footer className="lib-panel-foot">
          <button type="button" className="lib-btn primary" onClick={() => onApply(draft)}>
            {t('lib_search')}
          </button>
          <button
            type="button"
            className="lib-btn ghost"
            onClick={() => {
              setDraft(EMPTY_FILTER)
              onApply(EMPTY_FILTER)
            }}
          >
            {t('lib_reset')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
