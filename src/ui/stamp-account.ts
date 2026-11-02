import { listBookmarkAccounts } from '@/db/posts'
import { canonicalScreenName } from '@/shared/accounts'
import { STORAGE_KEYS } from '@/shared/types'
import { bg } from './hooks'

type StoredAccounts = Record<string, { user_id?: string; last_seen_at?: number }>

/** Last handle the user confirmed for bookmark stamps. */
export async function readStampAccount(): Promise<string> {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.stampAccount)
    return canonicalScreenName(raw[STORAGE_KEYS.stampAccount])
  } catch {
    return ''
  }
}

/** Remember the confirmed stamp account and keep it in the known-account list. */
export async function saveStampAccount(handle: string): Promise<void> {
  const name = canonicalScreenName(handle)
  if (!name) return
  const raw = await chrome.storage.local.get(STORAGE_KEYS.accounts)
  const stored = { ...((raw[STORAGE_KEYS.accounts] ?? {}) as StoredAccounts) }
  const prev = stored[name] ?? {}
  stored[name] = { ...prev, last_seen_at: Date.now() }
  await chrome.storage.local.set({
    [STORAGE_KEYS.stampAccount]: name,
    [STORAGE_KEYS.accounts]: stored,
  })
}

/** Handles already stamped or previously confirmed, for the picker. */
export async function readKnownAccounts(): Promise<string[]> {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.accounts)
    const stored = (raw[STORAGE_KEYS.accounts] ?? {}) as StoredAccounts
    const fromDb = await listBookmarkAccounts().catch(() => [])
    const names = new Set<string>()
    for (const key of Object.keys(stored)) {
      const name = canonicalScreenName(key)
      if (name) names.add(name)
    }
    for (const row of fromDb) {
      const name = canonicalScreenName(row.account)
      if (name) names.add(name)
    }
    return [...names].sort()
  } catch {
    return []
  }
}

export interface LibrarySyncAccount {
  account: string
  /** Saved stamp and the live login disagree. The user should confirm on the Sync page. */
  conflict?: { detected: string; chosen: string }
}

/**
 * Account for the library's quick incremental button.
 * A saved confirmation is used when it matches detection, or when detection fails.
 * A mismatch does not start a sync.
 */
export async function resolveLibrarySyncAccount(): Promise<LibrarySyncAccount> {
  const saved = await readStampAccount()
  let detected = ''
  try {
    const r = await bg<{ screen_name: string }>({ type: 'account/current' })
    if (r.ok) detected = canonicalScreenName(r.data?.screen_name)
  } catch {
    detected = ''
  }
  if (saved && detected && saved !== detected) return { account: '', conflict: { detected, chosen: saved } }
  const account = saved || detected
  if (account) await saveStampAccount(account)
  return { account }
}
