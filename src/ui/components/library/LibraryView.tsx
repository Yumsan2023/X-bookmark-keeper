import { useEffect, useMemo, useRef, useState } from 'react'
import { llmConfigured } from '@/ai/classify'
import { collectAllMatching } from '@/search/service'
import type { SortKey } from '@/search/engine'
import type { Hit } from '@/search/engine'
import { duplicateGroups, extraIds, groupByOriginal, type QuoteGroup } from '@/library/quote-groups'
import type { MediaItem } from '@/shared/types'
import { AccountBadges, dragBookmarkIds } from '../AccountBadges'
import { AuthorMarkButtons, AuthorMarkChips, authorOutlineClass } from '../AuthorMarks'
import { commitAuthorFlags, type AuthorFlagName } from '../../author-flags'
import { confirmUnbookmark } from '../../unbookmark'
import {
  DEFAULT_LIBRARY_COLUMNS,
  STORAGE_KEYS,
  type LibraryColumnId,
  type Post,
  type Settings,
} from '@/shared/types'
import { bg, useAuthorMarks, type Library } from '../../hooks'
import { resolveLibrarySyncAccount } from '../../stamp-account'
import { useLang, useT, type Key } from '../../i18n'
import { fmtDate, fmtNum } from '../../util'
import { AiDialog } from '../AiDialog'
import { useDialogs } from '../Dialogs'
import { TagEditor } from '../TagEditor'
import { ExportPanel, type ExportScope } from './ExportPanel'
import {
  EMPTY_FILTER,
  FilterPanel,
  TagCheckboxList,
  filterChips,
  filterStateToSearch,
  type LibraryFilterState,
} from './FilterPanel'

const COL_LABEL: Record<LibraryColumnId, Key> = {
  index: 'lib_col_index',
  user: 'lib_col_user',
  folder: 'lib_col_folder',
  post: 'lib_col_post',
  media: 'lib_col_media',
  views: 'lib_col_views',
  reposts: 'lib_col_reposts',
  favorites: 'lib_col_favorites',
  replies: 'lib_col_replies',
  created_at: 'lib_col_created',
}

const PAGE_SIZES = [20, 50, 100]
type LibView = 'list' | 'gallery' | 'group' | 'dupes'

const VIEWS: { id: LibView; icon: string; label: 'view_list' | 'view_gallery' | 'view_group' | 'view_dupes' }[] = [
  { id: 'list', icon: '☰', label: 'view_list' },
  { id: 'gallery', icon: '▦', label: 'view_gallery' },
  { id: 'group', icon: '⧉', label: 'view_group' },
  { id: 'dupes', icon: '⚇', label: 'view_dupes' },
]

function galleryMedia(posts: Post[]): { post: Post; media: MediaItem; index: number; fromQuote: boolean }[] {
  const items: { post: Post; media: MediaItem; index: number; fromQuote: boolean }[] = []
  for (const post of posts) {
    post.media?.forEach((media, index) => items.push({ post, media, index, fromQuote: false }))
    post.quoted?.media?.forEach((media, index) => items.push({ post, media, index, fromQuote: true }))
  }
  return items
}

function loadColumns(): LibraryColumnId[] {
  try {
    // sync read not available; start with default, hydrate in effect
  } catch {
    /* ignore */
  }
  return [...DEFAULT_LIBRARY_COLUMNS]
}

