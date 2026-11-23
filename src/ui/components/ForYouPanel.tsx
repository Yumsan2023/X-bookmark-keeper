import { useCallback, useEffect, useState } from 'react'
import { bg } from '../hooks'
import { useT } from '../i18n'
import type { ForYouDecisionRow, ForYouValidationRow } from '@/foryou/types'

/**
 * For You 面板（M4，设计 §6.3）：画像状态、离线验证、决策日志。
 * 数据走后台消息（foryou/status / foryou/decisions），不直接读 Dexie；
 * 反馈走 FORYOU_FEEDBACK（大写消息进 store 的 dispatchStrike）；
 * 误藏撤销复用已有的 bookmarks/delete（带账号校验，见 deleteBookmarks）。
 * dislike 不自动取消收藏（已确认的默认），撤销要在这里手动点。
 */

interface ForYouStatus {
  running: boolean
  progress: { job: 'profile' | 'validate'; status: string; done: number; total: number; message: string } | null
  profile: { builtAt: number; sampleSize: number; model: string; endpoint: string; dim: number; holdout: number } | null
  lastValidation: ForYouValidationRow | null
}

function fmtTime(at: number) {
  try {
    return new Date(at).toLocaleString()
  } catch {
    return String(at)
  }
}

function fmtScore(v: number | null | undefined) {
  return v == null ? '–' : v.toFixed(2)
}

