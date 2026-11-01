export function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (result) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(result || { ok: false, error: "empty" });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}