export function LibraryView({
  lib,
  settings,
  save,
  onSync,
}: {
  lib: Library
  settings: Settings
  save: (s: Settings) => Promise<void>
  onSync?: () => void
}) {
  const t = useT()
  const lang = useLang()
  const { confirm } = useDialogs()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<LibraryFilterState>(EMPTY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)
  const [columns, setColumns] = useState<LibraryColumnId[]>(loadColumns)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedCache, setSelectedCache] = useState<Map<string, Post>>(new Map())
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [info, setInfo] = useState('')
  const [tagEdit, setTagEdit] = useState<Post | null>(null)
  const [aiOpen, setAiOpen] = useState<'selected' | 'untagged' | null>(null)
  const [aiPosts, setAiPosts] = useState<Post[]>([])
  const [view, setView] = useState<LibView>('list')
  const [groups, setGroups] = useState<QuoteGroup[]>([])
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const searchSeq = useRef(0)
  const colsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEYS.libraryColumns).then((r) => {
      const v = r[STORAGE_KEYS.libraryColumns] as LibraryColumnId[] | undefined
      if (Array.isArray(v) && v.length) setColumns(v.filter((c) => DEFAULT_LIBRARY_COLUMNS.includes(c)))
    })
  }, [])

  useEffect(() => {
    void chrome.storage.local.set({ [STORAGE_KEYS.libraryColumns]: columns })
  }, [columns])

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 180)
    return () => clearTimeout(h)
  }, [query])

  useEffect(() => setPage(0), [debounced, filter, pageSize, view])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false)
    }
    if (colsOpen) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [colsOpen])

  const authorMarks = useAuthorMarks()
  const authorEffects = authorMarks.settings.tagEffects
  const outlineFor = (post: Post) => authorOutlineClass(post, authorMarks.lookup, authorEffects)
  const { filters: panelFilters, sortOldest } = useMemo(() => filterStateToSearch(filter), [filter])
  const filters = useMemo(
    () => ({ ...panelFilters, authorMarkLookup: authorMarks.lookup }),
    [panelFilters, authorMarks.lookup],
  )
  const sort: SortKey = sortOldest ? 'created_asc' : 'saved_desc'

  useEffect(() => {
    if (view !== 'list' && view !== 'gallery') return
    const seq = ++searchSeq.current
    setSearching(true)
    void lib.search({ query: debounced, filters, sort, page, pageSize }).then((r) => {
      if (seq !== searchSeq.current) return
      setHits(r.hits)
      setTotal(r.total)
      setSearching(false)
    })
  }, [lib, lib.version, debounced, filters, sort, page, pageSize, view])

  useEffect(() => {
    if (view === 'list' || view === 'gallery') return
    const seq = ++searchSeq.current
    setSearching(true)
    void collectAllMatching(lib.engine, { query: debounced, filters, sort }).then((posts) => {
      if (seq !== searchSeq.current) return
      const grouped = groupByOriginal(posts)
      const rows = view === 'dupes' ? duplicateGroups(grouped) : grouped
      setGroups(rows)
      setTotal(rows.length)
      setSearching(false)
    })
  }, [lib.engine, lib.version, debounced, filters, sort, view])

  useEffect(() => {
    setSelectedCache((cur) => {
      const n = new Map(cur)
      const visible = view === 'list' || view === 'gallery' ? hits.map((h) => h.post) : groups.flatMap((g) => g.posts)
      for (const post of visible) if (selected.has(post.tweet_id)) n.set(post.tweet_id, post)
      for (const id of n.keys()) if (!selected.has(id)) n.delete(id)
      return n
    })
  }, [hits, selected, groups, view])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const flash = (m: string) => {
    setInfo(m)
    setTimeout(() => setInfo(''), 6000)
  }

  const startIncremental = async () => {
    const { account, conflict } = await resolveLibrarySyncAccount()
    if (conflict) {
      flash(t('stamp_conflict', conflict))
      onSync?.()
      return
    }
    if (!account) {
      flash(t('stamp_missing'))
      onSync?.()
      return
    }
    void bg({ type: 'sync/start', mode: 'incremental', account })
    onSync?.()
    flash(t('running'))
  }

  const aiVisible = llmConfigured(settings.llm)
  const selectedPosts = () => [...selectedCache.values()].filter((p) => selected.has(p.tweet_id))
  const openAi = async (scope: 'selected' | 'untagged') => {
    if (scope === 'selected') setAiPosts(selectedPosts())
    else {
      flash(t('ai_loading_untagged'))
      const posts = await collectAllMatching(lib.engine, { query: 'tag:none', sort: 'saved_desc' })
      setAiPosts(posts.filter((p) => !(p.tags?.length)))
    }
    setAiOpen(scope)
  }

  const onAuthorFlag = async (posts: Post[], flag: AuthorFlagName, value: boolean) => {
    const result = await commitAuthorFlags(posts, flag, value)
    const parts = [t('author_flag_done', { n: result.ok })]
    if (result.failed) parts.push(t('author_flag_fail', { n: result.failed }))
    flash(parts.join(' · '))
  }

  const toggleCol = (id: LibraryColumnId) => {
    setColumns((cur) => {
      if (cur.includes(id)) {
        if (cur.length <= 1) return cur
        return cur.filter((c) => c !== id)
      }
      // restore in default order
      return DEFAULT_LIBRARY_COLUMNS.filter((c) => c === id || cur.includes(c))
    })
  }

  const toggleRow = (id: string, on: boolean) => {
    setSelected((cur) => {
      const n = new Set(cur)
      on ? n.add(id) : n.delete(id)
      return n
    })
  }

  const togglePage = (on: boolean) => {
    setSelected((cur) => {
      const n = new Set(cur)
      for (const h of hits) {
        if (on) n.add(h.post.tweet_id)
        else n.delete(h.post.tweet_id)
      }
      return n
    })
  }

  const pageAllSelected = hits.length > 0 && hits.every((h) => selected.has(h.post.tweet_id))

  const resolvePosts = async (scope: ExportScope): Promise<Post[]> => {
    if (scope === 'selected') return [...selectedCache.values()].filter((p) => selected.has(p.tweet_id))
    return collectAllMatching(lib.engine, { query: debounced, filters, sort }, (d, tot) => {
      setInfo(`${t('exporting')} ${d}/${tot}`)
    })
  }

  const onUnbookmark = async (ids: string[]) => {
    const message = await confirmUnbookmark({ ids, confirmBulk: settings.confirmBulkDelete, t, confirm })
    if (message) flash(message)
    if (message && !message.startsWith(t('del_no_account'))) {
      setSelected(new Set())
      await lib.reload()
    }
  }

  const pageGroups = view === 'list' || view === 'gallery' ? [] : groups.slice(page * pageSize, page * pageSize + pageSize)
  const gallery = galleryMedia(hits.map((h) => h.post))
  const chips = filterChips(filter, t)

  const visible = columns
  const show = (id: LibraryColumnId) => visible.includes(id)

  return (
    <div className="library-view">
      <div className="lib-top">
        <div className="lib-stats">
          <span className="lib-stat" title={t('total_in_library')}>
            🔖 {lib.totalCount}
          </span>
          <span className="lib-stat muted">
            {total} {t('results')}
            {searching ? ' …' : ''}
          </span>
        </div>
        <div className="lib-search-wrap">
          <input
            className="lib-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('lib_search_ph')}
          />
        </div>
      </div>

      <div className="lib-toolbar">
        <div className="lib-toolbar-group">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? 'lib-tool active' : 'lib-tool'}
              title={t(item.label)}
              aria-pressed={view === item.id}
              onClick={() => setView(item.id)}
            >
              {item.icon} <span className="lib-tool-label">{t(item.label)}</span>
            </button>
          ))}
        </div>
        <div className="lib-toolbar-group">
          <button
            type="button"
            className={filterOpen ? 'lib-tool active' : 'lib-tool'}
            title={t('filters')}
            onClick={() => setFilterOpen(true)}
          >
            ▽
          </button>
          <button type="button" className="lib-tool" title={t('export')} onClick={() => setExportOpen(true)}>
            ↓
          </button>
          {aiVisible && selected.size === 0 && (
            <button type="button" className="lib-tool" title={t('ai_classify')} onClick={() => void openAi('untagged')}>
              ✨ {t('ai_scope_untagged')}
            </button>
          )}
          <button
            type="button"
            className="lib-tool"
            title={t('sync_incremental')}
            onClick={() => void startIncremental()}
          >
            ↻
          </button>
          <button
            type="button"
            className="lib-tool"
            title={t('theme_toggle')}
            aria-label={t('theme_toggle')}
            onClick={() => {
              const theme = settings.theme === 'light' ? 'dark' : 'light'
              void save({ ...settings, theme })
            }}
          >
            {settings.theme === 'light' ? '🌙' : '☀️'}
            <span className="muted" style={{ marginLeft: 4 }}>
              {settings.theme === 'light' ? t('theme_dark') : t('theme_light')}
            </span>
          </button>
        </div>
        {view === 'dupes' && (
          <button
            type="button"
            className="lib-btn ghost"
            onClick={() => {
              const ids = groups.flatMap((group) => extraIds(group))
              setSelected(new Set(ids))
              setSelectedCache((cur) => {
                const next = new Map(cur)
                for (const group of groups) {
                  for (const post of group.posts) if (ids.includes(post.tweet_id)) next.set(post.tweet_id, post)
                }
                return next
              })
            }}
          >
            {t('dupes_select_extras')}
          </button>
        )}
        {selected.size > 0 && (
          <div className="lib-toolbar-group lib-batch">
            <b className="muted">{t('selected')} {selected.size}</b>
            <button
              type="button"
              className="danger"
              title={t('unbookmark_x')}
              onClick={() => void onUnbookmark([...selected])}
            >
              🗑 {t('delete_bookmark')}
            </button>
            <button type="button" onClick={() => void onAuthorFlag([...selectedCache.values()], 'marketing', true)}>
              {t('mark_marketing')}
            </button>
            <button type="button" onClick={() => void onAuthorFlag([...selectedCache.values()], 'marketing', false)}>
              {t('unmark_marketing')}
            </button>
            <button type="button" onClick={() => void onAuthorFlag([...selectedCache.values()], 'spam', true)}>
              {t('mark_spam')}
            </button>
            <button type="button" onClick={() => void onAuthorFlag([...selectedCache.values()], 'spam', false)}>
              {t('unmark_spam')}
            </button>
            {aiVisible && (
              <button type="button" onClick={() => void openAi('selected')}>
                ✨ {t('ai_classify')}
              </button>
            )}
            <button type="button" onClick={() => setSelected(new Set())}>
              {t('clear_selection')}
            </button>
          </div>
        )}
        <span className="spacer" />
        <div className="lib-cols-wrap" ref={colsRef}>
          <button
            type="button"
            className={colsOpen ? 'lib-tool active' : 'lib-tool'}
            title={t('lib_columns')}
            onClick={() => setColsOpen((v) => !v)}
          >
            𝌆 {t('lib_columns')}
          </button>
          {colsOpen && (
            <div className="lib-cols-menu">
              {DEFAULT_LIBRARY_COLUMNS.map((id) => (
                <label key={id} className="lib-cols-item">
                  <span className="lib-drag">⠿</span>
                  <span className="spacer">{t(COL_LABEL[id])}</span>
                  <input type="checkbox" checked={show(id)} onChange={() => toggleCol(id)} />
                </label>
              ))}
              <button
                type="button"
                className="lib-btn ghost small"
                onClick={() => setColumns([...DEFAULT_LIBRARY_COLUMNS])}
              >
                ↺ {t('lib_reset_layout')}
              </button>
            </div>
          )}
        </div>
      </div>

      <TagCheckboxList
        tags={lib.tags}
        checked={filter.tags}
        onChange={(tags) => setFilter((cur) => ({ ...cur, tags }))}
      />

      {chips.length > 0 && (
        <div className="filter-chips-bar" role="list">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="filter-chip"
              role="listitem"
              title={`${t('clear_filter')}: ${chip.label}`}
              onClick={() => setFilter(chip.clear)}
            >
              <span>{chip.label}</span>
              <span className="filter-chip-x" aria-hidden>
                ×
              </span>
            </button>
          ))}
          <button type="button" className="filter-chip-clear-all" onClick={() => setFilter(EMPTY_FILTER)}>
            {t('clear_all_filters')}
          </button>
        </div>
      )}
      {view === 'dupes' && <p className="muted small">{t('dupes_hint')}</p>}

      {info && <div className="info">{info}</div>}
      {lib.indexing && (
        <div className="info">
          {t('index_building')} {lib.indexProgress ?? 0}%
        </div>
      )}

      {view === 'gallery' ? (
        gallery.length ? (
          <div className="media-gallery">
            {gallery.map(({ post, media, index, fromQuote }) => {
              const on = selected.has(post.tweet_id)
              return (
                <div
                  key={`${post.tweet_id}:${fromQuote ? 'q' : 'm'}:${index}`}
                  className={`media-gallery-item ${on ? 'sel' : ''} ${outlineFor(post)}`}
                  draggable
                  onDragStart={(e) => dragBookmarkIds(e, post.tweet_id, selected)}
                >
                  <label className="media-gallery-check">
                    <input type="checkbox" checked={on} onChange={(e) => toggleRow(post.tweet_id, e.target.checked)} />
                  </label>
                  <a href={post.url} target="_blank" rel="noreferrer" className="media-gallery-thumb" title={`@${post.screen_name}`}>
                    <img src={media.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    {media.type !== 'photo' && <span className="play">▶</span>}
                    {fromQuote && <span className="media-gallery-q">↪</span>}
                  </a>
                  <div className="media-gallery-meta muted">
                    @{post.screen_name} <AuthorMarkChips post={post} lookup={authorMarks.lookup} effects={authorEffects} />
                    <AuthorMarkButtons post={post} lookup={authorMarks.lookup} onToggle={(item, flag, value) => void onAuthorFlag([item], flag, value)} />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="lib-empty muted">{searching ? '…' : t('gallery_empty')}</p>
        )
      ) : null}

      {view !== 'gallery' && (
      <div className="lib-table-wrap">
        <table className="lib-table">
          <thead>
            <tr>
              <th className="lib-check">
                <input
                  type="checkbox"
                  checked={pageAllSelected}
                  onChange={(e) => togglePage(e.target.checked)}
                  aria-label={t('select_page')}
                />
              </th>
              {show('index') && <th>#</th>}
              {show('user') && <th>{t('lib_col_user')}</th>}
              {show('folder') && <th>{t('lib_col_folder')}</th>}
              {show('post') && <th className="lib-col-post">{t('lib_col_post')}</th>}
              {show('media') && <th>{t('lib_col_media')}</th>}
              {show('views') && <th>{t('lib_col_views')}</th>}
              {show('reposts') && <th>{t('lib_col_reposts')}</th>}
              {show('favorites') && <th>{t('lib_col_favorites')}</th>}
              {show('replies') && <th>{t('lib_col_replies')}</th>}
              {show('created_at') && <th>{t('lib_col_created')}</th>}
              <th className="lib-actions" aria-label={t('delete_bookmark')} />
            </tr>
          </thead>
          <tbody>
            {lib.loading || searching ? null : lib.totalCount === 0 ? (
              <tr>
                <td colSpan={20}>
                  <div className="lib-empty empty-rich">
                    <div className="lib-empty-icon">📥</div>
                    <p className="empty-title">{t('lib_empty')}</p>
                    <ol className="empty-steps">
                      <li>{t('empty_hint_1')}</li>
                      <li>{t('empty_hint_2')}</li>
                      <li>{t('empty_hint_3')}</li>
                    </ol>
                    <button
                      type="button"
                      className="lib-btn primary"
                      onClick={() => void startIncremental()}
                    >
                      ↻ {t('go_sync')}
                    </button>
                  </div>
                </td>
              </tr>
            ) : total === 0 && !searching ? (
              <tr>
                <td colSpan={20}>
                  <p className="lib-empty">{t(view === 'dupes' ? 'dupes_none' : 'no_results')}</p>
                </td>
              </tr>
            ) : view === 'list' ? (
              hits.map((h, i) => {
                const p = h.post
                const idx = page * pageSize + i + 1
                return (
                  <tr
                    key={p.tweet_id}
                    className={`${selected.has(p.tweet_id) ? 'sel lib-row' : 'lib-row'} ${outlineFor(p)}`}
                    draggable
                    onDragStart={(e) => dragBookmarkIds(e, p.tweet_id, selected)}
                  >
                    <td className="lib-check">
                      <input
                        type="checkbox"
                        checked={selected.has(p.tweet_id)}
                        onChange={(e) => toggleRow(p.tweet_id, e.target.checked)}
                      />
                    </td>
                    {show('index') && <td className="num">{idx}</td>}
                    {show('user') && (
                      <td className="lib-user">
                        {p.avatar ? (
                          <img className="avatar" src={p.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="avatar-fallback">{(p.screen_name || '?')[0]?.toUpperCase()}</span>
                        )}
                        <div className="lib-user-meta">
                          <b>{p.name || p.screen_name}</b>
                          <span className="muted">@{p.screen_name}</span>
                          <span className="lib-acct-badges">
                            <AccountBadges accounts={p.accounts} />
                            <AuthorMarkChips post={p} lookup={authorMarks.lookup} effects={authorEffects} />
                          </span>
                        </div>
                      </td>
                    )}
                    {show('folder') && (
                      <td className="lib-folder">{p.folder ? <span className="badge">{p.folder}</span> : '—'}</td>
                    )}
                    {show('post') && (
                      <td className="lib-col-post">
                        <a href={p.url} target="_blank" rel="noreferrer" className="lib-post-text">
                          {p.text?.slice(0, 160) || '(empty)'}
                          {p.text && p.text.length > 160 ? '…' : ''}
                        </a>
                        {(p.tags?.length ?? 0) > 0 && (
                          <div className="tags">
                            {p.tags.map((tg) => (
                              <span key={tg} className="tag">#{tg}</span>
                            ))}
                          </div>
                        )}
                      </td>
                    )}
                    {show('media') && (
                      <td className="lib-media">
                        {p.media?.length ? (
                          <div className="lib-thumbs">
                            {p.media.slice(0, 3).map((m, mi) => (
                              <span key={mi} className="lib-thumb">
                                <img src={m.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                                {m.type !== 'photo' && <span className="play">▶</span>}
                              </span>
                            ))}
                            {p.media.length > 3 && <span className="muted">+{p.media.length - 3}</span>}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    {show('views') && <td className="num">{fmtNum(p.metrics.views)}</td>}
                    {show('reposts') && <td className="num">{fmtNum(p.metrics.retweets)}</td>}
                    {show('favorites') && <td className="num">{fmtNum(p.metrics.likes)}</td>}
                    {show('replies') && <td className="num">{fmtNum(p.metrics.replies)}</td>}
                    {show('created_at') && <td className="lib-date">{fmtDate(p.created_at, lang)}</td>}
                    <td className="lib-actions">
                      <AuthorMarkButtons post={p} lookup={authorMarks.lookup} onToggle={(post, flag, value) => void onAuthorFlag([post], flag, value)} />
                      <button
                        type="button"
                        className="lib-row-action"
                        title={t('edit_tags')}
                        onClick={() => setTagEdit(p)}
                      >
                        🏷
                      </button>
                      <button
                        type="button"
                        className="lib-row-action danger"
                        title={t('unbookmark_x')}
                        aria-label={t('delete_bookmark')}
                        onClick={() => void onUnbookmark([p.tweet_id])}
                      >
                        🗑 {t('delete_bookmark')}
                      </button>
                    </td>
                  </tr>
                )
              })
            ) : (
              pageGroups.map((group, i) => {
                const idx = page * pageSize + i + 1
                if (group.posts.length === 1) {
                  const p = group.posts[0]
                  return (
                    <tr
                      key={p.tweet_id}
                      className={`${selected.has(p.tweet_id) ? 'sel lib-row' : 'lib-row'} ${outlineFor(p)}`}
                      draggable
                      onDragStart={(e) => dragBookmarkIds(e, p.tweet_id, selected)}
                    >
                      <td className="lib-check">
                        <input type="checkbox" checked={selected.has(p.tweet_id)} onChange={(e) => toggleRow(p.tweet_id, e.target.checked)} />
                      </td>
                      {show('index') && <td className="num">{idx}</td>}
                      <td colSpan={20}>
                        <a href={p.url} target="_blank" rel="noreferrer" className="lib-post-text">
                          @{p.screen_name} {p.text?.slice(0, 180)}
                        </a>
                        <AccountBadges accounts={p.accounts} />
                        <AuthorMarkChips post={p} lookup={authorMarks.lookup} effects={authorEffects} />
                        <AuthorMarkButtons post={p} lookup={authorMarks.lookup} onToggle={(post, flag, value) => void onAuthorFlag([post], flag, value)} />
                      </td>
                    </tr>
                  )
                }
                const ids = group.posts.map((p) => p.tweet_id)
                const allOn = ids.every((id) => selected.has(id))
                const open = openGroups.has(group.key)
                const infoText = `${group.info.article_title ? `${group.info.article_title} — ` : ''}${group.info.text || ''}`
                return (
                  <tr key={`g:${group.key}`} className="lib-group-row">
                    <td className="lib-check">
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={(e) => {
                          setSelected((cur) => {
                            const next = new Set(cur)
                            for (const id of ids) e.target.checked ? next.add(id) : next.delete(id)
                            return next
                          })
                        }}
                      />
                    </td>
                    <td colSpan={20} className="lib-group-cell">
                      <button
                        type="button"
                        className="lib-btn ghost small-inline"
                        onClick={() =>
                          setOpenGroups((cur) => {
                            const next = new Set(cur)
                            next.has(group.key) ? next.delete(group.key) : next.add(group.key)
                            return next
                          })
                        }
                      >
                        {open ? '▾' : '▸'} {t(open ? 'group_collapse' : 'group_expand')}
                      </button>
                      <span className="badge">{t('group_quotes', { n: group.quoting.length })}</span>
                      {group.original && <span className="badge">{t('group_original_saved')}</span>}
                      {group.info.article_title && <span className="badge">📰 {t('quoted_article')}</span>}
                      <b>{group.info.name || group.info.screen_name || '—'}</b>
                      {group.info.screen_name && <span className="muted"> @{group.info.screen_name}</span>}
                      <a href={group.info.url} target="_blank" rel="noreferrer" className="lib-post-text lib-group-text">
                        {infoText.slice(0, 200) || group.info.url}
                        {infoText.length > 200 ? '…' : ''}
                      </a>
                      {!group.original && <span className="muted small"> {t('group_original_missing')}</span>}
                      {open &&
                        group.posts.map((p) => (
                          <div key={p.tweet_id} className={`lib-child-row ${outlineFor(p)}`}>
                            <label>
                              <input type="checkbox" checked={selected.has(p.tweet_id)} onChange={(e) => toggleRow(p.tweet_id, e.target.checked)} /> @{p.screen_name}{' '}
                              <AuthorMarkChips post={p} lookup={authorMarks.lookup} effects={authorEffects} />{' '}
                              {p.text?.slice(0, 120)}
                            </label>
                          </div>
                        ))}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      )}

      <footer className="lib-footer">
        <div className="lib-pager">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ‹
          </button>
          <span>
            {page + 1} {t('lib_of')} {pages}
          </span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            ›
          </button>
        </div>
        <label className="lib-rows">
          {t('lib_rows_per_page')}
          <select value={pageSize} onChange={(e) => setPageSize(+e.target.value)}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {selected.size} {t('lib_of')} {total} {t('selected').toLowerCase()}
        </span>
      </footer>

      {tagEdit && (
        <TagEditor
          post={hits.find((h) => h.post.tweet_id === tagEdit.tweet_id)?.post ?? selectedCache.get(tagEdit.tweet_id) ?? tagEdit}
          allTags={lib.tags.map((x) => x.tag)}
          onClose={() => setTagEdit(null)}
          onChanged={() => void lib.reload()}
        />
      )}
      {aiOpen && (
        <AiDialog
          settings={settings}
          posts={aiPosts}
          scopeLabel={aiOpen === 'selected' ? t('ai_scope_selected') : t('ai_scope_untagged')}
          knownTags={lib.tags.map((x) => x.tag)}
          onClose={() => setAiOpen(null)}
          onApplied={() => void lib.reload()}
        />
      )}
      <FilterPanel
        open={filterOpen}
        value={filter}
        lib={lib}
        onClose={() => setFilterOpen(false)}
        onApply={(v) => {
          setFilter(v)
          setFilterOpen(false)
        }}
      />
      <ExportPanel
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        selectedCount={selected.size}
        totalMatching={total}
        resolvePosts={resolvePosts}
        settings={settings}
        onFlash={flash}
      />
    </div>
  )
}
