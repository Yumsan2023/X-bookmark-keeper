import { useEffect, useState } from 'react'
import { accountLibraryFileName, serializeAccountLibrary } from '@/backup/account-library'
import { collectAccountLibraryExport } from '@/backup/io'
import { countUnstampedBookmarks, listBookmarkAccounts } from '@/db/posts'
import { UNKNOWN_ACCOUNT } from '@/shared/accounts'
import { useT } from '../i18n'
import { saveBlob } from '../util'

export function AccountBookmarkExport({
  revision = 0,
  onNotify,
}: {
  revision?: number
  onNotify?: (message: string) => void
}) {
  const t = useT()
  const [accounts, setAccounts] = useState<{ account: string; count: number }[]>([])
  const [unknownCount, setUnknownCount] = useState(0)
  const [account, setAccount] = useState('')
  const [includeUnknown, setIncludeUnknown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancel = false
    setReady(false)
    void Promise.all([listBookmarkAccounts(), countUnstampedBookmarks()])
      .then(([rows, unknown]) => {
        if (cancel) return
        setLoadFailed(false)
        setAccounts(rows)
        setUnknownCount(unknown)
        setAccount((prev) => {
          if (prev && (rows.some((row) => row.account === prev) || prev === UNKNOWN_ACCOUNT)) return prev
          if (rows[0]?.account) return rows[0].account
          if (unknown > 0) return UNKNOWN_ACCOUNT
          return ''
        })
      })
      .catch(() => {
        if (!cancel) setLoadFailed(true)
      })
      .finally(() => {
        if (!cancel) setReady(true)
      })
    return () => {
      cancel = true
    }
  }, [revision])

  const named = account !== '' && account !== UNKNOWN_ACCOUNT
  const emptyLibrary = ready && accounts.length === 0 && unknownCount === 0

  const exportFile = async () => {
    if (!account || busy) return
    setBusy(true)
    setErr('')
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const file = await collectAccountLibraryExport({
        account,
        includeUnknown: named && includeUnknown,
      })
      if (!file || file.posts.length === 0) {
        setErr(t('account_export_empty'))
        return
      }
      saveBlob(accountLibraryFileName(file.account), serializeAccountLibrary(file), 'application/json')
      const label = file.account === UNKNOWN_ACCOUNT ? t('account_unknown') : `@${file.account}`
      onNotify?.(t('account_export_done', { account: label, n: file.posts.length }))
    } catch (error) {
      setErr(error instanceof Error ? error.message : t('full_backup_err_write'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backup-card">
      <h3>{t('account_export_title')}</h3>
      <p className="muted">{t('account_export_help')}</p>
      <label>
        {t('account_export_pick')}
        <select
          value={account}
          disabled={busy || emptyLibrary}
          onChange={(event) => {
            setAccount(event.target.value)
            setErr('')
          }}
        >
          {!account && <option value="">{t('account_export_placeholder')}</option>}
          {accounts.map((row) => (
            <option key={row.account} value={row.account}>
              @{row.account} ({row.count})
            </option>
          ))}
          <option value={UNKNOWN_ACCOUNT}>
            {t('account_unknown')} ({unknownCount})
          </option>
        </select>
      </label>
      {emptyLibrary && <p className="muted">{t('account_export_none_accounts')}</p>}
      {named && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={includeUnknown}
              disabled={busy}
              onChange={(event) => setIncludeUnknown(event.target.checked)}
            />
            {t('account_export_include_unknown')}
          </label>
          <p className="muted">{t('account_export_include_unknown_hint')}</p>
        </>
      )}
      <p className="muted">{t('account_export_restore_hint')}</p>
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy || !account} onClick={() => void exportFile()}>
          {busy ? t('account_export_exporting') : t('account_export_button')}
        </button>
      </div>
      {(err || loadFailed) && (
        <p className="err" role="alert">
          {err || t('full_backup_err_write')}
        </p>
      )}
    </div>
  )
}
