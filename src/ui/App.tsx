import { useEffect, useRef, useState } from 'react'
import { STORAGE_KEYS, type LastFullSyncMeta } from '@/shared/types'
import { useLibrary, useProgress, useSettings } from './hooks'
import { I18nProvider, useT } from './i18n'
import { DialogProvider } from './components/Dialogs'
import { FoldersView, TagsView } from './components/FoldersView'
import { LibraryView } from './components/library/LibraryView'
import { SearchView, type SearchPreset } from './components/SearchView'
import { SettingsView } from './components/SettingsView'
import { ProgressBox, SyncControls, SyncView, TaskBox } from './components/SyncView'
import { SyncReportView } from './components/SyncReportView'

type Tab = 'library' | 'search' | 'folders' | 'tags' | 'sync' | 'settings'

function Shell({ mode }: { mode: 'full' | 'side' }) {
  const t = useT()
  const lib = useLibrary()
  const [settings, save] = useSettings()
  const [tab, setTab] = useState<Tab>(mode === 'full' ? 'library' : 'search')
  const [preset, setPreset] = useState<SearchPreset>({ nonce: 0 })
  const [reportOpen, setReportOpen] = useState(false)
  const progress = useProgress()
  const prevStatus = useRef<string | undefined>()

  // Open report if a full sync finished while this UI was closed (pending flag)
  useEffect(() => {
    let alive = true
    void chrome.storage.local.get(STORAGE_KEYS.lastFullSync).then((r) => {
      const meta = r[STORAGE_KEYS.lastFullSync] as LastFullSyncMeta | undefined
      if (!alive || !meta?.pendingReport) return
      setReportOpen(true)
      void chrome.storage.local.set({
        [STORAGE_KEYS.lastFullSync]: { ...meta, pendingReport: false },
      })
    })
    return () => {
      alive = false
    }
  }, [])

  // After a successful full bookmark sync, open the report automatically
  useEffect(() => {
    const prev = prevStatus.current
    const cur = progress?.status
    prevStatus.current = cur
    if (
      prev &&
      prev !== 'done' &&
      cur === 'done' &&
      progress?.mode === 'full' &&
      (progress.kind === 'bookmark' || !progress.kind)
    ) {
      setReportOpen(true)
      void chrome.storage.local.get(STORAGE_KEYS.lastFullSync).then((r) => {
        const meta = r[STORAGE_KEYS.lastFullSync] as LastFullSyncMeta | undefined
        if (meta?.pendingReport) {
          void chrome.storage.local.set({
            [STORAGE_KEYS.lastFullSync]: { ...meta, pendingReport: false },
          })
        }
      })
    }
  }, [progress?.status, progress?.mode, progress?.kind])

  const open = (query: string) => {
    setPreset({ query, nonce: Date.now() })
    setTab('search')
  }
  const openAuthor = (screenName: string) => {
    open(`from:${screenName.replace(/^@/, '')}`)
  }
  const theme = settings.theme === 'light' ? 'light' : 'dark'
  const themeClass = theme === 'light' ? 'theme-x-light' : 'theme-x-dark'

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-x-dark', 'theme-x-light')
    root.classList.add(themeClass)
  }, [themeClass])

  const tabs: Tab[] =
    mode === 'full'
      ? ['library', 'search', 'folders', 'tags', 'sync', 'settings']
      : ['library', 'search', 'folders', 'sync']
  return (
    <div className={`app ${mode} ${themeClass}`}>
      <header className="topbar">
        <h1>🔖 {mode === 'full' ? t('app_title') : 'Bookmark Keeper'}</h1>
        <nav>
          {tabs.map((k) => (
            <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
              {t(`tab_${k}` as any)}
            </button>
          ))}
        </nav>
        {mode === 'side' && (
          <button className="tab" onClick={() => chrome.runtime.openOptionsPage()}>
            ↗
          </button>
        )}
      </header>
      {tab !== 'sync' && tab !== 'settings' && tab !== 'library' && (
        <div className="mini-sync">
          <SyncControls compact />
          <ProgressBox />
          <TaskBox />
        </div>
      )}
      <main className={tab === 'library' ? 'main-library' : undefined}>
        <div hidden={tab !== 'library'}>
          <LibraryView lib={lib} settings={settings} save={save} onSync={() => setTab('sync')} />
        </div>
        <div hidden={tab !== 'search'}>
          <SearchView lib={lib} settings={settings} compact={mode === 'side'} preset={preset} />
        </div>
        {tab === 'folders' && <FoldersView lib={lib} onOpen={open} />}
        {tab === 'tags' && <TagsView lib={lib} onOpen={open} />}
        {tab === 'sync' && <SyncView onOpenReport={() => setReportOpen(true)} />}
        {tab === 'settings' && (
          <SettingsView key={JSON.stringify(settings)} settings={settings} save={save} lib={lib} />
        )}
      </main>
      <SyncReportView
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        onViewAuthor={openAuthor}
        syncedInRun={
          progress?.status === 'done' && progress.mode === 'full' ? progress.fetched : undefined
        }
        lastSyncAt={
          progress?.status === 'done' && progress.mode === 'full' ? progress.updated_at : undefined
        }
      />
    </div>
  )
}

export function App({ mode }: { mode: 'full' | 'side' }) {
  const [settings] = useSettings()
  return (
    <I18nProvider lang={settings.lang}>
      <DialogProvider>
        <Shell mode={mode} />
      </DialogProvider>
    </I18nProvider>
  )
}
