import { DEFAULT_SETTINGS, STORAGE_KEYS, type AuthInfo, type LastFullSyncMeta, type Settings, type SyncProgress } from './types'
import type { QueryIdMap } from '@/api/endpoints'

async function get<T>(key: string): Promise<T | undefined> {
  const r = await chrome.storage.local.get(key)
  return r[key] as T | undefined
}
async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}), llm: { ...DEFAULT_SETTINGS.llm, ...(saved?.llm ?? {}) } }
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings(await get<Partial<Settings>>(STORAGE_KEYS.settings))
}
export async function saveSettings(s: Settings): Promise<void> {
  await set(STORAGE_KEYS.settings, s)
}

export const getAuth = () => get<AuthInfo>(STORAGE_KEYS.auth)
export const saveAuth = (a: AuthInfo) => set(STORAGE_KEYS.auth, a)

export const getLearnedQueryIds = async () => (await get<QueryIdMap>(STORAGE_KEYS.queryIds)) ?? {}
export const saveLearnedQueryIds = (m: QueryIdMap) => set(STORAGE_KEYS.queryIds, m)

export const getProgress = () => get<SyncProgress>(STORAGE_KEYS.progress)
export const saveProgress = (p: SyncProgress) => set(STORAGE_KEYS.progress, p)

export const getTimelineProgress = () => get<SyncProgress>(STORAGE_KEYS.timelineProgress)
export const saveTimelineProgress = (p: SyncProgress) => set(STORAGE_KEYS.timelineProgress, p)

/** 通知各 UI 页面数据库已变化 (storage.onChanged 触发刷新) */
export async function bumpDbVersion(): Promise<void> {
  await set(STORAGE_KEYS.dbVersion, Date.now())
}

export const getLastFullSync = () => get<LastFullSyncMeta>(STORAGE_KEYS.lastFullSync)
export const saveLastFullSync = (m: LastFullSyncMeta) => set(STORAGE_KEYS.lastFullSync, m)
