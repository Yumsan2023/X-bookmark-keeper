/**
 * v2 Auto-Sync Controller:
 * When the user opens or switches to x.com, automatically identifies the currently logged-in
 * X account (@handle) and triggers a quiet, rate-safe incremental bookmark sync without
 * requiring manual account selection or manual button clicks.
 */
import { canonicalScreenName } from '@/shared/accounts'
import { STORAGE_KEYS, type Settings } from '@/shared/types'

export type AutoSyncLastMap = Record<string, number>

export interface AutoSyncDecision {
  run: boolean
  reason: 'ok' | 'disabled' | 'no-auth' | 'busy' | 'no-account' | 'cooldown'
  account?: string
  waitMs?: number
}

/** Pure decision function (easily unit-tested). */
export function decideAutoSync(input: {
  settings: Pick<Settings, 'autoSyncOnXOpen' | 'autoSyncCooldownMin'>
  hasAuth: boolean
  busy: boolean
  account: string
  lastMap: AutoSyncLastMap
  now?: number
}): AutoSyncDecision {
  if (!input.settings.autoSyncOnXOpen) return { run: false, reason: 'disabled' }
  if (!input.hasAuth) return { run: false, reason: 'no-auth' }
  if (input.busy) return { run: false, reason: 'busy' }
  const account = canonicalScreenName(input.account)
  if (!account) return { run: false, reason: 'no-account' }
  const now = input.now ?? Date.now()
  const cooldownMs = Math.max(1, Math.min(1440, Number(input.settings.autoSyncCooldownMin) || 20)) * 60_000
  const lastAt = Number(input.lastMap[account] || 0)
  if (lastAt > 0 && now - lastAt < cooldownMs) {
    return { run: false, reason: 'cooldown', account, waitMs: cooldownMs - (now - lastAt) }
  }
  return { run: true, reason: 'ok', account }
}

export async function readAutoSyncLastMap(): Promise<AutoSyncLastMap> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.autoSyncLast)
    const raw = got[STORAGE_KEYS.autoSyncLast]
    return raw && typeof raw === 'object' ? (raw as AutoSyncLastMap) : {}
  } catch {
    return {}
  }
}

export async function markAutoSyncRan(account: string, now = Date.now()): Promise<void> {
  const name = canonicalScreenName(account)
  if (!name) return
  const map = await readAutoSyncLastMap()
  map[name] = now
  await chrome.storage.local.set({ [STORAGE_KEYS.autoSyncLast]: map })
}
