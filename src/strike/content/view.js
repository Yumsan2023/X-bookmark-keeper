const shadows = new WeakMap();

function shadowFor(host) {
  let shadow = shadows.get(host);
  if (shadow) return shadow;
  shadow = host.attachShadow({ mode: "closed" });
  shadows.set(host, shadow);
  for (const type of ["click", "pointerdown", "mousedown", "mouseup", "keydown"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  return shadow;
}

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = !!value;
    else if (key === "disabled") node.disabled = !!value;
    else if (key === "value") node.value = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const kid of [].concat(kids)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const BAR_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
.bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  color: #e7e9ea; font-size: 12px; line-height: 1.2;
}
button, .chip {
  border: 0; cursor: pointer; border-radius: 999px; padding: 4px 9px;
  background: transparent; color: #e7e9ea; font: inherit;
  border: 1px solid rgba(255,255,255,.16);
}
button:hover, .chip:hover { background: rgba(255,255,255,.08); }
button:focus-visible { outline: 2px solid #e85d04; outline-offset: 1px; }
.mark { color: #ffb088; border-color: rgba(232,93,4,.55); }
.badge { border-radius: 999px; padding: 3px 8px; font-weight: 650; }
.spam { color: #ffd5d8; background: rgba(244,33,46,.18); border: 1px solid rgba(244,33,46,.35); }
.marketing { color: #d2e9ff; background: rgba(29,155,240,.16); border: 1px solid rgba(29,155,240,.35); }
.custom { color: #efe7da; background: rgba(243,234,215,.08); border: 1px solid rgba(243,234,215,.2); }
.suspect { color: #3a2d05; background: #f0c94d; border-color: #f0c94d; font-weight: 700; }
.ai { color: #d7c4ff; border-color: rgba(168,130,255,.5); }
.quiet { color: #8b98a5; border-color: transparent; padding-left: 2px; padding-right: 2px; cursor: default; }
.on { box-shadow: inset 0 0 0 1px #e85d04; }
`;

const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
.backdrop {
  pointer-events: auto; position: fixed; inset: 0;
  background: rgba(0,0,0,.45); display: flex; align-items: flex-end; justify-content: center;
  padding: 16px;
}
.sheet, .toast {
  width: min(440px, 100%); background: #16181c; color: #e7e9ea;
  border: 1px solid rgba(255,255,255,.12); border-radius: 16px;
  box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 16px;
}
.toast {
  pointer-events: none; position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  width: max-content; max-width: min(440px, calc(100% - 24px));
  background: #1d130c; border-color: rgba(232,93,4,.45); font-size: 13px;
}
h2 { margin: 0 0 8px; font-size: 16px; font-weight: 680; }
p { margin: 0 0 12px; color: #c4cdd6; font-size: 13px; line-height: 1.45; }
.warn { color: #f0c94d; }
label { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; font-size: 13px; }
label small { display: block; color: #8b98a5; font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 12px; }
button, .tag {
  border-radius: 999px; border: 1px solid rgba(255,255,255,.16); background: transparent;
  color: #e7e9ea; padding: 7px 12px; font: inherit; cursor: pointer;
}
.primary { background: #e85d04; border-color: #e85d04; color: #1a1008; font-weight: 700; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.tag.on { background: rgba(232,93,4,.18); border-color: #e85d04; }
.tag small { color: #8b98a5; margin-left: 4px; }
form { display: flex; gap: 8px; margin-top: 8px; }
input[type="text"] {
  flex: 1; border-radius: 999px; border: 1px solid rgba(255,255,255,.16);
  background: #0f1419; color: #e7e9ea; padding: 7px 12px; font: inherit;
}
.check { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; }
@media (min-width: 720px) {
  .backdrop { align-items: center; }
}
`;

export function createOverlay() {
  let host = document.querySelector("[data-xsl-overlay]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.xslOverlay = "1";
    document.documentElement.append(host);
  }
  const shadow = shadowFor(host);
  if (!shadow.querySelector("style")) shadow.append(el("style", { text: OVERLAY_CSS }));
  return shadow;
}

export function mountBar(host, model, handlers) {
  const shadow = shadowFor(host);
  const signature = JSON.stringify(model.signature);
  if (host.dataset.xslSig === signature && shadow.childElementCount) return;
  host.dataset.xslSig = signature;
  const bar = el("div", { class: "bar" });
  bar.append(el("button", {
    class: "mark",
    type: "button",
    text: model.markLabel,
    title: model.shortcutTitle,
    onClick: (event) => {
      event.preventDefault();
      handlers.onPicker();
    },
  }));
  for (const badge of model.badges) {
    bar.append(el("span", { class: `badge ${badge.tone}`, text: badge.text, title: badge.title }));
  }
  if (model.followed) bar.append(el("span", { class: "quiet", text: model.followed }));
  if (model.whitelist) bar.append(el("span", { class: "quiet", text: model.whitelist }));
  if (model.suspect) {
    bar.append(el("button", {
      class: "chip suspect",
      type: "button",
      text: model.suspect.label,
      title: model.suspect.title,
      onClick: (event) => {
        event.preventDefault();
        handlers.onSuspect();
      },
    }));
  }
  if (model.ai) {
    bar.append(el("button", {
      class: "chip ai",
      type: "button",
      text: model.ai.label,
      title: model.ai.title,
      onClick: (event) => {
        event.preventDefault();
        handlers.onAi();
      },
    }));
  } else if (model.askAi) {
    bar.append(el("button", {
      class: "chip ai",
      type: "button",
      text: model.askAi,
      onClick: (event) => {
        event.preventDefault();
        handlers.onAsk();
      },
    }));
  }
  shadow.replaceChildren(el("style", { text: BAR_CSS }), bar);
}

let closeCurrent = null;

function openSheet(shadow, build) {
  closeCurrent?.(null);
  const backdrop = el("div", { class: "backdrop", role: "presentation" });
  const sheet = el("div", { class: "sheet", role: "dialog" });
  backdrop.append(sheet);
  shadow.append(backdrop);
  return new Promise((resolve) => {
    const finish = (value) => {
      closeCurrent = null;
      backdrop.remove();
      resolve(value);
    };
    closeCurrent = finish;
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish(null);
    });
    sheet.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    });
    build(sheet, finish);
    const focus = sheet.querySelector("button, input");
    focus?.focus();
  });
}

export function openPicker(shadow, model) {
  return openSheet(shadow, (sheet, finish) => {
    sheet.append(el("h2", { text: model.title }));
    if (model.subtitle) sheet.append(el("p", { text: model.subtitle }));
    const tags = el("div", { class: "tags" });
    for (const tag of model.tags) {
      tags.append(el("button", {
        class: `tag${tag.on ? " on" : ""}`,
        type: "button",
        title: tag.title || "",
        onClick: () => finish({ type: "toggle", tag: tag.name }),
      }, [tag.label, tag.count ? el("small", { text: String(tag.count) }) : null]));
    }
    sheet.append(tags);
    const form = el("form");
    const input = el("input", { type: "text", maxlength: "24", placeholder: model.placeholder, "aria-label": model.placeholder });
    form.append(input, el("button", { class: "primary", type: "submit", text: model.add }));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name) finish({ type: "add", name });
    });
    sheet.append(form);
    sheet.append(el("label", { class: "check" }, [
      el("input", {
        type: "checkbox",
        checked: model.whitelist,
        onChange: (event) => finish({ type: "whitelist", value: event.target.checked }),
      }),
      model.whitelistLabel,
    ]));
    if (model.queueMute || model.queueBlock) {
      sheet.append(el("div", { class: "row" }, [
        model.queueMute ? el("button", { type: "button", text: model.queueMute, onClick: () => finish({ type: "queue", action: "mute" }) }) : null,
        model.queueBlock ? el("button", { type: "button", text: model.queueBlock, onClick: () => finish({ type: "queue", action: "block" }) }) : null,
      ]));
    }
    sheet.append(el("div", { class: "row" }, [
      el("button", { type: "button", text: model.hideLabel, onClick: () => finish({ type: "hide", hidden: !model.hidden }) }),
      el("button", { type: "button", text: model.cancel, onClick: () => finish(null) }),
    ]));
  });
}

export function openChoice(shadow, model) {
  return openSheet(shadow, (sheet, finish) => {
    sheet.append(el("h2", { text: model.title }));
    sheet.append(el("p", { text: model.body }));
    if (model.warning) sheet.append(el("p", { class: "warn", text: model.warning }));
    const inputs = {};
    for (const check of model.checks || []) {
      const input = el("input", { type: "checkbox", checked: check.checked, disabled: check.disabled });
      inputs[check.id] = input;
      sheet.append(el("label", {}, [input, el("span", {}, [check.label, check.hint ? el("small", { text: check.hint }) : null])]));
    }
    sheet.append(el("div", { class: "row" }, [
      el("button", { type: "button", text: model.cancel, onClick: () => finish(null) }),
      model.neutral ? el("button", { type: "button", text: model.neutral, onClick: () => finish({ confirm: false }) }) : null,
      el("button", {
        class: "primary",
        type: "button",
        text: model.confirm,
        onClick: () => {
          const checks = {};
          for (const [id, input] of Object.entries(inputs)) checks[id] = input.checked && !input.disabled;
          finish({ confirm: true, checks });
        },
      }),
    ]));
  });
}

export function toast(shadow, text) {
  if (!shadow) return;
  let node = shadow.querySelector(".toast");
  if (!node) {
    node = el("div", { class: "toast", role: "status" });
    shadow.append(node);
  }
  node.textContent = text || "";
  node.hidden = !text;
  clearTimeout(node._timer);
  if (text) node._timer = setTimeout(() => { node.hidden = true; }, 3400);
}
