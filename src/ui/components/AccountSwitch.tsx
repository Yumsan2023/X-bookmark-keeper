import { useEffect, useState } from 'react'
import { countUnstampedBookmarks, listBookmarkAccounts } from '@/db/posts'
import { UNKNOWN_ACCOUNT } from '@/shared/accounts'
import { useT } from '../i18n'

/** One-click collector account. Empty string means every account. */
export function AccountSwitch({
  value,
  onChange,
  revision,
}: {
  value: string
  onChange: (account: string) => void
  revision: number
}) {
  const t = useT()
  const [accounts, setAccounts] = useState<{ account: string; count: number }[]>([])
  const [unknownCount, setUnknownCount] = useState(0)

  useEffect(() => {
    let cancel = false
    void Promise.all([listBookmarkAccounts(), countUnstampedBookmarks()]).then(([rows, unknown]) => {
      if (cancel) return
      setAccounts(rows)
      setUnknownCount(unknown)
    })
    return () => {
      cancel = true
    }
  }, [revision])

  if (!accounts.length && unknownCount === 0) return null

  const chip = (id: string, label: string, count?: number, title?: string) => (
    <button
      key={id || 'all'}
      type="button"
      className={value === id ? 'account-switch-chip active' : 'account-switch-chip'}
      aria-pressed={value === id}
      title={title}
      onClick={() => onChange(id)}
    >
      {label}
      {count != null && <span className="account-switch-count">{count}</span>}
    </button>
  )

  return (
    <div className="account-switch" role="group" aria-label={t('account_filter')}>
      <span className="account-switch-label" title={t('account_switch_hint')}>
        {t('account_filter')}
      </span>
      {chip('', t('all'))}
      {accounts.map((row) => chip(row.account, `@${row.account}`, row.count))}
      {chip(UNKNOWN_ACCOUNT, t('account_unknown_short'), unknownCount, t('account_unknown'))}
    </div>
  )
}
