/**
 * One local full-backup file for the extension.
 * Strike ledger (`xsl`), bookmark library, and bookmark chrome.storage
 * travel together. API keys and the captured X session stay out unless
 * the user opts in. Nothing here uploads.
 */
import { ACCOUNT_LIBRARY_FORMAT, resolveAccountExportTarget } from '@/backup/account-library'
import { UNKNOWN_ACCOUNT } from '@/shared/accounts'
import type { AuthInfo, Folder, Post, Settings } from '@/shared/types'
import { mergeSettings } from '@/shared/storage'

export const FULL_BACKUP_FORMAT = 'x-toolkit-full' as const
export const FULL_BACKUP_VERSION = 1 as const
export const APP_VERSION = '0.7.18'
/**
 * Shared ceiling for Settings → 从备份恢复.
 * `File.size` is bytes; `inspectBackupText` uses JavaScript string length.
 * 512 MiB covers a ~115 MB legacy bookmark-keeper JSON with headroom.
 * The options page reads and parses the file once; the cap stays so a
 * multi-gigabyte file is rejected before that work starts.
 * Post, folder, and ledger count caps are unchanged.
 */
export const FULL_BACKUP_MAX_BYTES = 512 * 1024 * 1024
export const FULL_BACKUP_MAX_CHARS = FULL_BACKUP_MAX_BYTES

/** True when a file byte length or backup text length is over the restore ceiling. */
export function backupExceedsSizeLimit(size: number): boolean {
  return size > FULL_BACKUP_MAX_BYTES
}

const MAX_POSTS = 200_000
const MAX_FOLDERS = 5_000
const MAX_LEDGER = 20_000

export const STRIKE_STATE_KEY = 'xsl'
export const STRIKE_SECRET_KEY = 'xslSecret'

export type SecretName = 'strikeAiKey' | 'bookmarkLlmKey' | 'session'

export interface StrikeSlice {
  schema: number
  settings: Record<string, unknown>
  ledger: Record<string, unknown>
  tweets: Record<string, unknown>
  hidden: Record<string, unknown>
  queue: unknown[]
  log: unknown[]
  undo: unknown[]
  aiCache: Record<string, unknown>
  hitLog: unknown[]
  vetoes: unknown[]
  rate: Record<string, unknown>
}

export interface FullBackupStorage {
  settings: Settings
  accounts: Record<string, unknown>
  queryIds: Record<string, unknown>
  libraryColumns: unknown[] | null
  lastFullSync: unknown | null
  /** Present only when secretsIncluded is true and a session was stored. */
  auth?: AuthInfo
}

export interface FullBackupFile {
  format: typeof FULL_BACKUP_FORMAT
  version: typeof FULL_BACKUP_VERSION
  app: 'x-toolkit'
  appVersion: string
  exportedAt: string
  /** True when the user asked to write secrets into this file. */
  secretsIncluded: boolean
  /**
   * Secrets that existed on this browser at export time and were left out.
   * Empty when secretsIncluded is true (those values are in the file, possibly blank).
   */
  omittedSecrets: SecretName[]
  strike: StrikeSlice
  bookmarks: { posts: Post[]; folders: Folder[] }
  storage: FullBackupStorage
}

export interface BackupSummary {
  kind: 'full' | 'bookmarks-legacy' | 'bookmarks-account'
  format: string
  version: number
  appVersion: string
  exportedAt: string
  secretsIncluded: boolean
  omittedSecrets: SecretName[]
  posts: number
  folders: number
  ledgerAccounts: number
  authorFlags: number
  keywordPacks: number
  keywordRules: number
  vetoes: number
  communityLists: number
  queue: number
  hidden: number
}

export interface RestorePlan {
  kind: 'full' | 'bookmarks-legacy' | 'bookmarks-account'
  /**
   * Full files replace extension data. Legacy bookmark-keeper files replace
   * the bookmark library. An account library file merges into the library.
   */
  mode: 'replace' | 'merge'
  summary: BackupSummary
  posts: Post[]
  folders: Folder[]
  strike: StrikeSlice | null
  storage: FullBackupStorage | null
  secretsIncluded: boolean
  /** Collector account on a bookmarks-account file. `__unknown__` is unstamped bookmarks. */
  account?: string
  includeUnknown?: boolean
}

export type BackupError = 'bad-json' | 'bad-file' | 'future-version' | 'too-large' | 'ledger-only'

export type InspectResult = { ok: true; plan: RestorePlan } | { ok: false; error: BackupError }

