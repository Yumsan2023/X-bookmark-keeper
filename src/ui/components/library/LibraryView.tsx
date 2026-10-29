import { useEffect, useMemo, useRef, useState } from 'react'
import { collectAllMatching } from '@/search/service'
import type { SortKey } from '@/search/engine'
import type { Hit } from '@/search/engine'
import {
  DEFAULT_LIBRARY_COLUMNS,
  STORAGE_KEYS,
  type LibraryColumnId,
  type Post,
  type Settings,
} from '@/shared/types'
import { bg, type Library } from '../../hooks'
import { useLang, useT, type Key } from '../../i18n'
import { fmtDate, fmtNum } from '../../util'
import { useDialogs } from '../Dialogs'
import { ExportPanel, type ExportScope } from './ExportPanel'
import {
  EMPTY_FILTER,
  FilterPanel,
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

  useEffect(() => setPage(0), [debounced, filter, pageSize])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false)
    }
    if (colsOpen) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [colsOpen])

  const { filters, sortOldest } = useMemo(() => filterStateToSearch(filter), [filter])
  const sort: SortKey = sortOldest ? 'created_asc' : 'saved_desc'

  useEffect(() => {
    const seq = ++searchSeq.current
    setSearching(true)
    void lib.search({ query: debounced, filters, sort, page, pageSize }).then((r) => {
      if (seq !== searchSeq.current) return
      setHits(r.hits)
      setTotal(r.total)
      setSearching(false)
    })
  }, [lib, lib.version, debounced, filters, sort, page, pageSize])

  useEffect(() => {
    setSelectedCache((cur) => {
      const n = new Map(cur)
      for (const h of hits) {
        if (selected.has(h.post.tweet_id)) n.set(h.post.tweet_id, h.post)
      }
      for (const id of n.keys()) if (!selected.has(id)) n.delete(id)
      return n
    })
  }, [hits, selected])

  const pages = Math.max(1, Math.ceil(total / pageSize))
  const flash = (m: string) => {
    setInfo(m)
    setTimeout(() => setInfo(''), 6000)
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
    if (!ids.length) return
    if (settings.confirmBulkDelete && !(await confirm(`${t('confirm_unbookmark')} (${ids.length})`))) return
    const hard = await confirm(t('confirm_unbookmark_hard'))
    const r = await bg({ type: 'bookmarks/delete', tweetIds: ids, removeLocal: hard })
    flash(r.ok ? `${t('task')}…` : r.error ?? 'error')
    setSelected(new Set())
    await lib.reload()
  }

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
          <button type="button" className="lib-tool active" title={t('tab_library')}>
            ☰
          </button>
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
          <button
            type="button"
            className="lib-tool"
            title={t('sync_incremental')}
            onClick={() => {
              void bg({ type: 'sync/start', mode: 'incremental' })
              onSync?.()
              flash(t('running'))
            }}
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

      {info && <div className="info">{info}</div>}
      {lib.indexing && (
        <div className="info">
          {t('index_building')} {lib.indexProgress ?? 0}%
        </div>
      )}

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
            {lib.loading ? null : lib.totalCount === 0 ? (
              <tr>
                <td colSpan={20}>
                  <div className="lib-empty">
                    <div className="lib-empty-icon">📥</div>
                    <p>{t('lib_empty')}</p>
                    <button
                      type="button"
                      className="lib-btn primary"
                      onClick={() => {
                        void bg({ type: 'sync/start', mode: 'incremental' })
                        onSync?.()
                      }}
                    >
                      ↻ {t('lib_sync_bookmarks')}
                    </button>
                  </div>
                </td>
              </tr>
            ) : total === 0 && !searching ? (
              <tr>
                <td colSpan={20}>
                  <p className="lib-empty">{t('no_results')}</p>
                </td>
              </tr>
            ) : (
              hits.map((h, i) => {
                const p = h.post
                const idx = page * pageSize + i + 1
                return (
                  <tr key={p.tweet_id} className={selected.has(p.tweet_id) ? 'sel' : ''}>
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
            )}
          </tbody>
        </table>
      </div>

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
