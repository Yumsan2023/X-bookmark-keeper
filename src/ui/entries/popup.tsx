import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useLibrary, useSettings } from '../hooks'
import { I18nProvider, useT } from '../i18n'
import { DialogProvider } from '../components/Dialogs'
import { ProgressBox, SyncControls } from '../components/SyncView'
import '../styles.css'

function Popup({ themeClass }: { themeClass: string }) {
  const t = useT()
  const lib = useLibrary()
  return (
    <div className={`popup ${themeClass}`}>
      <h1>🔖 {t('app_title')}</h1>
      <p className="muted">{t('app_subtitle')}</p>
      <p className="muted">{t('total_in_library')} {lib.totalCount}</p>
      <SyncControls compact />
      <ProgressBox />
      <p className="muted">{t('strike_popup_help')}</p>
      <div className="row">
        <button className="primary" onClick={() => chrome.runtime.openOptionsPage()}>{t('open_library')}</button>
        <button onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#strike') })}>{t('tab_strike')}</button>
        <button onClick={async () => {
          const w = await chrome.windows.getCurrent()
          await chrome.sidePanel.open({ windowId: w.id! })
        }}>{t('open_side_panel')}</button>
      </div>
    </div>
  )
}

function Root() {
  const [s] = useSettings()
  const themeClass = s.theme === 'light' ? 'theme-x-light' : 'theme-x-dark'
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-x-dark', 'theme-x-light')
    root.classList.add(themeClass)
  }, [themeClass])
  return (
    <I18nProvider lang={s.lang}>
      <DialogProvider><Popup themeClass={themeClass} /></DialogProvider>
    </I18nProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Root />)
