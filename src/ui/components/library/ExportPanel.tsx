import { useEffect, useState } from 'react'
import { postsToCsv } from '@/export/csv'
import { postsToJson } from '@/export/json'
import { postsToMarkdown } from '@/export/markdown'
import type { Post, Settings } from '@/shared/types'
import { useT } from '../../i18n'
import { downloadMedia, exportPostsBatched, openPrint, saveBlob, type ExportKind } from '../../util'

export type ExportTab = 'posts' | 'media'
export type ExportScope = 'all' | 'selected'
export type ExportFormat = 'csv' | 'json' | 'md' | 'pdf'

function defaultFilename(): string {
  return `bookmark-keeper-${new Date().toISOString().slice(0, 10)}`
}

function extFor(fmt: ExportFormat): string {
  switch (fmt) {
    case 'csv':
      return '.csv'
    case 'json':
      return '.json'
    case 'md':
      return '.md'
    case 'pdf':
      return '.pdf'
  }
}

export function ExportPanel({
  open,
  onClose,
  selectedCount,
  totalMatching,
  resolvePosts,
  settings,
  onFlash,
}: {
  open: boolean
  onClose: () => void
  selectedCount: number
  totalMatching: number
  resolvePosts: (scope: ExportScope) => Promise<Post[]>
  settings: Settings
  onFlash: (msg: string) => void
}) {
  const t = useT()
  const [tab, setTab] = useState<ExportTab>('posts')
  const [scope, setScope] = useState<ExportScope>('all')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [filename, setFilename] = useState(defaultFilename)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setFilename(defaultFilename())
      setScope(selectedCount > 0 ? 'selected' : 'all')
    }
  }, [open, selectedCount])

  if (!open) return null

  const start = async () => {
    if (busy) return
    if (scope === 'selected' && selectedCount === 0) {
      onFlash(t('lib_export_none_selected'))
      return
    }
    setBusy(true)
    try {
      onFlash(t('exporting'))
      const posts = await resolvePosts(scope)
      if (!posts.length) {
        onFlash(t('no_results'))
        return
      }
      if (tab === 'media') {
        const n = await downloadMedia(posts, (d, tot) => onFlash(`${t('download_media')} ${d}/${tot}`))
        onFlash(`${t('download_media')}: ${n}`)
        onClose()
        return
      }
      const base = (filename.trim() || defaultFilename()).replace(/\.(csv|json|md|pdf)$/i, '')
      if (format === 'pdf') {
        await openPrint(posts)
        onFlash(`${t('print_pdf')}: ${posts.length}`)
        onClose()
        return
      }
      const kind = format as ExportKind
      const batchSize = Math.max(100, Math.min(10000, settings.exportBatchSize || 1000))
      if (posts.length > batchSize) {
        const { zipCount, batchTotal } = await exportPostsBatched(kind, posts, batchSize, (done, tot) => {
          onFlash(`${t('batch_export_progress')} ${done}/${tot}`)
        })
        onFlash(`${t('batch_export_done')}: ${batchTotal} ${t('batches')}, ${zipCount} zip, ${posts.length}`)
      } else if (format === 'csv') {
        saveBlob(`${base}.csv`, postsToCsv(posts, { bom: true }), 'text/csv;charset=utf-8')
        onFlash(`${t('export')}: ${posts.length}`)
      } else if (format === 'json') {
        saveBlob(`${base}.json`, postsToJson(posts), 'application/json')
        onFlash(`${t('export')}: ${posts.length}`)
      } else {
        saveBlob(`${base}.md`, postsToMarkdown(posts, { frontmatter: false }), 'text/markdown')
        onFlash(`${t('export')}: ${posts.length}`)
      }
      onClose()
    } catch (e) {
      onFlash((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lib-modal-bg" onClick={onClose}>
      <aside
        className="lib-panel lib-export-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('lib_export_title')}
      >
        <header className="lib-panel-head">
          <div>
            <h2>{t('lib_export_title')}</h2>
            <p className="muted">{t('lib_export_sub')}</p>
          </div>
          <button type="button" className="lib-icon-btn" onClick={onClose} aria-label={t('close')}>
            ×
          </button>
        </header>

        <div className="lib-seg">
          <button type="button" className={tab === 'posts' ? 'active' : ''} onClick={() => setTab('posts')}>
            {t('lib_export_posts')}
          </button>
          <button type="button" className={tab === 'media' ? 'active' : ''} onClick={() => setTab('media')}>
            {t('lib_export_media')}
          </button>
        </div>

        <section className="lib-panel-section">
          <label className="lib-field-label">{t('lib_export_range')}</label>
          <div className="lib-choice-list">
            <button
              type="button"
              className={scope === 'all' ? 'lib-choice active' : 'lib-choice'}
              onClick={() => setScope('all')}
            >
              <span className="lib-radio" />
              <span>
                <b>
                  {tab === 'media' ? t('lib_export_all_media') : t('lib_export_all_posts')} ({totalMatching})
                </b>
                <span className="muted">{t('lib_export_all_hint')}</span>
              </span>
            </button>
            <button
              type="button"
              className={scope === 'selected' ? 'lib-choice active' : 'lib-choice'}
              onClick={() => setScope('selected')}
            >
              <span className="lib-radio" />
              <span>
                <b>
                  {tab === 'media' ? t('lib_export_sel_media') : t('lib_export_sel_posts')} ({selectedCount})
                </b>
                <span className="muted">{t('lib_export_sel_hint')}</span>
              </span>
            </button>
          </div>
        </section>

        {tab === 'posts' && (
          <section className="lib-panel-section">
            <label className="lib-field-label">{t('lib_export_format')}</label>
            <div className="lib-format-grid">
              {(
                [
                  ['csv', 'CSV', 'lib_fmt_csv'],
                  ['json', 'JSON', 'lib_fmt_json'],
                  ['md', 'Markdown', 'lib_fmt_md'],
                  ['pdf', 'PDF', 'lib_fmt_pdf'],
                ] as const
              ).map(([k, title, hint]) => (
                <button
                  key={k}
                  type="button"
                  className={format === k ? 'lib-choice active' : 'lib-choice'}
                  onClick={() => setFormat(k)}
                >
                  <span className="lib-radio" />
                  <span>
                    <b>{title}</b>
                    <span className="muted">{t(hint)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {tab === 'posts' && format !== 'pdf' && (
          <section className="lib-panel-section">
            <label className="lib-field-label">{t('lib_filename')}</label>
            <input className="lib-filename" value={filename} onChange={(e) => setFilename(e.target.value)} />
            <p className="muted small">{t('lib_filename_hint').replace('{ext}', extFor(format))}</p>
          </section>
        )}

        <footer className="lib-panel-foot">
          <button type="button" className="lib-btn primary wide" disabled={busy} onClick={() => void start()}>
            ↓ {busy ? t('exporting') : t('lib_start_export')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