export interface FullBackupInput {
  includeSecrets: boolean
  now?: number
  strike: unknown
  posts: Post[]
  folders: Folder[]
  storage: {
    settings?: Partial<Settings> | null
    accounts?: unknown
    queryIds?: unknown
    libraryColumns?: unknown
    lastFullSync?: unknown
    auth?: AuthInfo | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function pickStrike(raw: unknown): StrikeSlice {
  const src = asObject(raw)
  const slice: StrikeSlice = {
    schema: typeof src.schema === 'number' ? src.schema : 1,
    settings: asObject(src.settings),
    ledger: asObject(src.ledger),
    tweets: asObject(src.tweets),
    hidden: asObject(src.hidden),
    queue: asArray(src.queue),
    log: asArray(src.log),
    undo: asArray(src.undo),
    aiCache: asObject(src.aiCache),
    hitLog: asArray(src.hitLog),
    vetoes: asArray(src.vetoes),
    rate: asObject(src.rate),
  }
  return clone(slice)
}

function strikeAiKey(settings: Record<string, unknown>): string {
  const ai = asObject(settings.ai)
  return String(ai.apiKey || '')
}

function sessionPresent(auth: AuthInfo | null | undefined): boolean {
  return !!(auth && (String(auth.token || '') || String(auth.csrf || '')))
}

export function buildFullBackup(input: FullBackupInput): FullBackupFile {
  const now = input.now ?? Date.now()
  const includeSecrets = !!input.includeSecrets
  const strike = pickStrike(input.strike)
  const ai = asObject(strike.settings.ai)
  const hadStrikeKey = !!String(ai.apiKey || '')
  ai.apiKey = includeSecrets ? String(ai.apiKey || '').slice(0, 400) : ''
  ai.hasApiKey = includeSecrets ? !!ai.apiKey : hadStrikeKey
  strike.settings.ai = ai

  const settings = mergeSettings(input.storage.settings ?? undefined)
  const hadLlmKey = !!settings.llm.apiKey
  if (!includeSecrets) settings.llm = { ...settings.llm, apiKey: '' }

  const auth = input.storage.auth ?? null
  const hadSession = sessionPresent(auth)
  const storage: FullBackupStorage = {
    settings,
    accounts: asObject(input.storage.accounts),
    queryIds: asObject(input.storage.queryIds),
    libraryColumns: Array.isArray(input.storage.libraryColumns) ? clone(input.storage.libraryColumns) : null,
    lastFullSync: input.storage.lastFullSync == null ? null : clone(input.storage.lastFullSync),
  }
  if (includeSecrets && hadSession && auth) storage.auth = clone(auth)

  const omittedSecrets: SecretName[] = []
  if (!includeSecrets && hadStrikeKey) omittedSecrets.push('strikeAiKey')
  if (!includeSecrets && hadLlmKey) omittedSecrets.push('bookmarkLlmKey')
  if (!includeSecrets && hadSession) omittedSecrets.push('session')

  return {
    format: FULL_BACKUP_FORMAT,
    version: FULL_BACKUP_VERSION,
    app: 'x-toolkit',
    appVersion: APP_VERSION,
    exportedAt: new Date(now).toISOString(),
    secretsIncluded: includeSecrets,
    omittedSecrets,
    strike,
    bookmarks: {
      posts: clone(input.posts),
      folders: clone(input.folders),
    },
    storage,
  }
}

export function backupFileName(now = Date.now()): string {
  return `x-toolkit-full-backup-${new Date(now).toISOString().slice(0, 10)}.json`
}

function countFlags(ledger: Record<string, unknown>): { accounts: number; flags: number } {
  let accounts = 0
  let flags = 0
  for (const value of Object.values(ledger)) {
    if (!isRecord(value)) continue
    accounts += 1
    const authorFlags = asObject(value.authorFlags)
    if (authorFlags.marketing || authorFlags.spam) flags += 1
  }
  return { accounts, flags }
}

function countPacks(settings: Record<string, unknown>): { packs: number; rules: number } {
  const packs = asArray(settings.keywordPacks)
  let rules = 0
  for (const pack of packs) {
    if (isRecord(pack)) rules += asArray(pack.patterns).length
  }
  return { packs: packs.length, rules }
}

function summarizeParts(input: {
  kind: BackupSummary['kind']
  format: string
  version: number
  appVersion: string
  exportedAt: string
  secretsIncluded: boolean
  omittedSecrets: SecretName[]
  posts: number
  folders: number
  strike: StrikeSlice | null
}): BackupSummary {
  const strike = input.strike
  const flags = strike ? countFlags(strike.ledger) : { accounts: 0, flags: 0 }
  const packs = strike ? countPacks(strike.settings) : { packs: 0, rules: 0 }
  const lists = strike ? asArray(strike.settings.communityLists).length : 0
  return {
    kind: input.kind,
    format: input.format,
    version: input.version,
    appVersion: input.appVersion,
    exportedAt: input.exportedAt,
    secretsIncluded: input.secretsIncluded,
    omittedSecrets: input.omittedSecrets,
    posts: input.posts,
    folders: input.folders,
    ledgerAccounts: flags.accounts,
    authorFlags: flags.flags,
    keywordPacks: packs.packs,
    keywordRules: packs.rules,
    vetoes: strike ? strike.vetoes.length : 0,
    communityLists: lists,
    queue: strike ? strike.queue.length : 0,
    hidden: strike ? Object.keys(strike.hidden).length : 0,
  }
}

function isPost(value: unknown): value is Post {
  return isRecord(value) && typeof value.tweet_id === 'string' && value.tweet_id.length > 0 && value.tweet_id.length <= 40
}

function isFolder(value: unknown): value is Folder {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 200
}

function takePosts(raw: unknown): Post[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_POSTS) return null
  const map = new Map<string, Post>()
  for (const item of raw) {
    if (!isPost(item)) return null
    map.set(item.tweet_id, item)
  }
  return [...map.values()]
}

function takeFolders(raw: unknown): Folder[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > MAX_FOLDERS) return null
  const map = new Map<string, Folder>()
  for (const item of raw) {
    if (!isFolder(item)) return null
    map.set(item.name, item)
  }
  return [...map.values()]
}

