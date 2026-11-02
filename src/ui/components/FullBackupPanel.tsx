import { useRef, useState } from 'react'
import { applyRestorePlan, backupFileName, collectFullBackup } from '@/backup/io'
import { backupExceedsSizeLimit, inspectBackupText, serializeBackup, type BackupError, type BackupSummary, type RestorePlan, type SecretName } from '@/backup/full'
import { saveBlob } from '../util'
import { useT, type Key } from '../i18n'

const ERROR_KEY: Record<BackupError, Key> = {
  'bad-json': 'full_backup_err_bad',
  'bad-file': 'full_backup_err_bad',
  'future-version': 'full_backup_err_future',
  'too-large': 'full_backup_err_large',
  'ledger-only': 'full_backup_err_ledger',
}

const OMITTED_KEY: Record<SecretName, Key> = {
  strikeAiKey: 'full_backup_sec_strike',
  bookmarkLlmKey: 'full_backup_sec_llm',
  session: 'full_backup_sec_session',
}

export function FullBackupPanel({ onNotify, onLibraryChange }: { onNotify?: (message: string) => void; onLibraryChange?: () => void }) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<RestorePlan | null>(null)

  const fail = (error: BackupError) => {
    setPreview(null)
    setErr(t(ERROR_KEY[error]))
  }

  const exportFile = async () => {
    setBusy(true)
    setExporting(true)
    setErr('')
    setPreview(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const file = await collectFullBackup(includeSecrets)
      const body = serializeBackup(file)
      saveBlob(backupFileName(), body, 'application/json')
      onNotify?.(t('full_backup_exported'))
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('full_backup_err_write'))
    } finally {
      setExporting(false)
      setBusy(false)
    }
  }

  const onFile = async (list: FileList | null) => {
    const file = list?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    setBusy(true)
    setErr('')
    setPreview(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      if (backupExceedsSizeLimit(file.size)) {
        fail('too-large')
        return
      }
      const inspected = inspectBackupText(await file.text())
      if (!inspected.ok) {
        fail(inspected.error)
        return
      }
      setPreview(inspected.plan)
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('full_backup_err_bad'))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview) return
    setBusy(true)
    setErr('')
    try {
      await applyRestorePlan(preview)
      const message = preview.kind === 'bookmarks-legacy' ? t('full_backup_done_legacy') : t('full_backup_done')
      setPreview(null)
      onLibraryChange?.()
      onNotify?.(message)
    } catch (error) {
      const text = error instanceof Error ? error.message : ''
      setErr(text.startsWith('strike:') ? t('full_backup_err_partial') : text || t('full_backup_err_write'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backup-card">
      <h3>{t('full_backup_title')}</h3>
      <p className="muted">{t('full_backup_help')}</p>
      <p className="muted">{t('full_backup_local_only')}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={includeSecrets}
          disabled={busy}
          onChange={(event) => setIncludeSecrets(event.target.checked)}
        />
        {t('full_backup_secrets')}
      </label>
      <p className="muted">{t('full_backup_secrets_hint')}</p>
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy} onClick={() => void exportFile()}>
          {exporting ? t('full_backup_exporting') : t('full_backup_export')}
        </button>
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t('full_backup_choose')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => void onFile(event.target.files)}
        />
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {preview && <Preview plan={preview} busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void confirm()} />}
    </div>
  )
}

function Preview({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: RestorePlan
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const summary = plan.summary
  const legacy = plan.kind === 'bookmarks-legacy'
  return (
    <div className="backup-preview">
      <h4>{t('full_backup_preview')}</h4>
      <p>
        {t('full_backup_format')}: {summary.format} · {t('full_backup_version')} {summary.version}
        {summary.appVersion ? ` · ${summary.appVersion}` : ''}
      </p>
      {summary.exportedAt && <p className="muted">{summary.exportedAt}</p>}
      <ul className="backup-stats">
        <Stat label={t('full_backup_posts')} value={summary.posts} />
        <Stat label={t('full_backup_folders')} value={summary.folders} />
        {!legacy && <Stat label={t('full_backup_ledger')} value={summary.ledgerAccounts} />}
        {!legacy && <Stat label={t('full_backup_flags')} value={summary.authorFlags} />}
        {!legacy && <Stat label={t('full_backup_packs')} value={summary.keywordPacks} />}
        {!legacy && <Stat label={t('full_backup_rules')} value={summary.keywordRules} />}
        {!legacy && <Stat label={t('full_backup_vetoes')} value={summary.vetoes} />}
        {!legacy && <Stat label={t('full_backup_community')} value={summary.communityLists} />}
        {!legacy && <Stat label={t('full_backup_queue')} value={summary.queue} />}
        {!legacy && <Stat label={t('full_backup_hidden')} value={summary.hidden} />}
      </ul>
      {!legacy && <SecretLine summary={summary} />}
      <div className="backup-warn" role="note">
        <strong>{legacy ? t('full_backup_warn_legacy_title') : t('full_backup_warn_title')}</strong>
        <p>{legacy ? t('full_backup_warn_legacy') : t('full_backup_warn_replace')}</p>
      </div>
      <div className="row wrap">
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
          {legacy ? t('full_backup_confirm_legacy') : t('full_backup_confirm')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>{t('full_backup_cancel')}</button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <li>
      <span className="muted">{label}</span> {value}
    </li>
  )
}

function SecretLine({ summary }: { summary: BackupSummary }) {
  const t = useT()
  if (summary.secretsIncluded) return <p>{t('full_backup_secrets_in_file')}</p>
  if (!summary.omittedSecrets.length) return <p>{t('full_backup_secrets_none')}</p>
  const names = summary.omittedSecrets.map((name) => t(OMITTED_KEY[name])).join(' · ')
  return <p>{t('full_backup_secrets_out_file')}: {names}</p>
}
