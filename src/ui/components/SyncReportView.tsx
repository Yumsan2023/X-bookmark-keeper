import { useEffect, useState } from 'react'
import { computeSyncReportStats, type SyncReportStats } from '@/report/aggregate'
import { CONTENT_KIND_META, type ContentKind } from '@/report/classify'
import type { LastFullSyncMeta } from '@/shared/types'
import { STORAGE_KEYS } from '@/shared/types'
import { useLang, useT } from '../i18n'

function fmtSyncTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface SyncReportViewProps {
  open: boolean
  onClose: () => void
  /** Navigate to bookmark list filtered by author handle (without @) */
  onViewAuthor: (screenName: string) => void
  /** Optional override for "synced in this run" (defaults to lastFullSync.syncedInRun or total) */
  syncedInRun?: number
  lastSyncAt?: number
}

export function SyncReportView({ open, onClose, onViewAuthor, syncedInRun, lastSyncAt }: SyncReportViewProps) {
  const t = useT()
  const lang = useLang()
  const [stats, setStats] = useState<SyncReportStats | null>(null)
  const [meta, setMeta] = useState<LastFullSyncMeta | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [r, stored] = await Promise.all([
          computeSyncReportStats(),
          chrome.storage.local.get(STORAGE_KEYS.lastFullSync),
        ])
        if (!alive) return
        setStats(r)
        setMeta(stored[STORAGE_KEYS.lastFullSync] as LastFullSyncMeta | undefined)
      } catch (e) {
        if (alive) setError((e as Error)?.message ?? String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const n =
    syncedInRun ??
    meta?.syncedInRun ??
    stats?.total ??
    0
  const at = lastSyncAt ?? meta?.at
  const kindLabel = (k: ContentKind) =>
    lang === 'zh' ? CONTENT_KIND_META[k].labelZh : CONTENT_KIND_META[k].labelEn

  return (
    <div className="modal-bg sync-report-bg" onClick={onClose}>
      <div className="modal sync-report" onClick={(e) => e.stopPropagation()}>
        <button className="x sync-report-close" aria-label={t('close')} onClick={onClose}>
          ×
        </button>

        <header className="sync-report-hero">
          <h2>{t('report_hero_title')}</h2>
          <p className="muted">{t('report_hero_sub')}</p>
        </header>

        <section className="sync-report-success">
          <div className="sync-report-check" aria-hidden>
            ✓
          </div>
          <div>
            <h3>{t('report_title')}</h3>
            <p>
              {t('report_synced_prefix')}
              <b> {n} </b>
              {t('report_synced_suffix')}
            </p>
            <p className="muted">
              {t('report_last_sync')}: {at ? fmtSyncTime(at) : '—'}
            </p>
          </div>
        </section>

        {loading && <p className="muted">{t('report_loading')}</p>}
        {error && <p className="err">{error}</p>}

        {stats && !loading && (
          <>
            <section className="sync-report-section">
              <h3>{t('report_distribution')}</h3>
              <div className="sync-report-bar" role="img" aria-label={t('report_distribution')}>
                {stats.kinds
                  .filter((k) => k.count > 0)
                  .map((k) => (
                    <span
                      key={k.kind}
                      className="sync-report-seg"
                      style={{
                        width: `${Math.max(k.percent, k.count ? 0.5 : 0)}%`,
                        background: CONTENT_KIND_META[k.kind].color,
                      }}
                      title={`${kindLabel(k.kind)}: ${k.count} (${k.percent}%)`}
                    />
                  ))}
                {stats.total === 0 && <span className="sync-report-seg empty" style={{ width: '100%' }} />}
              </div>
              <div className="sync-report-legend">
                {stats.kinds.map((k) => (
                  <div key={k.kind} className="sync-report-legend-item">
                    <span className="dot" style={{ background: CONTENT_KIND_META[k.kind].color }} />
                    <span className="name">{kindLabel(k.kind)}</span>
                    <span className="stat">
                      {k.count} · {k.percent}%
                    </span>
                  </div>
                ))}
              </div>
              <p className="muted sync-report-scope">
                {t('report_scope_hint').replace('{n}', String(stats.total))}
              </p>
            </section>

            <section className="sync-report-section">
              <h3>{t('report_authors')}</h3>
              <ul className="sync-report-authors">
                {stats.authors.map((a) => (
                  <li key={a.screen_name || a.user_id}>
                    {a.avatar ? (
                      <img className="avatar" src={a.avatar} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="avatar avatar-fallback">{(a.name || a.screen_name || '?')[0]}</span>
                    )}
                    <div className="author-meta">
                      <b>{a.name || a.screen_name}</b>
                      <span className="muted">@{a.screen_name}</span>
                    </div>
                    <span className="stat">
                      {a.count} · {a.percent}%
                    </span>
                    <button
                      className="link-btn"
                      onClick={() => {
                        onViewAuthor(a.screen_name)
                        onClose()
                      }}
                    >
                      {t('report_view_bookmarks')}
                    </button>
                  </li>
                ))}
                {(stats.otherAuthors.count > 0 || stats.authors.length === 0) && (
                  <li className="other">
                    <span className="avatar avatar-fallback">···</span>
                    <div className="author-meta">
                      <b>{t('report_other_authors')}</b>
                    </div>
                    <span className="stat">
                      {stats.otherAuthors.count} · {stats.otherAuthors.percent}%
                    </span>
                    <span />
                  </li>
                )}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
