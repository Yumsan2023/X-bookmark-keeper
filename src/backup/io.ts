/**
 * Read and replace this browser's extension data.
 * Strike writes go through the background lock (`REPLACE_STATE`).
 * The file never leaves the machine.
 */
import { backupFileName, buildFullBackup, pickStrike, STRIKE_SECRET_KEY, STRIKE_STATE_KEY, type FullBackupFile, type RestorePlan } from '@/backup/full'
import { db } from '@/db/db'
import { bumpDbVersion } from '@/shared/storage'
import { STORAGE_KEYS, type AuthInfo, type Settings } from '@/shared/types'

const EPHEMERAL_KEYS = [
  STORAGE_KEYS.progress,
  STORAGE_KEYS.timelineProgress,
  STORAGE_KEYS.task,
  STORAGE_KEYS.printIds,
] as const

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(keys) as Promise<Record<string, unknown>>
}

function sendStrike(message: unknown): Promise<{ ok?: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (result) => {
        const err = chrome.runtime.lastError
        if (err) resolve({ ok: false, error: err.message })
        else resolve((result as { ok?: boolean; error?: string }) || { ok: false, error: 'empty' })
      })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export async function collectFullBackup(includeSecrets: boolean, now = Date.now()): Promise<FullBackupFile> {
  const got = await storageGet([
    STRIKE_STATE_KEY,
    STRIKE_SECRET_KEY,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.accounts,
    STORAGE_KEYS.queryIds,
    STORAGE_KEYS.libraryColumns,
    STORAGE_KEYS.lastFullSync,
    STORAGE_KEYS.auth,
  ])
  const strike = pickStrike(got[STRIKE_STATE_KEY])
  const secret = got[STRIKE_SECRET_KEY] as { apiKey?: string } | undefined
  const ai = (strike.settings.ai && typeof strike.settings.ai === 'object' ? strike.settings.ai : {}) as Record<string, unknown>
  ai.apiKey = String(secret?.apiKey || ai.apiKey || '')
  strike.settings.ai = ai
  const [posts, folders] = await Promise.all([db.posts.toArray(), db.folders.toArray()])
  return buildFullBackup({
    includeSecrets,
    now,
    strike,
    posts,
    folders,
    storage: {
      settings: (got[STORAGE_KEYS.settings] as Partial<Settings> | undefined) ?? null,
      accounts: got[STORAGE_KEYS.accounts],
      queryIds: got[STORAGE_KEYS.queryIds],
      libraryColumns: got[STORAGE_KEYS.libraryColumns],
      lastFullSync: got[STORAGE_KEYS.lastFullSync] ?? null,
      auth: (got[STORAGE_KEYS.auth] as AuthInfo | undefined) ?? null,
    },
  })
}

export async function replaceBookmarkLibrary(posts: RestorePlan['posts'], folders: RestorePlan['folders']): Promise<void> {
  await db.transaction('rw', db.posts, db.folders, db.searchMeta, async () => {
    await db.posts.clear()
    await db.folders.clear()
    await db.searchMeta.clear()
    const chunk = 500
    for (let i = 0; i < posts.length; i += chunk) {
      await db.posts.bulkPut(posts.slice(i, i + chunk))
    }
    if (folders.length) await db.folders.bulkPut(folders)
  })
}

async function replaceBookmarkStorage(plan: RestorePlan): Promise<void> {
  const storage = plan.storage
  if (!storage) return
  const current = (await storageGet([STORAGE_KEYS.settings, STORAGE_KEYS.auth])) as {
    [k: string]: unknown
  }
  const currentSettings = (current[STORAGE_KEYS.settings] ?? {}) as Partial<Settings>
  const next = storage.settings
  if (!plan.secretsIncluded) {
    next.llm = { ...next.llm, apiKey: currentSettings.llm?.apiKey ?? '' }
  }
  const patch: Record<string, unknown> = {
    [STORAGE_KEYS.settings]: next,
    [STORAGE_KEYS.accounts]: storage.accounts,
    [STORAGE_KEYS.queryIds]: storage.queryIds,
    [STORAGE_KEYS.dbVersion]: Date.now(),
  }
  const remove: string[] = [...EPHEMERAL_KEYS, STORAGE_KEYS.rate]
  if (Array.isArray(storage.libraryColumns)) patch[STORAGE_KEYS.libraryColumns] = storage.libraryColumns
  else remove.push(STORAGE_KEYS.libraryColumns)
  if (storage.lastFullSync && typeof storage.lastFullSync === 'object') patch[STORAGE_KEYS.lastFullSync] = storage.lastFullSync
  else remove.push(STORAGE_KEYS.lastFullSync)
  if (plan.secretsIncluded) {
    if (storage.auth) patch[STORAGE_KEYS.auth] = storage.auth
    else remove.push(STORAGE_KEYS.auth)
  }
  await chrome.storage.local.set(patch)
  await chrome.storage.local.remove(remove)
}

export async function applyRestorePlan(plan: RestorePlan): Promise<void> {
  await replaceBookmarkLibrary(plan.posts, plan.folders)
  if (plan.kind === 'bookmarks-legacy') {
    await chrome.storage.local.remove([...EPHEMERAL_KEYS])
    await bumpDbVersion()
    return
  }
  await replaceBookmarkStorage(plan)
  const result = await sendStrike({
    type: 'REPLACE_STATE',
    state: plan.strike,
    includeSecrets: plan.secretsIncluded,
  })
  if (!result?.ok) {
    throw new Error(`strike:${result?.error || 'failed'}`)
  }
}

export { backupFileName }
