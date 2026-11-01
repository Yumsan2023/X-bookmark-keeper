const shadows = new WeakMap();

function shadowFor(host, options = {}) {
  if (!host || host.nodeType !== 1) return null;
  let shadow = shadows.get(host);
  if (shadow) return shadow;
  try {
    shadow = host.attachShadow({ mode: "closed" });
  } catch {
    return null;
  }
  shadows.set(host, shadow);
  const guardClick = options.guardClick === true;
  for (const type of ["click", "pointerdown", "mousedown", "mouseup", "keydown"]) {
    host.addEventListener(type, (event) => {
      event.stopPropagation();
      if (guardClick && type === "click") event.preventDefault();
    });
  }
  return shadow;
}

/** A redraw or extension reload can leave a host whose closed shadow we no longer own. */
function replaceHost(host) {
  const next = document.createElement(host.tagName.toLowerCase() || "div");
  if (host.dataset.xslHost) next.dataset.xslHost = host.dataset.xslHost;
  if (host.dataset.xslName) next.dataset.xslName = host.dataset.xslName;
  if (host.dataset.xslOverlay) next.dataset.xslOverlay = host.dataset.xslOverlay;
  if (host.dataset.xslKeep) next.dataset.xslKeep = host.dataset.xslKeep;
  if (host.parentNode) host.replaceWith(next);
  return next;
}

function ensureShadow(host, options) {
  const shadow = shadowFor(host, options);
  if (shadow || !host?.parentNode) return { host, shadow };
  const next = replaceHost(host);
  return { host: next, shadow: shadowFor(next, options) };
}

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = !!value;
    else if (key === "selected") node.selected = !!value;
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
.protect {
  color: #d8ffe8; background: rgba(0,186,124,.18); border: 1px solid rgba(0,186,124,.55);
  font-weight: 700; cursor: default;
}
.tagchip { padding: 2px 7px; font-weight: 650; }
.tagchip.more { color: #c4cdd6; background: transparent; }
.bar.inline { gap: 4px; }
.bar.inline .badge, .bar.inline .tagchip { padding: 1px 6px; font-size: 11px; }
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
.safe { color: #8ee0b0; }
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
input[type="text"], select {
  flex: 1; border-radius: 999px; border: 1px solid rgba(255,255,255,.16);
  background: #0f1419; color: #e7e9ea; padding: 7px 12px; font: inherit;
}
.kw { display: grid; gap: 8px; margin: 4px 0 8px; }
.kw .row { margin-top: 0; }
.check { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; }
.rules { display: grid; gap: 6px; margin: 8px 0; max-height: 180px; overflow: auto; }
.rules label { margin: 0; }
.sheet > select { width: 100%; margin-bottom: 4px; }
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
  let shadow = shadowFor(host);
  if (!shadow) {
    host.remove();
    host = document.createElement("div");
    host.dataset.xslOverlay = "1";
    document.documentElement.append(host);
    shadow = shadowFor(host);
  }
  if (!shadow) return null;
  if (!shadow.querySelector("style")) shadow.append(el("style", { text: OVERLAY_CSS }));
  return shadow;
}

function paintChips(bar, model, handlers) {
  if (model.protect) {
    bar.append(el("span", {
      class: "badge protect",
      text: model.protect.text,
      title: model.protect.title || "",
    }));
  }
  for (const chip of model.chips || []) {
    bar.append(el("button", {
      class: `chip tagchip ${chip.tone || "custom"}`,
      type: "button",
      text: chip.text,
      title: chip.title || "",
      onClick: (event) => {
        event.preventDefault();
        handlers.onChip?.(chip);
      },
    }));
  }
}

export function mountBar(host, model, handlers) {
  const ready = ensureShadow(host, { guardClick: true });
  host = ready.host;
  const shadow = ready.shadow;
  if (!shadow) return;
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
  paintChips(bar, model, handlers);
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

/** Compact protect badge and tag chips. Same shadow host rules as the strike bar. */
export function mountInline(host, model, handlers) {
  const ready = ensureShadow(host, { guardClick: true });
  host = ready.host;
  const shadow = ready.shadow;
  if (!shadow) return;
  const signature = JSON.stringify(model.signature);
  if (host.dataset.xslSig === signature && shadow.childElementCount) return;
  host.dataset.xslSig = signature;
  const bar = el("div", { class: "bar inline" });
  paintChips(bar, model, handlers);
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
    if (model.note) sheet.append(el("p", { class: "safe", text: model.note }));
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
    if (model.keyword) {
      const kw = model.keyword;
      const word = el("input", {
        type: "text",
        maxlength: "80",
        value: kw.word || "",
        placeholder: kw.placeholder,
        "aria-label": kw.placeholder,
      });
      const select = el("select", { "aria-label": kw.packLabel });
      for (const pack of kw.packs || []) {
        select.append(el("option", { value: pack.id, text: pack.name, selected: pack.id === kw.packId }));
      }
      sheet.append(el("div", { class: "kw" }, [
        el("p", { text: kw.note }),
        word,
        el("div", { class: "row" }, [
          select,
          el("button", {
            type: "button",
            text: kw.add,
            disabled: !(kw.packs || []).length,
            onClick: () => finish({ type: "keyword", value: word.value, packId: select.value }),
          }),
        ]),
      ]));
    }
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

export function openAiSuggest(shadow, model) {
  return openSheet(shadow, (sheet, finish) => {
    sheet.append(el("h2", { text: model.title }));
    if (model.body) sheet.append(el("p", { text: model.body }));
    if (model.note) sheet.append(el("p", { text: model.note }));
    const boxes = [];
    const rules = model.rules || [];
    if (rules.length) {
      const list = el("div", { class: "rules" });
      for (const rule of rules) {
        const input = el("input", { type: "checkbox", checked: true });
        boxes.push({ input, rule });
        list.append(el("label", {}, [input, rule.label || rule.value || ""]));
      }
      sheet.append(list);
      const select = el("select", { "aria-label": model.packLabel || "" });
      for (const pack of model.packs || []) {
        select.append(el("option", { value: pack.id, text: pack.name, selected: pack.id === model.packId }));
      }
      sheet.append(select);
    }
    const saveRules = () => {
      const select = sheet.querySelector("select");
      const picked = boxes.filter((item) => item.input.checked).map((item) => ({
        type: item.rule.type,
        target: item.rule.target,
        value: item.rule.value,
      }));
      finish({ save: true, packId: select?.value || "", rules: picked });
    };
    sheet.append(el("div", { class: "row" }, [
      el("button", { type: "button", text: model.cancel, onClick: () => finish(null) }),
      rules.length
        ? el("button", {
          type: "button",
          text: model.save,
          disabled: !(model.packs || []).length,
          onClick: saveRules,
        })
        : null,
      el("button", {
        class: "primary",
        type: "button",
        text: model.confirm,
        onClick: () => finish({ confirm: true }),
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
