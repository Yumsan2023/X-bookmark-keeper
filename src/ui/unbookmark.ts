import { getPosts } from '@/db/posts'
import { partitionDeletes } from '@/shared/accounts'
import type { Key } from './i18n'
import { bg } from './hooks'

type T = (key: Key, vars?: Record<string, string | number>) => string

export async function confirmUnbookmark(opts: {
  ids: string[]
  confirmBulk: boolean
  t: T
  confirm: (message: string) => Promise<boolean>
}): Promise<string | null> {
  const { ids, t, confirm } = opts
  if (!ids.length) return null
  const current = await bg<{ screen_name: string }>({ type: 'account/current' })
  if (!current.ok || !current.data?.screen_name) return t('del_no_account') + (current.error ?? '')
  const account = current.data.screen_name
  const posts = await getPosts(ids)
  const part = partitionDeletes(ids, posts, account)
  if (!part.allowed.length) return t('del_skipped', { n: part.skipped.length, acct: account })
  const who = t('del_current_account', { acct: account })
  const lines = [who, `${t('confirm_unbookmark')} (${part.allowed.length})`]
  if (part.skipped.length) lines.push(t('del_will_skip', { n: part.skipped.length, acct: account }))
  if (part.unknown.length) lines.push(t('del_unknown_warn', { n: part.unknown.length, acct: account }))
  if ((opts.confirmBulk || part.skipped.length > 0 || part.unknown.length > 0) && !(await confirm(lines.join('\n\n')))) return null
  const hard = await confirm(`${who}\n\n${t('confirm_unbookmark_hard')}`)
  const result = await bg<{ account: string; queued: number; skipped: number }>({
    type: 'bookmarks/delete',
    tweetIds: ids,
    removeLocal: hard,
  })
  if (!result.ok || !result.data) return result.error ?? 'error'
  const notes: string[] = []
  if (result.data.queued) notes.push(t('del_queued', { n: result.data.queued, acct: result.data.account }))
  if (result.data.skipped) notes.push(t('del_skipped', { n: result.data.skipped, acct: result.data.account }))
  return notes.join(' · ')
}
