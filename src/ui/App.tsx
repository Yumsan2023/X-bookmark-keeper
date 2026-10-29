import { useState } from 'react'
import { useLibrary, useSettings } from './hooks'
import { I18nProvider, useT } from './i18n'
import { DialogProvider } from './components/Dialogs'
import { FoldersView, TagsView } from './components/FoldersView'
import { SearchView, type SearchPreset } from './components/SearchView'
import { SettingsView } from './components/SettingsView'
import { ProgressBox, SyncControls, SyncView, TaskBox } from './components/SyncView'

type Tab = 'search' | 'folders' | 'tags' | 'sync' | 'settings'

function Shell({ mode }: { mode: 'full' | 'side' }) {
  const t = useT()
  const lib = useLibrary()
  const [settings, save] = useSettings()
  const [tab, setTab] = useState<Tab>('search')
  const [preset, setPreset] = useState<SearchPreset>({ nonce: 0 })
  const open = (query: string) => {
    setPreset({ query, nonce: Date.now() })
    setTab('search')
  }
  const tabs: Tab[] = mode === 'full' ? ['search', 'folders', 'tags', 'sync', 'settings'] : ['search', 'folders', 'sync']
  return (
    <div className={`app ${mode}`}>
      <header className="topbar">
        <h1>🔖 {mode === 'full' ? t('app_title') : 'Bookmark Keeper'}</h1>
        <nav>
          {tabs.map((k) => (
            <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{t(`tab_${k}` as any)}</button>
          ))}
        </nav>
        {mode === 'side' && <button className="tab" onClick={() => chrome.runtime.openOptionsPage()}>↗</button>}
      </header>
      {tab !== 'sync' && tab !== 'settings' && (
        <div className="mini-sync">
          <SyncControls compact />
          <ProgressBox />
          <TaskBox />
        </div>
      )}
      <main>
        <div hidden={tab !== 'search'}><SearchView lib={lib} settings={settings} compact={mode === 'side'} preset={preset} /></div>
        {tab === 'folders' && <FoldersView lib={lib} onOpen={open} />}
        {tab === 'tags' && <TagsView lib={lib} onOpen={open} />}
        {tab === 'sync' && <SyncView />}
        {tab === 'settings' && <SettingsView key={JSON.stringify(settings)} settings={settings} save={save} lib={lib} />}
      </main>
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
