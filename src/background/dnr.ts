/**
 * 扩展自己的 fetch 带的 Origin 是 chrome-extension://…, X 可能因此拒绝。
 * 用 declarativeNetRequest 仅对"扩展发起 → x.com/i/api/*"的请求把 Origin/Referer 改成 https://x.com。
 */
const RULE_ID = 1001

export async function installDnrRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://x.com' },
            { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://x.com/i/bookmarks' },
          ],
        },
        condition: {
          urlFilter: '||x.com/i/api/',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, chrome.declarativeNetRequest.ResourceType.OTHER],
        },
      },
    ],
  })
}
