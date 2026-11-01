import { useEffect, useState } from 'react'
import { useAuthorMarks } from '../hooks'
import { useT } from '../i18n'

/** Writes the same xsl.settings fields as the Strike Ledger page. */
export function AuthorLinkSettings() {
  const t = useT()
  const marks = useAuthorMarks()
  const [draft, setDraft] = useState(marks.settings)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    setDraft(marks.settings)
  }, [marks.settings])

  const save = async () => {
    const threshold = Math.min(99, Math.max(1, Math.round(Number(draft.libraryChipThreshold) || 3)))
    const patch = {
      libraryChipFromStrikes: draft.libraryChipFromStrikes,
      libraryChipThreshold: threshold,
      bookmarkMarkAddsStrike: draft.bookmarkMarkAddsStrike,
    }
    setDraft({ ...draft, libraryChipThreshold: threshold })
    try {
      const result = (await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch })) as { ok?: boolean; error?: string }
      setMsg(result?.ok ? t('saved') : result?.error || t('error'))
    } catch (e) {
      setMsg((e as Error).message)
    }
    setTimeout(() => setMsg(''), 4000)
  }

  return (
    <section className="author-link-settings">
      <h3>{t('author_link_title')}</h3>
      <p className="muted">{t('author_link_help')}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.libraryChipFromStrikes}
          onChange={(e) => setDraft((d) => ({ ...d, libraryChipFromStrikes: e.target.checked }))}
        />{' '}
        {t('author_link_from_strikes')}
      </label>
      <label>
        {t('author_link_threshold')}
        <input
          type="number"
          min={1}
          max={99}
          value={draft.libraryChipThreshold}
          onChange={(e) => setDraft((d) => ({ ...d, libraryChipThreshold: Number(e.target.value) }))}
        />
      </label>
      <p className="muted">{t('author_link_threshold_hint')}</p>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.bookmarkMarkAddsStrike}
          onChange={(e) => setDraft((d) => ({ ...d, bookmarkMarkAddsStrike: e.target.checked }))}
        />{' '}
        {t('author_link_add_strike')}
      </label>
      <p className="muted">{t('author_link_add_strike_hint')}</p>
      <p className="muted">{t('author_link_search')}</p>
      <div className="row">
        <button type="button" className="primary" onClick={() => void save()}>
          {t('save')}
        </button>
        {msg && <span className="ok">{msg}</span>}
      </div>
    </section>
  )
}
