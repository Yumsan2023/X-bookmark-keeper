import { useEffect, useRef } from 'react'
import css from '@/strike/options/options.css?inline'
import body from '@/strike/options/body.html?raw'
import { mountStrikeOptions } from '@/strike/options/mount.js'
import { useT } from '../i18n'

/** Full strike settings, hosted in the X Toolkit options page. Storage stays on xsl / xslSecret. */
export function StrikeLedgerView() {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>${css}</style>${body}`
    let cancelled = false
    void mountStrikeOptions(shadow).catch((error: unknown) => {
      if (cancelled) return
      const status = shadow.getElementById('status')
      if (status) status.textContent = error instanceof Error ? error.message : String(error)
    })
    return () => {
      cancelled = true
      shadow.innerHTML = ''
    }
  }, [])

  return (
    <div className="panel strike-panel">
      <h3>{t('tab_strike')}</h3>
      <p className="muted">{t('strike_popup_help')}</p>
      <div ref={hostRef} className="strike-host" />
    </div>
  )
}
