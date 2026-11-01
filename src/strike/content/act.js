/**
 * Mute and block go through X's own caret menu and confirm sheet.
 * This is brittle on purpose: if the menu is missing, the action fails and
 * the ledger queues a retry. There is no private GraphQL client here.
 */

import { findMenuItem } from "../lib/domparse.js";
import { matchMenuLabel, menuTestIds } from "../lib/pure.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function press(el) {
  const view = el.ownerDocument?.defaultView || window;
  const opts = { bubbles: true, cancelable: true, composed: true, view };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
}

async function waitFor(read, timeout = 1800) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = read();
    if (value) return value;
    await sleep(90);
  }
  return null;
}

function dismissMenus() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

export async function performPlatformAction(article, action) {
  dismissMenus();
  await sleep(160);
  const caret = article.querySelector('[data-testid="caret"]')
    || article.querySelector('button[aria-label="More"], button[aria-label="更多"]');
  if (!caret) throw new Error("no-caret");
  press(caret);
  const item = await waitFor(
    () => findMenuItem(document, action.type, action.handle, menuTestIds(action.type), matchMenuLabel),
    1800,
  );
  if (!item) {
    dismissMenus();
    throw new Error("no-item");
  }
  press(item);
  if (action.type === "mute" || action.type === "unmute") {
    await sleep(280);
    return;
  }
  const confirm = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 2200);
  if (!confirm) throw new Error("no-confirm");
  press(confirm);
  await sleep(320);
}