function takeOmitted(raw: unknown): SecretName[] | null {
  if (!Array.isArray(raw)) return []
  const allowed: SecretName[] = ['strikeAiKey', 'bookmarkLlmKey', 'session']
  const out: SecretName[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.includes(item as SecretName)) return null
    if (!out.includes(item as SecretName)) out.push(item as SecretName)
  }
  return out
}

function isLegacyBookmark(raw: Record<string, unknown>): boolean {
  if (raw.format === ACCOUNT_LIBRARY_FORMAT) return false
  return raw.app === 'bookmark-keeper' && raw.version === 1 && Array.isArray(raw.posts) && Array.isArray(raw.folders)
}

function isLedgerOnly(raw: Record<string, unknown>): boolean {
  if (raw.format === FULL_BACKUP_FORMAT || raw.app === 'bookmark-keeper') return false
  return raw.product === 'x-strike-ledger' || (typeof raw.schema === 'number' && 'ledger' in raw && !('bookmarks' in raw))
}

function oversizedLists(posts: unknown, folders: unknown): boolean {
  return (Array.isArray(posts) && posts.length > MAX_POSTS) || (Array.isArray(folders) && folders.length > MAX_FOLDERS)
}

function inspectAccountLibrary(raw: Record<string, unknown>): InspectResult {
  if (raw.version !== 1) {
    return { ok: false, error: typeof raw.version === 'number' && raw.version > 1 ? 'future-version' : 'bad-file' }
  }
  if (raw.app !== 'bookmark-keeper') return { ok: false, error: 'bad-file' }
  if (oversizedLists(raw.posts, raw.folders)) return { ok: false, error: 'too-large' }
  const posts = takePosts(raw.posts)
  const folders = takeFolders(raw.folders)
  if (!posts || !folders) return { ok: false, error: 'bad-file' }
  const account = resolveAccountExportTarget(raw.account)
  if (!account) return { ok: false, error: 'bad-file' }
  if (raw.includeUnknown != null && typeof raw.includeUnknown !== 'boolean') return { ok: false, error: 'bad-file' }
  const includeUnknown = account === UNKNOWN_ACCOUNT ? true : raw.includeUnknown === true
  const exportedAt = typeof raw.exported_at === 'number' ? new Date(raw.exported_at).toISOString() : ''
  const summary = summarizeParts({
    kind: 'bookmarks-account',
    format: ACCOUNT_LIBRARY_FORMAT,
    version: 1,
    appVersion: '',
    exportedAt,
    secretsIncluded: false,
    omittedSecrets: [],
    posts: posts.length,
    folders: folders.length,
    strike: null,
  })
  return {
    ok: true,
    plan: {
      kind: 'bookmarks-account',
      mode: 'merge',
      summary,
      posts,
      folders,
      strike: null,
      storage: null,
      secretsIncluded: false,
      account,
      includeUnknown,
    },
  }
}

