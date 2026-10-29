import { useEffect, useMemo, useRef, useState } from 'react'
import { llmConfigured } from '@/ai/classify'
import { addTags, createLocalFolder, getAllPosts, moveToFolder, normalizeTag, removeLocal, removeTags } from '@/db/posts'
import { collectAllMatching } from '@/search/service'
import { NO_FOLDER } from '@/search/query-parser'
import type { Filters, SortKey } from '@/search/engine'
import type { Hit } from '@/search/engine'
import type { Post, Settings } from '@/shared/types'
import { bg, type Library } from '../hooks'
import { useT, type Key } from '../i18n'
import { downloadMedia, exportPosts, exportPostsBatched, openPrint, type ExportKind } from '../util'
import { AiDialog } from './AiDialog'
import { useDialogs } from './Dialogs'
import { PostCard } from './PostCard'
import { NoteEditor, TagEditor } from './TagEditor'

const PAGE = 40
const SORTS: SortKey[] = ['relevance', 'saved_desc', 'saved_asc', 'created_desc', 'created_asc', 'likes_desc', 'views_desc']

export interface SearchPreset {
  query?: string
  nonce: number
}

export function SearchView({ lib, settings, compact, preset }: { lib: Library; settings: Settings; compact?: boolean; preset?: SearchPreset }) {
  const t = useT()
  const { ask, confirm } = useDialogs()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [authors, setAuthors] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [folder, setFolder] = useState('')
  const [has, setHas] = useState<Set<'image' | 'video' | 'link' | 'quote'>>(new Set())
  const [tag, setTag] = useState('')
  const [status, setStatus] = useState<Filters['status']>('all')
  const [source, setSource] = useState<Filters['source']>('all')
  const [sort, setSort] = useState<SortKey>('relevance')
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(!compact)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedCache, setSelectedCache] = useState<Map<string, Post>>(new Map())
  const [tagEdit, setTagEdit] = useState<Post | null>(null)
  const [noteEdit, setNoteEdit] = useState<Post | null>(null)
  const [aiOpen, setAiOpen] = useState<'selected' | 'unfiled' | null>(null)
  const [aiPosts, setAiPosts] = useState<Post[]>([])
  const [info, setInfo] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [total, setTotal] = useState(0)
  const [highlightTerms, setHighlightTerms] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [batchSize, setBatchSize] = useState(settings.exportBatchSize || 1000)
  const [exporting, setExporting] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (preset?.query !== undefined) setQuery(preset.query)
  }, [preset?.nonce])
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 180)
    return () => clearTimeout(h)
  }, [query])
  useEffect(() => setPage(0), [debounced, authors, since, until, folder, has, tag, status, source, sort])
  useEffect(() => setBatchSize(settings.exportBatchSize || 1000), [settings.exportBatchSize])

  const filters: Filters = useMemo(
    () => ({
      authors: authors.split(/[\s,，]+/).filter(Boolean),
      since: since ? new Date(since + 'T00:00:00').getTime() : undefined,
      until: until ? new Date(until + 'T23:59:59.999').getTime() : undefined,
      folders: folder ? [folder] : undefined,
      has: [...has],
      tags: tag ? [tag] : undefined,
      status,
      source,
    }),
    [authors, since, until, folder, has, tag, status, source],
  )

  useEffect(() => {
    const seq = ++searchSeq.current
    setSearching(true)
    void lib.search({ query: debounced, filters, sort, page, pageSize: PAGE }).then((r) => {
      if (seq !== searchSeq.current) return
      setHits(r.hits)
      setTotal(r.total)
      setHighlightTerms(r.highlightTerms)
      setWarnings(r.parsed.warnings)
      setSearching(false)
    })
  }, [lib, lib.version, debounced, filters, sort, page])

  // 勾选时缓存 Post, 避免依赖全量 posts
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

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const allTagNames = lib.tags.map((x) => x.tag)
  const aiVisible = llmConfigured(settings.llm)

  const sel = (ids: string[]) => (ids.length ? ids : [...selected])
  const selectedPosts = (): Post[] => [...selectedCache.values()].filter((p) => selected.has(p.tweet_id))
  const flash = (m: string) => {
    setInfo(m)
    setTimeout(() => setInfo(''), 5000)
  }
  const afterChange = async () => {
    await lib.reload()
  }

  const resolveExportPosts = async (scope: 'selection' | 'results' | 'library'): Promise<Post[]> => {
    if (scope === 'selection') return selectedPosts()
    if (scope === 'library') {
      // 全库分批读, 不一次 toArray 若可能 — getAllPosts 导出场景允许, 但走分批提示
      flash(t('exporting'))
      return getAllPosts()
    }
    flash(t('exporting'))
    return collectAllMatching(lib.engine, { query: debounced, filters, sort }, (d, tot) => {
      setInfo(`${t('exporting')} ${d}/${tot}`)
    })
  }

  const onExport = async (kind: ExportKind) => {
    try {
      setExporting(true)
      const posts = selected.size ? selectedPosts() : await resolveExportPosts('results')
      exportPosts(kind, posts)
      flash(`${t('export')}: ${posts.length}`)
    } finally {
      setExporting(false)
    }
  }

  const onBatchExport = async (kind: ExportKind, scope: 'results' | 'library') => {
    try {
      setExporting(true)
      const posts = selected.size ? selectedPosts() : await resolveExportPosts(scope)
      const size = Math.max(100, Math.min(10000, batchSize || 1000))
      const { zipCount, batchTotal } = await exportPostsBatched(kind, posts, size, (done, tot) => {
        setInfo(`${t('batch_export_progress')} ${done}/${tot}`)
      })
      flash(`${t('batch_export_done')}: ${batchTotal} ${t('batches')}, ${zipCount} zip, ${posts.length} posts`)
    } catch (e) {
      flash((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const onMove = async (value: string) => {
    if (!selected.size) return
    let target = value
    if (value === '__new__') {
      const name = await ask(t('new_folder_prompt'))
      if (!name?.trim()) return
      target = name.trim()
      await createLocalFolder(target)
    }
    const ids = sel([])
    await moveToFolder(ids, target === NO_FOLDER ? '' : target)
    if (settings.pushFolderMoveToX && target && target !== NO_FOLDER) void bg({ type: 'folder/push', tweetIds: ids, folder: target })
    await afterChange()
    flash(`${ids.length} → ${target === NO_FOLDER ? t('unfiled') : target}`)
  }

  const onAddTag = async () => {
    const v = await ask(t('tag_prompt'), '', allTagNames)
    if (!v) return
    await addTags(sel([]), v.split(/[\s,，]+/).map(normalizeTag).filter(Boolean))
    await afterChange()
  }
  const onRemoveTag = async () => {
    const v = await ask(t('tag_prompt'), '', allTagNames)
    if (!v) return
    await removeTags(sel([]), v.split(/[\s,，]+/).map(normalizeTag).filter(Boolean))
    await afterChange()
  }
  const onUnbookmark = async () => {
    const ids = sel([])
    if (!ids.length) return
    if (settings.confirmBulkDelete && !(await confirm(`${t('confirm_unbookmark')} (${ids.length})`))) return
    const hard = await confirm(t('confirm_unbookmark_hard'))
    const r = await bg({ type: 'bookmarks/delete', tweetIds: ids, removeLocal: hard })
    flash(r.ok ? `${t('task')}…` : r.error ?? 'error')
    setSelected(new Set())
  }
  const onRemoveLocal = async () => {
    const ids = sel([])
    if (!ids.length || !(await confirm(`${t('delete')} ${ids.length}?`))) return
    await removeLocal(ids)
    setSelected(new Set())
    await afterChange()
  }
  const toggle = (k: 'image' | 'video' | 'link' | 'quote') =>
    setHas((cur) => {
      const n = new Set(cur)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })

  const openAi = async (scope: 'selected' | 'unfiled') => {
    if (scope === 'selected') {
      setAiPosts(selectedPosts())
    } else {
      // 未归类: 用过滤分页收集, 避免全表
      const posts = await collectAllMatching(lib.engine, { query: 'folder:none is:active', filters: { status: 'active' }, sort: 'saved_desc' })
      setAiPosts(posts.filter((p) => !p.folder && p.status === 'active'))
    }
    setAiOpen(scope)
  }

  return (
    <div className="search-view">
      <div className="searchbar">
        <input className="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search_placeholder')} autoFocus />
        <button onClick={() => setShowFilters((v) => !v)}>{t('filters')} {showFilters ? '▲' : '▼'}</button>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title={t('sort')}>
          {SORTS.map((s) => <option key={s} value={s}>{t(`sort_${s}` as Key)}</option>)}
        </select>
      </div>
      {warnings.length > 0 && <div className="warn-line">⚠ {warnings.join(', ')}</div>}
      {lib.indexing && (
        <div className="info">{t('index_building')} {lib.indexProgress ?? 0}%</div>
      )}

      {showFilters && (
        <div className="filters">
          <label>{t('author')}<input value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="@name" /></label>
          <label>{t('date_from')}<input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
          <label>{t('date_to')}<input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
          <label>{t('folder')}
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">{t('all')}</option>
              <option value={NO_FOLDER}>{t('unfiled')}</option>
              {lib.folders.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.count})</option>)}
            </select>
          </label>
          <label>{t('tag')}
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">{t('all')}</option>
              {lib.tags.map((x) => <option key={x.tag} value={x.tag}>#{x.tag} ({x.count})</option>)}
            </select>
          </label>
          <label>{t('status')}
            <select value={status} onChange={(e) => setStatus(e.target.value as Filters['status'])}>
              <option value="all">{t('all')}</option>
              <option value="active">{t('st_active')}</option>
              <option value="tweet_deleted">{t('st_tweet_deleted')}</option>
              <option value="unbookmarked">{t('st_unbookmarked')}</option>
            </select>
          </label>
          <label>{t('source_filter')}
            <select value={source ?? 'all'} onChange={(e) => setSource(e.target.value as Filters['source'])}>
              <option value="all">{t('all')}</option>
              <option value="bookmark">{t('source_bookmark')}</option>
              <option value="timeline">{t('source_timeline')}</option>
            </select>
          </label>
          <div className="checks">
            {(['image', 'video', 'link', 'quote'] as const).map((k) => (
              <label key={k}><input type="checkbox" checked={has.has(k)} onChange={() => toggle(k)} /> {t(k)}</label>
            ))}
          </div>
        </div>
      )}

      <div className="toolbar">
        <span className="muted">{total} {t('results')} / {t('total_in_library')} {lib.totalCount}{searching ? ' …' : ''}</span>
        <button onClick={() => setSelected(new Set(hits.map((h) => h.post.tweet_id)))} title={t('select_all_results_hint')}>{t('select_page')}</button>
        {selected.size > 0 && <button onClick={() => setSelected(new Set())}>{t('clear_selection')} ({selected.size})</button>}
        <span className="spacer" />
        <label className="batch-size" title={t('batch_size_export')}>
          {t('batch_size_export')}
          <input
            type="number"
            min={100}
            max={10000}
            step={100}
            value={batchSize}
            disabled={exporting}
            onChange={(e) => setBatchSize(Math.max(100, Math.min(10000, +e.target.value || 1000)))}
            style={{ width: 72 }}
          />
        </label>
        <ExportMenu
          disabled={exporting}
          onExport={(k) => void onExport(k)}
          onBatchExport={(k, scope) => void onBatchExport(k, scope)}
          onPrint={async () => {
            const posts = selected.size ? selectedPosts() : await resolveExportPosts('results')
            await openPrint(posts)
          }}
          onMedia={async () => {
            const posts = selected.size ? selectedPosts() : await resolveExportPosts('results')
            const n = await downloadMedia(posts, (d, tot) => setInfo(`${t('download_media')} ${d}/${tot}`))
            flash(`${t('download_media')}: ${n}`)
          }}
        />
      </div>

      {selected.size > 0 && (
        <div className="toolbar batch">
          <b>{t('selected')} {selected.size}</b>
          <select value="" onChange={(e) => e.target.value && onMove(e.target.value)}>
            <option value="">{t('move_to_folder')}</option>
            <option value={NO_FOLDER}>— {t('unfiled')} —</option>
            {lib.folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            <option value="__new__">＋ {t('create_folder')}…</option>
          </select>
          <button onClick={onAddTag}>🏷 {t('add_tag')}</button>
          <button onClick={onRemoveTag}>{t('remove_tag')}</button>
          <button onClick={() => bg({ type: 'threads/fetch', tweetIds: [...selected] }).then(() => flash(t('task')))}>{t('fetch_threads')}</button>
          {aiVisible && <button onClick={() => void openAi('selected')}>✨ {t('ai_classify')}</button>}
          <button className="danger" onClick={onUnbookmark}>{t('unbookmark_x')}</button>
          <button className="danger" onClick={onRemoveLocal}>{t('delete')}</button>
        </div>
      )}
      {aiVisible && selected.size === 0 && lib.unfiledCount > 0 && (
        <div className="toolbar"><button onClick={() => void openAi('unfiled')}>✨ {t('ai_classify')} ({t('ai_scope_unfiled')})</button></div>
      )}
      {info && <div className="info">{info}</div>}

      <div className="results">
        {lib.loading ? null : lib.totalCount === 0 ? (
          <p className="empty">{t('empty_library')}</p>
        ) : total === 0 && !searching ? (
          <p className="empty">{t('no_results')}</p>
        ) : (
          hits.map((h) => (
            <PostCard
              key={h.post.tweet_id}
              post={h.post}
              terms={[...highlightTerms, ...h.terms]}
              selected={selected.has(h.post.tweet_id)}
              onSelect={(id, v) => setSelected((cur) => { const n = new Set(cur); v ? n.add(id) : n.delete(id); return n })}
              onTag={setTagEdit}
              onNote={setNoteEdit}
              compact={compact}
            />
          ))
        )}
      </div>

      <div className="pager">
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t('prev')}</button>
        <span>{t('page')} {page + 1} / {pages}</span>
        <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>{t('next')}</button>
      </div>

      {tagEdit && (
        <TagEditor
          post={hits.find((h) => h.post.tweet_id === tagEdit.tweet_id)?.post ?? selectedCache.get(tagEdit.tweet_id) ?? tagEdit}
          allTags={allTagNames}
          onClose={() => setTagEdit(null)}
          onChanged={afterChange}
        />
      )}
      {noteEdit && <NoteEditor post={noteEdit} onClose={() => setNoteEdit(null)} onChanged={afterChange} />}
      {aiOpen && (
        <AiDialog
          settings={settings}
          posts={aiPosts}
          scopeLabel={aiOpen === 'selected' ? t('ai_scope_selected') : t('ai_scope_unfiled')}
          folders={lib.folders}
          onClose={() => setAiOpen(null)}
          onApplied={afterChange}
        />
      )}
    </div>
  )
}

function ExportMenu({
  onExport,
  onBatchExport,
  onPrint,
  onMedia,
  disabled,
}: {
  onExport: (k: ExportKind) => void
  onBatchExport: (k: ExportKind, scope: 'results' | 'library') => void
  onPrint: () => void
  onMedia: () => void
  disabled?: boolean
}) {
  const t = useT()
  return (
    <select
      value=""
      disabled={disabled}
      title={t('export_selected_or_all')}
      onChange={(e) => {
        const v = e.target.value
        e.target.value = ''
        if (v === 'print') onPrint()
        else if (v === 'media') onMedia()
        else if (v.startsWith('batch-results-')) onBatchExport(v.replace('batch-results-', '') as ExportKind, 'results')
        else if (v.startsWith('batch-library-')) onBatchExport(v.replace('batch-library-', '') as ExportKind, 'library')
        else if (v) onExport(v as ExportKind)
      }}
    >
      <option value="">{t('export')} ▾</option>
      <option value="json">{t('export_json')}</option>
      <option value="csv">{t('export_csv')}</option>
      <option value="md">{t('export_md')}</option>
      <option value="obsidian">{t('export_obsidian')}</option>
      <option value="print">{t('print_pdf')}</option>
      <option value="media">{t('download_media')}</option>
      <optgroup label={t('batch_export')}>
        <option value="batch-results-json">{t('batch_export_results')} JSON</option>
        <option value="batch-results-csv">{t('batch_export_results')} CSV</option>
        <option value="batch-results-md">{t('batch_export_results')} Markdown</option>
        <option value="batch-results-obsidian">{t('batch_export_results')} Obsidian</option>
        <option value="batch-library-json">{t('batch_export_library')} JSON</option>
        <option value="batch-library-csv">{t('batch_export_library')} CSV</option>
        <option value="batch-library-md">{t('batch_export_library')} Markdown</option>
        <option value="batch-library-obsidian">{t('batch_export_library')} Obsidian</option>
      </optgroup>
    </select>
  )
}
