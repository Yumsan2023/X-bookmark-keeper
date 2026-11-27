import { DialogProvider } from './components/Dialogs'
import { useSettings } from './hooks'
import { I18nProvider } from './i18n'
import { Workbench } from './v2/Workbench'

export function App({ mode }: { mode: 'full' | 'side' }) {
  const [settings] = useSettings()
  return (
    <I18nProvider lang={settings.lang}>
      <DialogProvider>
        <Workbench mode={mode} />
      </DialogProvider>
    </I18nProvider>
  )
}