function inspectLegacy(raw: Record<string, unknown>): InspectResult {
  if (oversizedLists(raw.posts, raw.folders)) return { ok: false, error: 'too-large' }
  const posts = takePosts(raw.posts)
  const folders = takeFolders(raw.folders)
  if (!posts || !folders) return { ok: false, error: 'bad-file' }
  const exportedAt = typeof raw.exported_at === 'number' ? new Date(raw.exported_at).toISOString() : ''
  const summary = summarizeParts({
    kind: 'bookmarks-legacy',
    format: 'bookmark-keeper',
    version: 1,
    appVersion: '',
    exportedAt,
    secretsIncluded: false,
    omittedSecrets: [],
    posts: posts.length,
    folders: folders.length,
    strike: null,
  })
  return {
    ok: true,
    plan: {
      kind: 'bookmarks-legacy',
      mode: 'replace',
      summary,
      posts,
      folders,
      strike: null,
      storage: null,
      secretsIncluded: false,
    },
  }
}

function inspectFull(raw: Record<string, unknown>): InspectResult {
  if (raw.version !== FULL_BACKUP_VERSION) {
    return { ok: false, error: typeof raw.version === 'number' && raw.version > FULL_BACKUP_VERSION ? 'future-version' : 'bad-file' }
  }
  const bookmarks = asObject(raw.bookmarks)
  if (oversizedLists(bookmarks.posts, bookmarks.folders)) return { ok: false, error: 'too-large' }
  const posts = takePosts(bookmarks.posts)
  const folders = takeFolders(bookmarks.folders)
  if (!posts || !folders) return { ok: false, error: 'bad-file' }
  if (!isRecord(raw.strike) || !isRecord(raw.storage)) return { ok: false, error: 'bad-file' }
  const strike = pickStrike(raw.strike)
  if (Object.keys(strike.ledger).length > MAX_LEDGER) return { ok: false, error: 'too-large' }
  const storageRaw = raw.storage
  if (!isRecord(storageRaw.settings)) return { ok: false, error: 'bad-file' }
  const omitted = takeOmitted(raw.omittedSecrets)
  if (!omitted) return { ok: false, error: 'bad-file' }
  const secretsIncluded = raw.secretsIncluded === true
  if (!secretsIncluded) {
    const ai = asObject(strike.settings.ai)
    ai.apiKey = ''
    strike.settings.ai = ai
  }
  const storage: FullBackupStorage = {
    settings: mergeSettings(storageRaw.settings as Partial<Settings>),
    accounts: asObject(storageRaw.accounts),
    queryIds: asObject(storageRaw.queryIds),
    libraryColumns: Array.isArray(storageRaw.libraryColumns) ? storageRaw.libraryColumns : null,
    lastFullSync: storageRaw.lastFullSync == null ? null : storageRaw.lastFullSync,
  }
  if (secretsIncluded && isRecord(storageRaw.auth)) storage.auth = storageRaw.auth as unknown as AuthInfo
  if (!secretsIncluded) storage.settings.llm = { ...storage.settings.llm, apiKey: '' }
  const summary = summarizeParts({
    kind: 'full',
    format: FULL_BACKUP_FORMAT,
    version: FULL_BACKUP_VERSION,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    secretsIncluded,
    omittedSecrets: secretsIncluded ? [] : omitted,
    posts: posts.length,
    folders: folders.length,
    strike,
  })
  return {
    ok: true,
    plan: {
      kind: 'full',
      mode: 'replace',
      summary,
      posts,
      folders,
      strike,
      storage,
      secretsIncluded,
    },
  }
}

export function inspectBackup(raw: unknown): InspectResult {
  if (!isRecord(raw)) return { ok: false, error: 'bad-file' }
  if (raw.format === ACCOUNT_LIBRARY_FORMAT) return inspectAccountLibrary(raw)
  if (isLegacyBookmark(raw)) return inspectLegacy(raw)
  if (raw.format === FULL_BACKUP_FORMAT) return inspectFull(raw)
  if (isLedgerOnly(raw)) return { ok: false, error: 'ledger-only' }
  return { ok: false, error: 'bad-file' }
}

export function inspectBackupText(text: string): InspectResult {
  if (backupExceedsSizeLimit(text.length)) return { ok: false, error: 'too-large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'bad-json' }
  }
  return inspectBackup(raw)
}

/** Serialize for download. Large libraries stay compact so the file stays smaller. */
export function serializeBackup(file: FullBackupFile): string {
  const pretty = file.bookmarks.posts.length <= 5000
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file)
}