export function ForYouPanel() {
  const t = useT()
  const [status, setStatus] = useState<ForYouStatus | null>(null)
  const [decisions, setDecisions] = useState<ForYouDecisionRow[]>([])
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const s = await bg<ForYouStatus>({ type: 'foryou/status' })
    if (s.ok && s.data) setStatus(s.data)
    const d = await bg<ForYouDecisionRow[]>({ type: 'foryou/decisions' })
    if (d.ok && Array.isArray(d.data)) setDecisions(d.data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Job 跑着的时候轮询进度，停了就停（避免 service worker 被轮询吵醒）。
  useEffect(() => {
    if (!status?.running) return
    const timer = window.setInterval(() => void load(), 1500)
    return () => window.clearInterval(timer)
  }, [status?.running, load])

  const run = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) => {
      setBusy(label)
      setNote('')
      try {
        const res = await fn()
        const err = !res.ok ? res.error : (res.data as { error?: string } | undefined)?.error
        if (err) setNote(err)
      } catch (e) {
        setNote((e as Error).message)
      } finally {
        setBusy('')
        await load()
      }
    },
    [load],
  )

  const cancel = () => {
    const job = status?.progress?.job
    return run('cancel', () => bg(job === 'validate' ? { type: 'foryou/cancelValidate' } : { type: 'foryou/cancelProfile' }))
  }

  const feedback = (row: ForYouDecisionRow, kind: 'like' | 'dislike') =>
    run(`fb-${row.tweet_id}`, async () => {
      const res = (await chrome.runtime.sendMessage({
        type: 'FORYOU_FEEDBACK',
        tweetId: row.tweet_id,
        kind,
        handle: row.handle || '',
        text: row.textSnippet || '',
      })) as { ok?: boolean; error?: string }
      return res?.ok ? { ok: true } : { ok: false, error: res?.error }
    })

  const unbookmark = (row: ForYouDecisionRow) =>
    run(`un-${row.tweet_id}`, async () => {
      if (!window.confirm(t('confirm_unbookmark'))) return { ok: true }
      return bg({ type: 'bookmarks/delete', tweetIds: [row.tweet_id], removeLocal: false })
    })

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayStartMs = todayStart.getTime()
  const bookmarkedToday = decisions.filter(
    (d) => d.decision === 'bookmark' && d.status === 'bookmarked' && d.at >= todayStartMs,
  ).length
  const hiddenCount = decisions.filter((d) => d.decision === 'hide').length
  const bookmarked = decisions.filter((d) => d.status === 'bookmarked')
  const disliked = bookmarked.filter((d) => d.feedback === 'dislike').length
  const dislikeRate = bookmarked.length ? Math.round((disliked / bookmarked.length) * 100) : 0

  const validation = status?.lastValidation ?? null
  const topRows = validation
    ? [...validation.thresholds].sort((a, b) => b.f1 - a.f1 || b.recall - a.recall).slice(0, 6)
    : []

  return (
    <div className="panel">
      <h3>{t('foryou_panel_title')}</h3>
      <p className="muted">{t('foryou_panel_help')}</p>
      {note && <div className="info">{note}</div>}

      <h4>{t('foryou_profile')}</h4>
      {status?.profile ? (
        <p className="muted">
          {t('foryou_profile_built')}{' '}
          {fmtTime(status.profile.builtAt)} · {status.profile.sampleSize} {t('foryou_profile_samples')} ·{' '}
          {status.profile.model} · {status.profile.dim} {t('foryou_profile_dim')} · holdout {status.profile.holdout}
        </p>
      ) : (
        <p className="muted">{t('foryou_no_profile')}</p>
      )}
      <div>
        <button type="button" disabled={!!status?.running || busy !== ''} onClick={() => void run('build', () => bg({ type: 'foryou/buildProfile' }))}>
          {t('foryou_build_profile')}
        </button>{' '}
        <button type="button" disabled={!!status?.running || busy !== ''} onClick={() => void run('validate', () => bg({ type: 'foryou/validate' }))}>
          {t('foryou_validate')}
        </button>{' '}
        {status?.running && (
          <button type="button" onClick={() => void cancel()}>
            {t('foryou_cancel')}
          </button>
        )}
      </div>
      {status?.progress && (
        <p className="muted">
          {status.progress.job === 'validate' ? t('foryou_validate') : t('foryou_build_profile')} · {status.progress.status} ·{' '}
          {status.progress.done}/{status.progress.total} · {status.progress.message}
        </p>
      )}

      <h4>{t('foryou_validation')}</h4>
      {validation ? (
        <div>
          <p className="muted">
            {fmtTime(validation.at)} · {validation.mode} · {t('foryou_val_pos')} {validation.nPos} · {t('foryou_val_neg')} {validation.nNeg}
            {validation.degraded ? ` · ${t('foryou_degraded_note')}` : ''}
          </p>
          {validation.notes && <p className="muted">{validation.notes}</p>}
          {validation.degraded ? (
            <p className="muted">
              {t('foryou_val_pos_median')} {fmtScore(validation.posMedian)} · {t('foryou_val_pos_p10')} {fmtScore(validation.posP10)}
            </p>
          ) : (
            <>
              <p>
                {t('foryou_suggested')}{' '}
                {validation.suggested
                  ? `≥ ${validation.suggested.bookmark} / ≤ ${validation.suggested.hide}`
                  : t('foryou_no_suggestion')}
              </p>
              {validation.suggested && (
                <button
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => void run('apply', () => bg({ type: 'foryou/applyValidation', validationId: validation.id }))}
                >
                  {t('foryou_apply_suggested')}
                </button>
              )}
              {topRows.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>{t('foryou_thr_bookmark')}</th>
                      <th>{t('foryou_thr_hide')}</th>
                      <th>P</th>
                      <th>R</th>
                      <th>F1</th>
                      <th>{t('foryou_thr_kill')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topRows.map((r) => (
                      <tr
                        key={`${r.bookmark}-${r.hide}`}
                        style={
                          validation.suggested?.bookmark === r.bookmark && validation.suggested?.hide === r.hide
                            ? { fontWeight: 'bold' }
                            : undefined
                        }
                      >
                        <td>{r.bookmark.toFixed(2)}</td>
                        <td>{r.hide.toFixed(2)}</td>
                        <td>{r.precision.toFixed(2)}</td>
                        <td>{r.recall.toFixed(2)}</td>
                        <td>{r.f1.toFixed(2)}</td>
                        <td>{(r.hideKillRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      ) : (
        <p className="muted">{t('foryou_no_validation')}</p>
      )}

      <h4>{t('foryou_decisions')}</h4>
      <p className="muted">
        {t('foryou_stats_today')} {bookmarkedToday} · {t('foryou_stats_hidden')} {hiddenCount} · {t('foryou_stats_dislike')} {dislikeRate}% (
        {disliked}/{bookmarked.length})
      </p>
      {decisions.length === 0 ? (
        <p className="muted">{t('foryou_no_decisions')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('foryou_col_time')}</th>
              <th>{t('foryou_col_post')}</th>
              <th>{t('foryou_col_scores')}</th>
              <th>{t('foryou_col_decision')}</th>
              <th>{t('foryou_col_status')}</th>
              <th>{t('foryou_col_feedback')}</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((row) => (
              <tr key={row.tweet_id}>
                <td>{fmtTime(row.at)}</td>
                <td>
                  <a href={`https://x.com/i/status/${row.tweet_id}`} target="_blank" rel="noreferrer">
                    {row.handle ? `@${row.handle}` : row.tweet_id}
                  </a>
                  {row.textSnippet && <div className="muted">{row.textSnippet}</div>}
                  {row.destination && <div className="muted">→ {row.destination}</div>}
                </td>
                <td>
                  {fmtScore(row.rule)}/{fmtScore(row.vector)}/{fmtScore(row.final)}
                </td>
                <td>{row.decision}</td>
                <td>{row.status ?? '–'}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy === `fb-${row.tweet_id}`}
                    onClick={() => void feedback(row, 'like')}
                  >
                    {row.feedback === 'like' ? `✓ ${t('foryou_feedback_like')}` : t('foryou_feedback_like')}
                  </button>{' '}
                  <button
                    type="button"
                    disabled={busy === `fb-${row.tweet_id}`}
                    onClick={() => void feedback(row, 'dislike')}
                  >
                    {row.feedback === 'dislike' ? `✓ ${t('foryou_feedback_dislike')}` : t('foryou_feedback_dislike')}
                  </button>
                  {row.status === 'bookmarked' && (
                    <>
                      {' '}
                      <button
                        type="button"
                        disabled={busy === `un-${row.tweet_id}`}
                        onClick={() => void unbookmark(row)}
                      >
                        {t('foryou_unbookmark')}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
