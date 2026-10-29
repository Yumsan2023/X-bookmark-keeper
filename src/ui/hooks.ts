import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { countPosts, getPosts, listFolders, listFoldersWithoutCounts, listTags } from '@/db/posts'
import { countUnfiled } from '@/db/query'
import { SearchEngine } from '@/search/engine'
import { buildIndexBatched, searchPage, tryLoadPersistedIndex, type PagedSearchInput, type PagedSearchResult } from '@/search/service'
import { getAuth, getSettings, mergeSettings } from '@/shared/storage'
import { DEFAULT_SETTINGS, STORAGE_KEYS, type BgRequest, type BgResponse, type Folder, type Post, type Settings, type SyncProgress, type TaskProgress } from '@/shared/types'

export async function bg<T = unknown>(msg: BgRequest): Promise<BgResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as BgResponse<T>
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function useStorageKey<T>(key: string, initial: T | undefined, map?: (v: any) => T): T | undefined {
  const [val, setVal] = useState<T | undefined>(initial)
  useEffect(() => {
    let alive = true
    chrome.storage.local.get(key).then((r) => alive && setVal((map ? map(r[key]) : r[key]) as T | undefined))
    const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[key]) setVal((map ? map(changes[key].newValue) : changes[key].newValue) as T | undefined)
    }
    chrome.storage.onChanged.addListener(l)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(l)
    }
  }, [key])
  return val
}

export function useSettings(): [Settings, (s: Settings) => Promise<void>] {
  const s = useStorageKey<Settings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS, (v) => mergeSettings(v))
  const save = useCallback(async (next: Settings) => {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next })
  }, [])
  return [s ?? DEFAULT_SETTINGS, save]
}

export const useProgress = () => useStorageKey<SyncProgress | undefined>(STORAGE_KEYS.progress, undefined)
export const useTimelineProgress = () => useStorageKey<SyncProgress | undefined>(STORAGE_KEYS.timelineProgress, undefined)
export const useTask = () => useStorageKey<TaskProgress | undefined>(STORAGE_KEYS.task, undefined)
export const useAuthInfo = () => useStorageKey<{ captured_at: number } | undefined>(STORAGE_KEYS.auth, undefined)
export const useRate = () => useStorageKey<Record<string, any> | undefined>(STORAGE_KEYS.rate, undefined)

export interface Library {
  engine: SearchEngine
  /** @deprecated 大库不再全量载入; 保留空数组兼容旧调用, 请用 totalCount / search */
  posts: Post[]
  totalCount: number
  unfiledCount: number
  folders: (Folder & { count: number })[]
  tags: { tag: string; count: number }[]
  loading: boolean
  indexing: boolean
  indexProgress: number | null
  version: number
  reload: () => Promise<void>
  search: (input: PagedSearchInput) => Promise<PagedSearchResult>
  getPostsByIds: (ids: string[]) => Promise<Post[]>
}

/**
 * 打开 UI 时不 toArray 全库:
 * 1) 先加载 count / folders(名) / tags 名, loading=false 即可渲染
 * 2) 异步补 count; 后台加载或重建 MiniSearch (持久化优先, 否则分批)
 * 3) dbVersion 变化节流 4s 且同步中不反复全量重建
 */
export function useLibrary(): Library {
  const engineRef = useRef(new SearchEngine())
  const [state, setState] = useState({
    posts: [] as Post[],
    totalCount: 0,
    unfiledCount: 0,
    folders: [] as Library['folders'],
    tags: [] as Library['tags'],
    loading: true,
    indexing: false,
    indexProgress: null as number | null,
    version: 0,
  })
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const busy = useRef(false)
  const indexAbort = useRef({ aborted: false })
  const indexGen = useRef(0)

  const ensureIndex = useCallback(async () => {
    const gen = ++indexGen.current
    indexAbort.current.aborted = true
    indexAbort.current = { aborted: false }
    const signal = indexAbort.current
    const eng = engineRef.current

    const loaded = await tryLoadPersistedIndex(eng)
    if (signal.aborted || gen !== indexGen.current) return
    if (loaded) {
      setState((s) => ({ ...s, indexing: false, indexProgress: null, version: s.version + 1 }))
      return
    }

    setState((s) => ({ ...s, indexing: true, indexProgress: 0 }))
    await buildIndexBatched(
      eng,
      (done, total) => {
        if (signal.aborted || gen !== indexGen.current) return
        const pct = total ? Math.round((done / total) * 100) : 100
        setState((s) => ({ ...s, indexProgress: pct }))
      },
      signal,
    )
    if (signal.aborted || gen !== indexGen.current) return
    setState((s) => ({ ...s, indexing: false, indexProgress: null, version: s.version + 1 }))
  }, [])

  const reload = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      // 1) 轻量元数据 — 先出界面
      const [totalCount, folderNames] = await Promise.all([countPosts(), listFoldersWithoutCounts()])
      setState((s) => ({
        ...s,
        totalCount,
        folders: folderNames.map((f) => ({ ...f, count: s.folders.find((x) => x.name === f.name)?.count ?? 0 })),
        loading: false,
        version: s.version + 1,
      }))

      // 2) 异步补 count / tags / unfiled
      const [folders, tags, unfiledCount] = await Promise.all([listFolders(), listTags(), countUnfiled()])
      setState((s) => ({ ...s, folders, tags, unfiledCount, totalCount, version: s.version + 1 }))

      // 3) 后台索引 (不阻塞打开)
      void ensureIndex()
    } finally {
      busy.current = false
    }
  }, [ensureIndex])

  useEffect(() => {
    void reload()
    const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[STORAGE_KEYS.dbVersion]) {
        clearTimeout(timer.current)
        // 节流 4s; 同步狂刷 dbVersion 时不反复全量重建
        timer.current = setTimeout(() => {
          void (async () => {
            const totalCount = await countPosts()
            setState((s) => ({ ...s, totalCount, version: s.version + 1 }))
            // 文件夹/标签 count 轻量刷新; 索引延后重建
            const [folders, tags, unfiledCount] = await Promise.all([listFolders(), listTags(), countUnfiled()])
            setState((s) => ({ ...s, folders, tags, unfiledCount, version: s.version + 1 }))
            void ensureIndex()
          })()
        }, 4000)
      }
    }
    chrome.storage.onChanged.addListener(l)
    return () => {
      chrome.storage.onChanged.removeListener(l)
      indexAbort.current.aborted = true
      clearTimeout(timer.current)
    }
  }, [reload, ensureIndex])

  const search = useCallback(async (input: PagedSearchInput) => searchPage(engineRef.current, input), [])
  const getPostsByIds = useCallback(async (ids: string[]) => getPosts(ids), [])

  return useMemo(
    () => ({
      engine: engineRef.current,
      posts: state.posts,
      totalCount: state.totalCount,
      unfiledCount: state.unfiledCount,
      folders: state.folders,
      tags: state.tags,
      loading: state.loading,
      indexing: state.indexing,
      indexProgress: state.indexProgress,
      version: state.version,
      reload,
      search,
      getPostsByIds,
    }),
    [state, reload, search, getPostsByIds],
  )
}

export { getAuth, getSettings }
