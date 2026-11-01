import { useEffect, useRef, useState, type DragEvent } from 'react'
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
import { StrikeLedgerView } from './components/StrikeLedgerView'
import { folderColor, readDraggedIds } from './components/AccountBadges'
import { moveToFolder } from '@/db/posts'
import type { Key } from './i18n'

type Tab = 'library' | 'search' | 'folders' | 'tags' | 'sync' | 'settings' | 'strike'

const FULL_NAV: { id: Tab; icon: string; label: Key }[] = [
  { id: 'library', icon: '📚', label: 'tab_library' },
  { id: 'search', icon: '🔍', label: 'tab_search' },
  { id: 'folders', icon: '📁', label: 'tab_folders' },
  { id: 'tags', icon: '🏷', label: 'tab_tags' },
  { id: 'sync', icon: '↻', label: 'tab_sync' },
  { id: 'settings', icon: '⚙', label: 'tab_settings' },
  { id: 'strike', icon: '⚑', label: 'tab_strike' },
]
const SIDE_NAV: { id: Tab; icon: string; label: Key }[] = [
  { id: 'library', icon: '📚', label: 'tab_library' },
  { id: 'search', icon: '🔍', label: 'tab_search' },
  { id: 'folders', icon: '📁', label: 'tab_folders' },
  { id: 'sync', icon: '↻', label: 'tab_sync' },
]

function Shell({ mode }: { mode: 'full' | 'side' }) {
  const t = useT()
  const lib = useLibrary()
  const [settings, save] = useSettings()
  const [tab, setTab] = useState<Tab>(mode === 'full' ? 'library' : 'search')
  const [preset, setPreset] = useState<SearchPreset>({ nonce: 0 })
  const [reportOpen, setReportOpen] = useState(false)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const [toast, setToast] = useState('')
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

  useEffect(() => {
    if (location.hash.replace('#', '') === 'strike') setTab('strike')
  }, [])

  const onDropFolder = async (folder: string, event: DragEvent) => {
    event.preventDefault()
    setDropFolder(null)
    const ids = readDraggedIds(event)
    if (!ids.length) return
    const target = folder === '__unfiled__' ? '' : folder
    await moveToFolder(ids, target)
    await lib.reload()
    setToast(`${ids.length} → ${target || t('unfiled')}`)
    setTimeout(() => setToast(''), 4000)
  }
  const theme = settings.theme === 'light' ? 'light' : 'dark'
  const themeClass = theme === 'light' ? 'theme-x-light' : 'theme-x-dark'

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-x-dark', 'theme-x-light')
    root.classList.add(themeClass)
  }, [themeClass])

  const nav = mode === 'full' ? FULL_NAV : SIDE_NAV
  const showFolders = mode === 'full' && (tab === 'library' || tab === 'search' || tab === 'folders')
  return (
    <div className={`app ${mode} ${themeClass} ${mode === 'full' ? 'with-sidebar' : ''}`}>
      {mode === 'full' ? (
        <aside className="sidebar" aria-label={t('app_title')}>
          <div className="sidebar-brand">
            <span className="sidebar-logo">🔖</span>
            <div>
              <div className="sidebar-title">{t('app_title')}</div>
              <div className="sidebar-ver muted">v0.7.2 · {t('app_subtitle')}</div>
            </div>
          </div>
          <nav className="sidebar-nav">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? 'sidebar-item active' : 'sidebar-item'}
                onClick={() => setTab(item.id)}
              >
                <span className="sidebar-icon" aria-hidden>
                  {item.icon}
                </span>
                <span>{t(item.label)}</span>
              </button>
            ))}
          </nav>
          {showFolders && (
            <div className="sidebar-folders">
              <div className="sidebar-section-label">{t('tab_folders')}</div>
              <button
                type="button"
                className={`sidebar-folder ${dropFolder === '__unfiled__' ? 'drop-over' : ''}`}
                title={t('drop_to_move')}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDropFolder('__unfiled__')
                }}
                onDragLeave={() => setDropFolder(null)}
                onDrop={(e) => void onDropFolder('__unfiled__', e)}
                onClick={() => open('folder:none')}
              >
                <span className="folder-dot" style={{ background: 'var(--muted)' }} />
                <span className="sidebar-folder-name">{t('unfiled')}</span>
                <span className="muted">{lib.unfiledCount}</span>
              </button>
              {lib.folders.map((folder) => (
                <button
                  key={folder.name}
                  type="button"
                  className={`sidebar-folder ${dropFolder === folder.name ? 'drop-over' : ''}`}
                  title={t('drop_to_move')}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropFolder(folder.name)
                  }}
                  onDragLeave={() => setDropFolder(null)}
                  onDrop={(e) => void onDropFolder(folder.name, e)}
                  onClick={() => open(/\s/.test(folder.name) ? `folder:"${folder.name}"` : `folder:${folder.name}`)}
                >
                  <span className="folder-dot" style={{ background: folderColor(folder.name) }} />
                  <span className="sidebar-folder-name">{folder.name}</span>
                  <span className="muted">{folder.count}</span>
                </button>
              ))}
            </div>
          )}
        </aside>
      ) : (
        <header className="topbar">
          <h1>🔖 {t('app_title')}</h1>
          <nav>
            {nav.map((item) => (
              <button key={item.id} type="button" className={tab === item.id ? 'tab active' : 'tab'} onClick={() => setTab(item.id)}>
                {t(item.label)}
              </button>
            ))}
          </nav>
          <button className="tab" onClick={() => chrome.runtime.openOptionsPage()}>
            ↗
          </button>
        </header>
      )}
      <div className="shell-main">
      {toast && <div className="info">{toast}</div>}
      {mode === 'side' && tab !== 'sync' && tab !== 'settings' && tab !== 'library' && (
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
        {tab === 'strike' && <StrikeLedgerView />}
      </main>
      </div>
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
