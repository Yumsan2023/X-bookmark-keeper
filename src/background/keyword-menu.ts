import { dispatch as dispatchStrike } from '@/strike/lib/store.js'
import { keywordMenuPlan, resolveLang } from '@/strike/lib/pure.js'

const X_PAGES = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://mobile.x.com/*',
  'https://mobile.twitter.com/*',
]

let packSig = ''
let refreshing: Promise<void> = Promise.resolve()

function createMenu(props: chrome.contextMenus.CreateProperties) {
  return new Promise<void>((resolve, reject) => {
    chrome.contextMenus.create(props, () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve()
    })
  })
}

function removeMenus() {
  return new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

/** Rebuild the x.com selection menu when pack names change. Hit-log writes do not. */
export async function refreshKeywordMenus() {
  const run = refreshing.then(async () => {
    const got = await chrome.storage.local.get('xsl') as { xsl?: { settings?: { language?: string; keywordPacks?: unknown[] } } }
    const settings = got.xsl?.settings || {}
    const packs = Array.isArray(settings.keywordPacks) ? settings.keywordPacks : []
    const plan = keywordMenuPlan(packs, resolveLang(settings.language, navigator.language))
    const sig = JSON.stringify(plan)
    if (sig === packSig) return
    await removeMenus()
    await createMenu({
      id: 'xsl-add-keyword',
      title: plan.parentTitle,
      contexts: ['selection'],
      documentUrlPatterns: X_PAGES,
    })
    for (const item of plan.items) {
      await createMenu({
        id: item.id,
        parentId: 'xsl-add-keyword',
        title: item.title,
        contexts: ['selection'],
        documentUrlPatterns: X_PAGES,
      })
    }
    packSig = sig
  }).catch((error: unknown) => {
    packSig = ''
    console.error('[X Toolkit] keyword menu failed', error)
  })
  refreshing = run.then(() => {}, () => {})
  return run
}

export function installKeywordMenus() {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId || '')
    if (!id.startsWith('xsl-kw:')) return
    const packId = id.slice('xsl-kw:'.length)
    void dispatchStrike({
      type: 'ADD_KEYWORD',
      packId,
      value: info.selectionText || '',
      target: 'text',
    }, { internal: true }).then((result) => {
      const added = result as { ok?: boolean; duplicate?: boolean; value?: string; packName?: string; error?: string } | undefined
      if (!tab?.id) return
      void chrome.tabs.sendMessage(tab.id, {
        type: 'KEYWORD_RESULT',
        ok: !!added?.ok,
        duplicate: !!added?.duplicate,
        value: added?.value || '',
        packName: added?.packName || '',
        error: added?.error || '',
      }).catch(() => {})
    })
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.xsl) void refreshKeywordMenus()
  })
  chrome.runtime.onInstalled.addListener(() => { void refreshKeywordMenus() })
  chrome.runtime.onStartup.addListener(() => { void refreshKeywordMenus() })
  void refreshKeywordMenus()
}
