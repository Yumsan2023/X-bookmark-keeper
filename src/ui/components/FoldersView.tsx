import { createLocalFolder, deleteFolder, deleteTag, renameFolder, renameTag } from '@/db/posts'
import { useT } from '../i18n'
import type { Library } from '../hooks'
import { useDialogs } from './Dialogs'

export function FoldersView({ lib, onOpen }: { lib: Library; onOpen: (query: string) => void }) {
  const t = useT()
  const { ask, confirm } = useDialogs()
  const q = (n: string) => (/\s/.test(n) ? `folder:"${n}"` : `folder:${n}`)
  const unfiled = lib.unfiledCount
  return (
    <div className="panel">
      <div className="row">
        <h3>{t('tab_folders')}</h3>
        <button className="primary" onClick={async () => {
          const n = await ask(t('new_folder_prompt'))
          if (n?.trim()) { await createLocalFolder(n); await lib.reload() }
        }}>＋ {t('create_folder')}</button>
      </div>
      <table className="table">
        <tbody>
          <tr>
            <td>📂 {t('unfiled')}</td><td /><td>{unfiled}</td>
            <td><button onClick={() => onOpen('folder:none')}>{t('tab_search')}</button></td>
          </tr>
          {lib.folders.map((f) => (
            <tr key={f.name}>
              <td>📁 {f.name}</td>
              <td className="muted">{f.source === 'x' ? t('source_x') : t('source_local')}</td>
              <td>{f.count}</td>
              <td className="row">
                <button onClick={() => onOpen(q(f.name))}>{t('tab_search')}</button>
                <button onClick={async () => {
                  const n = await ask(t('rename'), f.name)
                  if (n && n.trim() !== f.name) {
                    try { await renameFolder(f.name, n) } catch (e) { alert((e as Error).message) }
                    await lib.reload()
                  }
                }}>{t('rename')}</button>
                <button className="danger" onClick={async () => { if (await confirm(t('confirm_delete_folder'))) { await deleteFolder(f.name); await lib.reload() } }}>{t('delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TagsView({ lib, onOpen }: { lib: Library; onOpen: (query: string) => void }) {
  const t = useT()
  const { ask, confirm } = useDialogs()
  return (
    <div className="panel">
      <h3>{t('tab_tags')}</h3>
      <table className="table">
        <tbody>
          {lib.tags.map((x) => (
            <tr key={x.tag}>
              <td>#{x.tag}</td>
              <td>{x.count}</td>
              <td className="row">
                <button onClick={() => onOpen(`tag:${x.tag}`)}>{t('tab_search')}</button>
                <button onClick={async () => {
                  const n = await ask(t('rename_tag_prompt'), x.tag)
                  if (n && n !== x.tag) { await renameTag(x.tag, n); await lib.reload() }
                }}>{t('rename')}</button>
                <button className="danger" onClick={async () => { if (await confirm(t('confirm_delete_tag'))) { await deleteTag(x.tag); await lib.reload() } }}>{t('delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
