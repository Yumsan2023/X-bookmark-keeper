import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'

type Req =
  | { kind: 'ask'; label: string; def: string; list?: string[]; resolve: (v: string | null) => void }
  | { kind: 'confirm'; label: string; resolve: (v: boolean) => void }

interface Api {
  ask: (label: string, def?: string, suggestions?: string[]) => Promise<string | null>
  confirm: (label: string) => Promise<boolean>
}
const Ctx = createContext<Api>({ ask: async () => null, confirm: async () => false })
export const useDialogs = () => useContext(Ctx)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Req | null>(null)
  const [val, setVal] = useState('')
  const t = useT()
  const input = useRef<HTMLInputElement>(null)

  const ask = useCallback((label: string, def = '', list?: string[]) => new Promise<string | null>((resolve) => {
    setVal(def)
    setReq({ kind: 'ask', label, def, list, resolve })
    setTimeout(() => input.current?.focus(), 30)
  }), [])
  const confirm = useCallback((label: string) => new Promise<boolean>((resolve) => setReq({ kind: 'confirm', label, resolve })), [])

  const close = (v: string | boolean | null) => {
    if (!req) return
    if (req.kind === 'ask') req.resolve(v as string | null)
    else req.resolve(v === true)
    setReq(null)
  }

  return (
    <Ctx.Provider value={{ ask, confirm }}>
      {children}
      {req && (
        <div className="modal-bg" onClick={() => close(req.kind === 'ask' ? null : false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p>{req.label}</p>
            {req.kind === 'ask' && (
              <>
                <input
                  ref={input}
                  list="dlg-list"
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && close(val)}
                />
                <datalist id="dlg-list">{req.list?.map((s) => <option key={s} value={s} />)}</datalist>
              </>
            )}
            <div className="row end">
              <button onClick={() => close(req.kind === 'ask' ? null : false)}>{t('cancel')}</button>
              <button className="primary" onClick={() => close(req.kind === 'ask' ? val : true)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
