import { dispatch as dispatchStrike } from '@/strike/lib/store.js'
import { handlePartnershipStats } from './partnership'
import { installKeywordMenus } from './keyword-menu'
import { registerAuthCapture } from './auth-capture'
import { installDnrRules } from './dnr'
import { handleMessage, recoverInterrupted, startSync } from './messaging'
import type { BgRequest } from '@/shared/types'

function isStrikeMessage(msg: unknown): msg is { type: string } {
  const type = (msg as { type?: unknown } | null)?.type
  return typeof type === 'string' && /^[A-Z][A-Z0-9_]*$/.test(type)
}

// MV3: 所有事件监听必须在 service worker 顶层同步注册
registerAuthCapture()
installKeywordMenus()

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  // Read-only hover stats. Kept out of the strike dispatcher so it cannot mark or enqueue.
  if ((msg as { type?: string } | null)?.type === 'PARTNERSHIP_STATS') {
    void handlePartnershipStats(msg as { handle?: string }, sender).then(sendResponse)
    return true
  }
  if (isStrikeMessage(msg)) {
    void dispatchStrike(msg, sender).then(sendResponse)
    return true
  }
  void handleMessage(msg).then(sendResponse)
  return true // 异步响应
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bk-resume') void startSync('resume')
})

chrome.runtime.onInstalled.addListener(async () => {
  await installDnrRules()
  await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {})
})

chrome.runtime.onStartup.addListener(() => void installDnrRules())

void installDnrRules().catch(() => {})
void recoverInterrupted()
void dispatchStrike({ type: 'ENSURE' }, { internal: true }).catch((error: unknown) => {
  console.error('[X Toolkit] strike ledger init failed', error)
})
