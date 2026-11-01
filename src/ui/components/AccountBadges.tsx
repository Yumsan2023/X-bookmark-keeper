import type { DragEvent } from 'react'
import { useT } from '../i18n'

export function AccountBadges({ accounts }: { accounts?: string[] }) {
  const t = useT()
  if (!accounts?.length) return null
  return (
    <>
      {accounts.map((account) => (
        <span key={account} className="badge acct" title={t('account_badge_title')}>
          👤 @{account}
        </span>
      ))}
    </>
  )
}

export function dragBookmarkIds(event: DragEvent, tweetId: string, selected: Set<string>) {
  const ids = selected.has(tweetId) ? [...selected] : [tweetId]
  event.dataTransfer.setData('application/x-bk-ids', JSON.stringify(ids))
  event.dataTransfer.effectAllowed = 'move'
}

export function readDraggedIds(event: DragEvent): string[] {
  const raw = event.dataTransfer.getData('application/x-bk-ids')
  if (!raw) return []
  try {
    const ids = JSON.parse(raw) as unknown
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id) : []
  } catch {
    return []
  }
}

export function folderColor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 55% 48%)`
}
