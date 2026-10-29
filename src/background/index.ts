import { registerAuthCapture } from './auth-capture'
import { installDnrRules } from './dnr'
import { handleMessage, recoverInterrupted, startSync } from './messaging'
import type { BgRequest } from '@/shared/types'

// MV3: 所有事件监听必须在 service worker 顶层同步注册
registerAuthCapture()

chrome.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
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
