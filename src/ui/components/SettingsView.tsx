import { useState } from 'react'
import { clearAll } from '@/db/posts'
import { applyUiFontSize, clampUiFontSize, UI_FONT_STEPS } from '@/shared/ui-font'
import type { Settings } from '@/shared/types'
import { useT } from '../i18n'
import type { Library } from '../hooks'
import { useDialogs } from './Dialogs'
import { AuthorLinkSettings } from './AuthorLinkSettings'
import { FullBackupPanel } from './FullBackupPanel'

const COMMON_LLM_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'] as const
const LLM_MODEL_CUSTOM = '__custom__'
const isCommonLlmModel = (m: string) => (COMMON_LLM_MODELS as readonly string[]).includes(m)

export function SettingsView({ settings, save, lib, onNotify }: { settings: Settings; save: (s: Settings) => Promise<void>; lib: Library; onNotify?: (message: string) => void }) {
  const t = useT()
  const { confirm } = useDialogs()
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState('')
  const [modelCustom, setModelCustom] = useState(() => !isCommonLlmModel(settings.llm.model))
  const up = (patch: Partial<Settings>) => setS((c) => ({ ...c, ...patch }))
  const upLlm = (patch: Partial<Settings['llm']>) => setS((c) => ({ ...c, llm: { ...c.llm, ...patch } }))
  const num = (v: string, d: number) => (Number.isFinite(+v) && v !== '' ? +v : d)
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000) }

  const doSave = async () => {
    // 申请 LLM 接口域名的可选权限 (需用户手势, 此处在点击回调中)
    if (s.llm.endpoint.trim()) {
      try {
        const origin = new URL(s.llm.endpoint).origin + '/*'
        if (!(await chrome.permissions.contains({ origins: [origin] }))) await chrome.permissions.request({ origins: [origin] })
      } catch { /* 无效 URL 交给后续报错 */ }
    }
    const fixed = {
      ...s,
      delayMaxSec: Math.max(s.delayMinSec, s.delayMaxSec),
      pageSize: Math.min(100, Math.max(10, s.pageSize)),
      exportBatchSize: Math.min(10000, Math.max(100, s.exportBatchSize || 1000)),
    }
    setS(fixed)
    await save(fixed)
    flash(t('saved'))
  }

  const check = (k: 'syncFolders' | 'detectDeleted' | 'fetchThreads' | 'pushFolderMoveToX' | 'confirmBulkDelete', label: Parameters<typeof t>[0]) => (
    <label className="check"><input type="checkbox" checked={s[k]} onChange={(e) => up({ [k]: e.target.checked })} /> {t(label)}</label>
  )

  return (
    <div className="panel settings">
      <h3>{t('settings_sync')}</h3>
      <label>{t('language')}
        <select value={s.lang} onChange={(e) => up({ lang: e.target.value as Settings['lang'] })}>
          <option value="zh">中文</option><option value="en">English</option>
        </select>
      </label>
      <label>{t('theme')}
        <select
          value={s.theme === 'light' ? 'light' : 'dark'}
          onChange={async (e) => {
            const theme = e.target.value as Settings['theme']
            const next = { ...s, theme }
            setS(next)
            await save(next)
          }}
        >
          <option value="dark">{t('theme_dark')}</option>
          <option value="light">{t('theme_light')}</option>
        </select>
      </label>
      <label>
        {t('font_size')}
        <span className="font-size-row">
          <input
            type="range"
            min={0}
            max={UI_FONT_STEPS.length - 1}
            step={1}
            aria-valuemin={UI_FONT_STEPS[0]}
            aria-valuemax={UI_FONT_STEPS[UI_FONT_STEPS.length - 1]}
            aria-valuenow={clampUiFontSize(s.uiFontSize)}
            aria-label={t('font_size')}
            value={Math.max(0, UI_FONT_STEPS.indexOf(clampUiFontSize(s.uiFontSize) as (typeof UI_FONT_STEPS)[number]))}
            onInput={(e) => {
              const uiFontSize = UI_FONT_STEPS[Number(e.currentTarget.value)] ?? clampUiFontSize(s.uiFontSize)
              setS((cur) => ({ ...cur, uiFontSize }))
              applyUiFontSize(uiFontSize)
            }}
            onChange={async (e) => {
              const uiFontSize = UI_FONT_STEPS[Number(e.currentTarget.value)] ?? clampUiFontSize(s.uiFontSize)
              const next = { ...s, uiFontSize }
              setS(next)
              applyUiFontSize(uiFontSize)
              await save(next)
            }}
          />
          <span className="font-size-value">{clampUiFontSize(s.uiFontSize)} px</span>
        </span>
      </label>
      <p className="muted">{t('font_size_hint')}</p>
      {check('syncFolders', 'opt_sync_folders')}
      {check('detectDeleted', 'opt_detect_deleted')}
      {check('fetchThreads', 'opt_fetch_threads')}
      {check('pushFolderMoveToX', 'opt_push_folder')}
      {check('confirmBulkDelete', 'opt_confirm_delete')}
      <div className="grid3">
        <label>{t('delay_min')}<input type="number" min={0} step={0.5} value={s.delayMinSec} onChange={(e) => up({ delayMinSec: num(e.target.value, 1) })} /></label>
        <label>{t('delay_max')}<input type="number" min={0} step={0.5} value={s.delayMaxSec} onChange={(e) => up({ delayMaxSec: num(e.target.value, 3) })} /></label>
        <label>{t('page_size')}<input type="number" min={10} max={100} value={s.pageSize} onChange={(e) => up({ pageSize: num(e.target.value, 100) })} /></label>
      </div>
      <label>{t('batch_size_export')}<input type="number" min={100} max={10000} step={100} value={s.exportBatchSize ?? 1000} onChange={(e) => up({ exportBatchSize: num(e.target.value, 1000) })} /></label>
      <p className="muted">{t('batch_size_export_hint')}</p>

      <AuthorLinkSettings />

      <h3>{t('llm')}</h3>
      <p className="muted">{t('llm_hint')}</p>
      <label>{t('endpoint')}<input value={s.llm.endpoint} placeholder="http://127.0.0.1:11434/v1" onChange={(e) => upLlm({ endpoint: e.target.value })} /></label>
      <label>{t('api_key')}<input type="password" autoComplete="off" value={s.llm.apiKey} placeholder={t('api_key_optional')} onChange={(e) => upLlm({ apiKey: e.target.value })} /></label>
      <label>{t('model')}
        <select
          value={modelCustom ? LLM_MODEL_CUSTOM : s.llm.model}
          onChange={(e) => {
            const v = e.target.value
            if (v === LLM_MODEL_CUSTOM) {
              setModelCustom(true)
              return
            }
            setModelCustom(false)
            upLlm({ model: v })
          }}
        >
          {COMMON_LLM_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          <option value={LLM_MODEL_CUSTOM}>{t('model_custom')}</option>
        </select>
      </label>
      {modelCustom && (
        <label>{t('model_custom_id')}
          <input
            value={s.llm.model}
            onChange={(e) => upLlm({ model: e.target.value })}
            placeholder="qwen2.5:7b"
          />
        </label>
      )}
      <div className="grid3">
        <label>{t('batch_size')}<input type="number" min={1} max={100} value={s.llm.batchSize} onChange={(e) => upLlm({ batchSize: num(e.target.value, 20) })} /></label>
        <label>{t('interval_ms')}<input type="number" min={0} step={500} value={s.llm.intervalMs} onChange={(e) => upLlm({ intervalMs: num(e.target.value, 2000) })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={s.llm.allowNewTags !== false} onChange={(e) => upLlm({ allowNewTags: e.target.checked })} /> {t('allow_new_tags')}</label>
      <div className="row"><button className="primary" onClick={doSave}>{t('save')}</button>{msg && <span className="ok">{msg}</span>}</div>

      <h3>{t('data')}</h3>
      <p className="muted">{t('full_backup_replaces_old')}</p>
      <FullBackupPanel onNotify={onNotify} onLibraryChange={() => void lib.reload()} />
      <div className="row wrap">
        <button className="danger" onClick={async () => { if (await confirm(t('confirm_clear'))) { await clearAll(); await lib.reload() } }}>{t('clear_data')}</button>
      </div>
    </div>
  )
}
