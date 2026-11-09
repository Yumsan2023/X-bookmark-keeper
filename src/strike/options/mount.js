import { send } from "../lib/client.js";
import { loadDict, translate } from "../lib/i18n.js";
import { allowedCommunityUrl, communityPermissionOrigin, DEFAULT_TAG_EFFECT, packsToText, parseKeywordPackText, resolveLang, shortcutFromEvent, TAG_EFFECT_IDS, tagLabel } from "../lib/pure.js";

/** Mount the strike options UI inside a shadow root (or any parent). */
export async function mountStrikeOptions(root) {
  const dict = await loadDict();
  let lang = "en";
  let draft = null;
  let ledger = [];
  let queue = [];
  let dashboard = null;
  let log = [];
  let hitLog = [];
  let vetoes = [];
  let undo = null;
  let stats = null;
  let keyDirty = false;

  const $ = (selector) => root.querySelector(selector);

  function t(key, vars) {
    return translate(dict, lang, key, vars);
  }

  function applyStatic() {
    if (root.host) root.host.lang = lang === "zh" ? "zh-CN" : "en";
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  }

  function note(text, kind = "") {
    const node = $("#status");
    node.textContent = text || "";
    node.className = kind;
  }

  function button(label, onClick, className = "") {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    if (className) node.className = className;
    node.addEventListener("click", onClick);
    return node;
  }

  function renderStats() {
    const root = $("#stats");
    root.replaceChildren();
    const items = [
      [stats?.accounts ?? 0, "statsAccounts"],
      [stats?.strikes ?? 0, "statsStrikes"],
      [stats?.hidden ?? 0, "statsHidden"],
      [`${stats?.actionsToday ?? 0}/${stats?.dailyCap ?? 0}`, "statsToday"],
    ];
    for (const [value, key] of items) {
      const card = document.createElement("div");
      card.className = "stat";
      const number = document.createElement("b");
      number.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = t(key);
      card.append(number, caption);
      root.append(card);
    }
    $("#undo-line").textContent = t("undoPreview", { text: undo ? `${undo.kind} @${undo.handle || ""} ${undo.tag || undo.action || ""}` : t("noUndoText") });
    $("#undo-btn").disabled = !undo;
  }

  function fillForm() {
    $("#language").value = draft.language;
    $("#defaultThreshold").value = draft.defaultThreshold;
    root.querySelector(`input[name="actionMode"][value="${draft.actionMode}"]`).checked = true;
    for (const id of ["hideOnThreshold", "muteOnThreshold", "blockOnThreshold", "enablePlatformActions", "rulesEnabled", "hitHistory", "libraryChipFromStrikes", "bookmarkMarkAddsStrike"]) {
      $(`#${id}`).checked = !!draft[id];
    }
    $("#commentScanEnabled").checked = !!draft.commentScanEnabled;
    $("#foldReasonEnabled").checked = draft.foldReasonEnabled !== false;
    $("#hoverCardEnabled").checked = draft.hoverCardEnabled !== false;
    $("#markBarEnabled").checked = draft.markBarEnabled !== false;
    $("#partnershipRatioEnabled").checked = draft.partnershipRatioEnabled === true;
    $("#communityListsEnabled").checked = draft.communityListsEnabled === true;
    const communityMode = draft.communityListMode === "fold" ? "fold" : "yellow";
    const communityModeInput = root.querySelector(`input[name="communityListMode"][value="${communityMode}"]`);
    if (communityModeInput) communityModeInput.checked = true;
    const commentMode = draft.commentHitMode === "prompt" ? "prompt" : "fold";
    const commentModeInput = root.querySelector(`input[name="commentHitMode"][value="${commentMode}"]`);
    if (commentModeInput) commentModeInput.checked = true;
    $("#libraryChipThreshold").value = draft.libraryChipThreshold ?? 3;
    $("#vetoCooldownDays").value = draft.vetoCooldownDays ?? 14;
    $("#dailyCap").value = draft.dailyCap;
    $("#rateLimitMs").value = draft.rateLimitMs;
    $("#shortcut-spam").textContent = draft.shortcuts.spam;
    $("#shortcut-marketing").textContent = draft.shortcuts.marketing;
    $("#shortcut-vagueposting").textContent = draft.shortcuts.vagueposting;
    $("#shortcut-picker").textContent = draft.shortcuts.picker;
    $("#aiEnabled").checked = !!draft.ai.enabled;
    $("#autoSuggest").checked = !!draft.ai.autoSuggestSuspects;
    $("#endpoint").value = draft.ai.endpoint;
    $("#model").value = draft.ai.model;
    $("#apiKey").value = draft.ai.apiKey || "";
    keyDirty = false;
    $("#pack-text").value = packsToText(draft.keywordPacks);
    if (!draft.tagEffects || typeof draft.tagEffects !== "object") draft.tagEffects = {};
    renderThresholds();
    renderPacks();
    renderVetoes();
    renderHitLog();
    renderCommunityLists();
  }

  function renderThresholds() {
    const root = $("#tag-thresholds");
    root.replaceChildren();
    const names = ["Spam", "Marketing", "Vagueposting", ...(draft.customTags || [])];
    for (const name of names) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = t("tagThreshold", { tag: tagLabel(name, lang) });
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "99";
      input.value = draft.tagThresholds[name] || draft.defaultThreshold;
      input.addEventListener("input", () => {
        draft.tagThresholds[name] = Number(input.value);
      });
      label.append(span, input);
      if (name !== "Spam" && name !== "Marketing" && name !== "Vagueposting") {
        label.append(button(t("remove"), () => {
          draft.customTags = draft.customTags.filter((tag) => tag !== name);
          if (draft.tagEffects) delete draft.tagEffects[name];
          renderThresholds();
        }));
      }
      root.append(label);
    }
    const form = document.createElement("form");
    form.className = "row";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.placeholder = t("tagPh");
    input.setAttribute("aria-label", t("customTags"));
    form.append(input);
    form.append(button(t("addTag"), () => {
      const name = input.value.trim();
      if (!name) return;
      if (!draft.customTags.includes(name) && name.toLowerCase() !== "spam" && name.toLowerCase() !== "marketing" && name.toLowerCase() !== "vagueposting") {
        draft.customTags.push(name);
        draft.tagThresholds[name] = draft.tagThresholds[name] || draft.defaultThreshold;
      }
      input.value = "";
      renderThresholds();
    }));
    form.addEventListener("submit", (event) => event.preventDefault());
    root.append(form);
    renderTagEffects();
  }

  function renderTagEffects() {
    const box = $("#tag-effects");
    if (!box) return;
    box.replaceChildren();
    if (!draft.tagEffects || typeof draft.tagEffects !== "object") draft.tagEffects = {};
    const names = ["Spam", "Marketing", "Vagueposting", ...(draft.customTags || [])];
    for (const name of names) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = tagLabel(name, lang);
      const select = document.createElement("select");
      const current = TAG_EFFECT_IDS.includes(draft.tagEffects[name]) ? draft.tagEffects[name] : DEFAULT_TAG_EFFECT;
      select.setAttribute("aria-label", t("tagEffectFor", { tag: tagLabel(name, lang) }));
      for (const id of ["chip", "none", "outline", "fold"]) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = t(`tagEffect_${id}`);
        option.selected = id === current;
        select.append(option);
      }
      select.addEventListener("change", () => {
        if (select.value === DEFAULT_TAG_EFFECT) delete draft.tagEffects[name];
        else draft.tagEffects[name] = select.value;
      });
      label.append(span, select);
      box.append(label);
    }
  }

  function renderPacks() {
    const root = $("#packs");
    root.replaceChildren();
    draft.keywordPacks.forEach((pack, index) => {
      const card = document.createElement("article");
      card.className = "pack";
      const title = document.createElement("input");
      title.type = "text";
      title.value = pack.name;
      title.setAttribute("aria-label", t("packName"));
      title.addEventListener("input", () => { pack.name = title.value; });
      const enabled = document.createElement("label");
      enabled.className = "inline";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = pack.enabled !== false;
      checkbox.addEventListener("change", () => { pack.enabled = checkbox.checked; });
      enabled.append(checkbox, document.createTextNode(t("packEnabled")));
      const packEnqueue = document.createElement("label");
      packEnqueue.className = "inline";
      packEnqueue.title = t("ruleEnqueueHelp");
      const enqueueAll = document.createElement("input");
      enqueueAll.type = "checkbox";
      enqueueAll.dataset.packEnqueue = "1";
      syncPackEnqueue(enqueueAll, pack);
      enqueueAll.addEventListener("change", () => {
        for (const pattern of pack.patterns) {
          if (enqueueAll.checked) delete pattern.enqueue;
          else pattern.enqueue = false;
        }
        renderPacks();
      });
      packEnqueue.append(enqueueAll, document.createTextNode(t("packEnqueue")));
      const suggest = document.createElement("select");
      suggest.setAttribute("aria-label", t("suggestTag"));
      for (const [value, label] of [["Spam", t("spam")], ["Marketing", t("marketing")], ["", t("noneTag")]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        suggest.append(option);
      }
      suggest.value = pack.suggestTag === "Marketing" ? "Marketing" : pack.suggestTag === "Spam" ? "Spam" : "";
      suggest.addEventListener("change", () => { pack.suggestTag = suggest.value; });
      card.append(title, enabled, packEnqueue, suggest);
      for (const pattern of pack.patterns) {
        card.append(patternRow(pack, pattern));
      }
      const controls = document.createElement("div");
      controls.className = "row";
      controls.append(
        button(t("addPattern"), () => {
          const enqueueOff = pack.patterns.length > 0 && pack.patterns.every((pattern) => pattern.enqueue === false);
          pack.patterns.push(enqueueOff
            ? { type: "keyword", target: "any", value: "", enqueue: false }
            : { type: "keyword", target: "any", value: "" });
          renderPacks();
        }),
        button(t("remove"), () => {
          draft.keywordPacks.splice(index, 1);
          renderPacks();
        }, "danger"),
      );
      card.append(controls);
      root.append(card);
    });
  }

  function patternRow(pack, pattern) {
    const row = document.createElement("div");
    row.className = "pattern";
    const type = document.createElement("select");
    for (const [value, label] of [["keyword", t("keyword")], ["regex", t("regex")]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      type.append(option);
    }
    type.value = pattern.type === "regex" ? "regex" : "keyword";
    type.addEventListener("change", () => { pattern.type = type.value; });
    const target = document.createElement("select");
    for (const value of ["any", "text", "handle", "bio"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t(value);
      target.append(option);
    }
    target.value = ["text", "handle", "bio", "any"].includes(pattern.target) ? pattern.target : "any";
    target.addEventListener("change", () => { pattern.target = target.value; });
    const value = document.createElement("input");
    value.type = "text";
    value.value = pattern.value;
    value.placeholder = pattern.type === "regex" ? "(?i)t\\.me/" : t("pattern");
    value.addEventListener("input", () => { pattern.value = value.value; });
    const enqueue = document.createElement("label");
    enqueue.className = "inline enqueue";
    enqueue.title = t("ruleEnqueueHelp");
    const enqueueBox = document.createElement("input");
    enqueueBox.type = "checkbox";
    enqueueBox.checked = pattern.enqueue !== false;
    enqueueBox.addEventListener("change", () => {
      if (enqueueBox.checked) delete pattern.enqueue;
      else pattern.enqueue = false;
      const card = row.closest(".pack");
      const packBox = card?.querySelector("[data-pack-enqueue]");
      if (packBox) syncPackEnqueue(packBox, pack);
    });
    enqueue.append(enqueueBox, document.createTextNode(t("ruleEnqueue")));
    row.append(type, target, value, enqueue, button(t("remove"), () => {
      pack.patterns = pack.patterns.filter((item) => item !== pattern);
      renderPacks();
    }));
    return row;
  }

  function syncPackEnqueue(box, pack) {
    const flags = (pack.patterns || []).map((pattern) => pattern.enqueue !== false);
    const allOn = flags.every(Boolean);
    const allOff = flags.length > 0 && flags.every((on) => !on);
    box.checked = allOn;
    box.indeterminate = !allOn && !allOff;
  }

  function renderLedger() {
    const root = $("#ledger-list");
    root.replaceChildren();
    const query = $("#query").value.trim().toLowerCase();
    const rows = ledger.filter((account) => {
      if (!query) return true;
      const blob = [account.handle, account.displayName, ...(account.tags || []).map((tag) => tag.name)].join(" ").toLowerCase();
      return blob.includes(query);
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("emptyLedger");
      root.append(empty);
      return;
    }
    for (const account of rows) {
      const card = document.createElement("article");
      card.className = "account";
      const title = document.createElement("div");
      const handle = document.createElement("span");
      handle.className = "handle";
      handle.textContent = `@${account.handle}`;
      title.append(handle);
      if (account.displayName) {
        const name = document.createElement("span");
        name.className = "meta";
        name.textContent = ` ${account.displayName}`;
        title.append(name);
      }
      card.append(title);
      const tags = document.createElement("div");
      for (const tag of account.tags || []) {
        const chip = document.createElement("span");
        chip.className = "tag";
        chip.append(document.createTextNode(`${tagLabel(tag.name, lang)} ${tag.count} `));
        chip.append(button(t("clearTag"), async () => {
          const result = await send({ type: "CLEAR_TAG", userId: account.userId, tag: tag.name });
          note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
          if (result.ok) await reload();
        }));
        tags.append(chip);
        if (tag.evidence?.length) {
          const list = document.createElement("ul");
          list.className = "evidence";
          for (const item of tag.evidence.slice(0, 3)) {
            const li = document.createElement("li");
            li.textContent = item.textSnippet || item.tweetId;
            list.append(li);
          }
          card.append(list);
        }
      }
      card.append(tags);
      const controls = document.createElement("div");
      controls.className = "row";
      controls.append(button(account.whitelist ? t("whitelist") : t("whitelistToggle"), async () => {
        const result = await send({
          type: "SET_WHITELIST",
          userId: account.userId,
          handle: account.handle,
          whitelist: !account.whitelist,
        });
        if (result.ok) await reload();
      }));
      controls.append(button(t(account.hidden ? "unhide" : "hide"), async () => {
        const result = await send({
          type: "SET_HIDDEN",
          userId: account.userId,
          handle: account.handle,
          hidden: !account.hidden,
        });
        if (result.ok) await reload();
      }));
      controls.append(button(t("delete"), async () => {
        if (!window.confirm(t("confirmDelete", { handle: account.handle }))) return;
        const result = await send({ type: "DELETE_ACCOUNT", userId: account.userId });
        note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
        if (result.ok) await reload();
      }, "danger"));
      card.append(controls);
      root.append(card);
    }
  }

  function renderQueueDash() {
    const dash = dashboard || {};
    const root = $("#queue-stats");
    root.replaceChildren();
    const cards = [
      [dash.length ?? 0, "queueLength"],
      [dash.failed ?? 0, "queueFailed"],
      [`${dash.actionsToday ?? 0}/${dash.dailyCap ?? 0}`, "dailyUsed"],
      [dash.paused ? t("queuePausedState") : t("queueRunning"), "queueState"],
    ];
    for (const [value, key] of cards) {
      const card = document.createElement("div");
      card.className = "stat";
      const number = document.createElement("b");
      number.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = t(key);
      card.append(number, caption);
      root.append(card);
    }
    const err = $("#queue-last-error");
    err.textContent = dash.lastError ? t("lastError", { error: dash.lastError }) : t("noLastError");
    err.className = dash.lastError ? "hint queue-error" : "hint";
    const backoff = $("#queue-backoff");
    const until = dash.backoffUntil || 0;
    if (until > Date.now()) {
      backoff.hidden = false;
      backoff.textContent = t("backoffUntil", { time: new Date(until).toLocaleTimeString() });
    } else {
      backoff.hidden = true;
      backoff.textContent = "";
    }
    const hold = $("#queue-hold");
    hold.hidden = !dash.paused;
    hold.textContent = dash.paused ? t("pausedHint") : "";
    const pauseBtn = $("#queue-pause");
    pauseBtn.textContent = dash.paused ? t("resumeQueue") : t("pauseQueue");
    $("#queue-retry-failed").textContent = t("retryFailed");
    $("#queue-retry-failed").disabled = !(dash.failed > 0);
    $("#queue-clear").textContent = t("clearQueue");
    $("#queue-clear").disabled = !(dash.length > 0);
    $("#queue-clear-failed").textContent = t("clearFailed");
    $("#queue-clear-failed").disabled = !(dash.failed > 0);
  }

  function renderQueue() {
    const root = $("#queue");
    root.replaceChildren();
    if (!queue.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("emptyQueue");
      root.append(empty);
      return;
    }
    for (const item of queue) {
      const row = document.createElement("div");
      row.className = "queue-item";
      const status = item.status === "failed" ? t("failed") : item.status === "inflight" ? t("inflight") : t("pending");
      const text = document.createElement("div");
      text.textContent = `${t(item.type)} @${item.handle} · ${status}${item.attempts ? ` · ${item.attempts}` : ""}${item.lastError ? ` · ${item.lastError}` : ""}`;
      row.append(text);
      const controls = document.createElement("div");
      controls.className = "row";
      if (item.status === "failed") {
        controls.append(button(t("retry"), async () => {
          await send({ type: "RETRY_ACTION", id: item.id });
          await reload();
        }));
      }
      controls.append(button(t("cancel"), async () => {
        await send({ type: "CANCEL_ACTION", id: item.id });
        await reload();
      }));
      row.append(controls);
      root.append(row);
    }
  }

  function renderVetoes() {
    const root = $("#veto-list");
    root.replaceChildren();
    const rows = Array.isArray(vetoes) ? vetoes : [];
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("emptyVetoes");
      root.append(empty);
      return;
    }
    const now = Date.now();
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "log-item";
      const when = new Date(item.at).toLocaleString();
      const name = item.packName || (item.kind === "ai" ? t("fpAiDismiss") : t("fpAiWord", { pattern: item.pattern || "" }));
      const pattern = item.pattern ? ` · ${item.pattern}` : "";
      let life = t("vetoForever");
      if (item.kind === "exception") life = t("vetoPhrase", { phrase: item.phrase || "" });
      else if (item.until && item.until > now) life = t("vetoUntil", { time: new Date(item.until).toLocaleString() });
      else if (item.until && item.until <= now) life = t("vetoExpired");
      const scope = item.kind === "exception"
        ? (item.phraseScope === "any" ? t("fpScopeAny") : t("fpScopeAuthor", { handle: item.handle || "?" }))
        : "";
      const text = document.createElement("div");
      text.textContent = `${when} · ${name}${pattern} · ${life}${scope ? ` · ${scope}` : ""}`;
      row.append(text, button(t("undoVeto"), async () => {
        const result = await send({ type: "UNDO_VETO", id: item.id });
        note(result.ok ? t("vetoUndone") : t(result.error || "error"), result.ok ? "ok" : "bad");
        if (result.ok) await reload();
      }));
      root.append(row);
    }
  }

  function renderHitLog() {
    const root = $("#hit-log");
    root.replaceChildren();
    if (!hitLog.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("emptyHits");
      root.append(empty);
      return;
    }
    for (const item of hitLog) {
      const row = document.createElement("div");
      row.className = "log-item";
      const when = new Date(item.at).toLocaleString();
      const who = item.handle ? `@${item.handle}` : "";
      row.textContent = `${when} · ${item.packName || item.packId} · ${item.pattern} · ${who} ${item.snippet || ""}`.trim();
      root.append(row);
    }
  }

  function communityModeNow() {
    return root.querySelector('input[name="communityListMode"]:checked')?.value === "fold" ? "fold" : "yellow";
  }

  function communityErrorText(error) {
    const code = String(error || "");
    if (!code) return "";
    if (code.startsWith("http-")) return t("communityHttp", { status: code.slice(5) });
    return t(code);
  }

  async function reloadKeepCommunityToggles() {
    const enabled = $("#communityListsEnabled").checked;
    const mode = communityModeNow();
    await reload();
    draft.communityListsEnabled = enabled;
    draft.communityListMode = mode;
    $("#communityListsEnabled").checked = enabled;
    const input = root.querySelector(`input[name="communityListMode"][value="${mode}"]`);
    if (input) input.checked = true;
  }

  function renderCommunityLists() {
    const box = $("#community-lists");
    box.replaceChildren();
    const lists = Array.isArray(draft.communityLists) ? draft.communityLists : [];
    if (!lists.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("communityEmpty");
      box.append(empty);
      return;
    }
    for (const list of lists) {
      const card = document.createElement("article");
      card.className = "pack";
      const title = document.createElement("div");
      title.className = "handle";
      title.textContent = list.name || t("communityChip");
      const enabled = document.createElement("label");
      enabled.className = "inline";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = list.enabled !== false;
      checkbox.addEventListener("change", async () => {
        const result = await send({ type: "SET_COMMUNITY_LIST", id: list.id, enabled: checkbox.checked });
        note(result?.ok ? t("saved") : t(result?.error || "error"), result?.ok ? "ok" : "bad");
        if (result?.ok) await reloadKeepCommunityToggles();
      });
      enabled.append(checkbox, document.createTextNode(` ${t("packEnabled")}`));
      const meta = document.createElement("p");
      meta.className = "meta";
      const where = list.url ? list.url : t("communityLocal");
      const counts = t("communityCounts", { handles: list.handles?.length || 0, keywords: list.keywords?.length || 0 });
      const when = list.fetchedAt ? t("communityFetched", { when: new Date(list.fetchedAt).toLocaleString() }) : "";
      meta.textContent = [where, counts, when].filter(Boolean).join(" · ");
      card.append(title, enabled, meta);
      if (list.error) {
        const err = document.createElement("p");
        err.className = "queue-error";
        err.textContent = `${communityErrorText(list.error)} · ${t("communityCached")}`;
        card.append(err);
      }
      const controls = document.createElement("div");
      controls.className = "row";
      if (list.url) {
        controls.append(button(t("communityRefresh"), async () => {
          const origin = communityPermissionOrigin(list.url);
          if (origin) {
            try {
              const granted = await chrome.permissions.request({ origins: [origin] });
              if (!granted) {
                note(t("grantDenied"), "bad");
                return;
              }
            } catch {
              note(t("grantDenied"), "bad");
              return;
            }
          }
          const result = await send({ type: "REFRESH_COMMUNITY", id: list.id });
          if (!result?.ok) note(result?.kept ? t("communityKept") : communityErrorText(result?.error), "bad");
          else if (result.kept) note(t("communityKept"), "bad");
          else note(t("saved"), "ok");
          await reloadKeepCommunityToggles();
        }));
      }
      controls.append(button(t("communityDelete"), async () => {
        if (!window.confirm(t("communityDeleteConfirm", { name: list.name || "" }))) return;
        const result = await send({ type: "REMOVE_COMMUNITY", id: list.id });
        note(result?.ok ? t("saved") : t(result?.error || "error"), result?.ok ? "ok" : "bad");
        if (result?.ok) await reloadKeepCommunityToggles();
      }, "danger"));
      card.append(controls);
      box.append(card);
    }
  }

  function renderLog() {
    const root = $("#log");
    root.replaceChildren();
    if (!log.length) {
      const empty = document.createElement("p");
      empty.className = "quiet";
      empty.textContent = t("emptyLog");
      root.append(empty);
      return;
    }
    for (const item of log) {
      const row = document.createElement("div");
      row.className = "log-item";
      const when = new Date(item.at).toLocaleString();
      row.textContent = `${when} · ${item.type || ""} ${item.handle ? `@${item.handle}` : ""} ${item.ok === false ? t("failed") : ""} ${item.error || item.detail || ""}`;
      root.append(row);
    }
  }

  function readForm() {
    draft.language = $("#language").value;
    draft.defaultThreshold = Number($("#defaultThreshold").value);
    draft.actionMode = root.querySelector('input[name="actionMode"]:checked')?.value || "confirm";
    for (const id of ["hideOnThreshold", "muteOnThreshold", "blockOnThreshold", "enablePlatformActions", "rulesEnabled", "hitHistory", "libraryChipFromStrikes", "bookmarkMarkAddsStrike"]) {
      draft[id] = $(`#${id}`).checked;
    }
    draft.commentScanEnabled = $("#commentScanEnabled").checked;
    draft.foldReasonEnabled = $("#foldReasonEnabled").checked;
    draft.hoverCardEnabled = $("#hoverCardEnabled").checked;
    draft.markBarEnabled = $("#markBarEnabled").checked;
    draft.partnershipRatioEnabled = $("#partnershipRatioEnabled").checked;
    draft.communityListsEnabled = $("#communityListsEnabled").checked;
    draft.communityListMode = root.querySelector('input[name="communityListMode"]:checked')?.value === "fold" ? "fold" : "yellow";
    draft.commentHitMode = root.querySelector('input[name="commentHitMode"]:checked')?.value === "prompt" ? "prompt" : "fold";
    draft.libraryChipThreshold = Number($("#libraryChipThreshold").value);
    draft.vetoCooldownDays = Number($("#vetoCooldownDays").value);
    draft.dailyCap = Number($("#dailyCap").value);
    draft.rateLimitMs = Number($("#rateLimitMs").value);
    draft.ai = {
      ...draft.ai,
      enabled: $("#aiEnabled").checked,
      autoSuggestSuspects: $("#autoSuggest").checked,
      endpoint: $("#endpoint").value.trim(),
      model: $("#model").value.trim(),
    };
    if (keyDirty) draft.ai.apiKey = $("#apiKey").value;
    else delete draft.ai.apiKey;
    draft.keywordPacks = draft.keywordPacks.map((pack) => ({
      ...pack,
      patterns: pack.patterns.filter((pattern) => String(pattern.value || "").trim()),
    }));
  }

  async function save() {
    readForm();
    if (draft.ai.enabled) {
      try {
        const granted = await chrome.permissions.request({
          origins: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
        });
        if (!granted) note(t("grantDenied"), "bad");
      } catch {
        note(t("grantDenied"), "bad");
      }
    }
    const patch = { ...draft };
    const result = await send({ type: "UPDATE_SETTINGS", patch });
    if (!result?.ok) {
      note(t(result?.error || "error"), "bad");
      return;
    }
    const warnings = result.warnings || [];
    note(warnings.length ? `${t("saved")} — ${warnings.join(" ")}` : t("saved"), warnings.length ? "bad" : "ok");
    await reload();
  }

  async function reload() {
    const result = await send({ type: "GET_EDITOR", limit: 200 });
    if (!result?.ok) {
      note(t(result?.error || "error"), "bad");
      return;
    }
    draft = result.settings;
    ledger = result.ledger || [];
    queue = result.queue || [];
    dashboard = result.dashboard || {
      length: queue.filter((item) => item.status !== "failed").length,
      failed: queue.filter((item) => item.status === "failed").length,
      lastError: result.stats?.lastError || "",
      actionsToday: result.stats?.actionsToday ?? 0,
      dailyCap: result.stats?.dailyCap ?? 0,
      paused: !!result.stats?.paused,
      backoffUntil: result.stats?.backoffUntil || 0,
    };
    log = result.log || [];
    hitLog = result.hitLog || [];
    vetoes = result.vetoes || [];
    undo = result.undo;
    stats = result.stats;
    lang = resolveLang(draft.language, navigator.language);
    applyStatic();
    fillForm();
    renderStats();
    renderLedger();
    renderQueueDash();
    renderQueue();
    renderLog();
  }

  $("#language").addEventListener("change", () => {
    draft.language = $("#language").value;
    lang = resolveLang(draft.language, navigator.language);
    applyStatic();
    renderStats();
    renderLedger();
    renderPacks();
    renderThresholds();
    renderQueueDash();
    renderQueue();
    renderLog();
    renderHitLog();
    renderVetoes();
    renderCommunityLists();
  });

  $("#query").addEventListener("input", () => renderLedger());
  $("#save").addEventListener("click", save);
  $("#save-top").addEventListener("click", save);
  $("#queue-pause").addEventListener("click", async () => {
    const result = await send({ type: "SET_QUEUE_PAUSED", paused: !dashboard?.paused });
    note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  $("#queue-retry-failed").addEventListener("click", async () => {
    const result = await send({ type: "RETRY_FAILED" });
    note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  $("#queue-clear").addEventListener("click", async () => {
    if (!window.confirm(t("confirmClearQueue"))) return;
    const result = await send({ type: "CLEAR_QUEUE", scope: "pending" });
    note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  $("#queue-clear-failed").addEventListener("click", async () => {
    if (!window.confirm(t("confirmClearFailed"))) return;
    const result = await send({ type: "CLEAR_QUEUE", scope: "failed" });
    note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  $("#undo-btn").addEventListener("click", async () => {
    const result = await send({ type: "UNDO" });
    note(result.ok ? t("undone") : t(result.error === "empty" ? "undoEmpty" : "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  $("#add-pack").addEventListener("click", () => {
    draft.keywordPacks.push({ id: `pack-${Date.now()}`, name: t("addPack"), enabled: true, suggestTag: "Spam", patterns: [{ type: "keyword", target: "any", value: "" }] });
    renderPacks();
  });
  $("#restore-packs").addEventListener("click", async () => {
    const result = await send({ type: "RESTORE_PACKS" });
    if (result.ok) {
      draft.keywordPacks = result.keywordPacks;
      $("#pack-text").value = packsToText(draft.keywordPacks);
      renderPacks();
      note(t("saved"), "ok");
    }
  });
  function applyPackText(text) {
    const parsed = parseKeywordPackText(text);
    if (!parsed.ok) {
      note(t(parsed.error || "error"), "bad");
      return;
    }
    if (!parsed.packs.length) {
      note(t("packTextEmpty"), "bad");
      return;
    }
    draft.keywordPacks = parsed.packs;
    $("#pack-text").value = packsToText(draft.keywordPacks);
    renderPacks();
    const warnings = parsed.warnings || [];
    const applied = t("packTextApplied", { count: parsed.packs.length });
    note(warnings.length ? `${applied} ${warnings.join(" ")}` : applied, warnings.length ? "bad" : "ok");
  }
  $("#pack-text-apply").addEventListener("click", () => applyPackText($("#pack-text").value));
  $("#pack-text-refresh").addEventListener("click", () => {
    $("#pack-text").value = packsToText(draft.keywordPacks);
  });
  $("#pack-text-export").addEventListener("click", () => {
    const raw = $("#pack-text").value;
    const blob = new Blob([raw.trim() ? raw : packsToText(draft.keywordPacks)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `x-toolkit-keywords-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    note(t("exportDone"), "ok");
  });
  $("#pack-text-file").addEventListener("change", async () => {
    const file = $("#pack-text-file").files?.[0];
    $("#pack-text-file").value = "";
    if (!file) return;
    if (file.size > 100_000) return note(t("too-large"), "bad");
    applyPackText(await file.text());
  });
  async function importCommunityText(text) {
    const result = await send({ type: "IMPORT_COMMUNITY", text });
    if (!result?.ok) {
      note(communityErrorText(result?.error) || t("error"), "bad");
      return;
    }
    const imported = t("communityImported", { name: result.list?.name || "" });
    const warnings = result.warnings || [];
    note(warnings.length ? `${imported} ${warnings.join(" ")}` : imported, warnings.length ? "bad" : "ok");
    $("#community-text").value = "";
    await reloadKeepCommunityToggles();
  }
  $("#community-import").addEventListener("click", () => importCommunityText($("#community-text").value));
  $("#community-file").addEventListener("change", async () => {
    const file = $("#community-file").files?.[0];
    $("#community-file").value = "";
    if (!file) return;
    if (file.size > 512_000) return note(t("too-large"), "bad");
    await importCommunityText(await file.text());
  });
  $("#community-subscribe").addEventListener("click", async () => {
    const url = $("#community-url").value.trim();
    if (!allowedCommunityUrl(url)) return note(t("bad-url"), "bad");
    const origin = communityPermissionOrigin(url);
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return note(t("grantDenied"), "bad");
    } catch {
      return note(t("grantDenied"), "bad");
    }
    const result = await send({ type: "SUBSCRIBE_COMMUNITY", url });
    if (!result?.ok) {
      note(`${t("communityFetchNew")} ${communityErrorText(result?.error)}`.trim(), "bad");
      return;
    }
    if (result.kept) note(t("communityKept"), "bad");
    else {
      const subscribed = t("communitySubscribed", { name: result.list?.name || "" });
      const warnings = result.warnings || [];
      note(warnings.length ? `${subscribed} ${warnings.join(" ")}` : subscribed, warnings.length ? "bad" : "ok");
      $("#community-url").value = "";
    }
    await reloadKeepCommunityToggles();
  });
  $("#clear-hits").addEventListener("click", async () => {
    const result = await send({ type: "CLEAR_HIT_LOG" });
    note(result.ok ? t("saved") : t(result.error || "error"), result.ok ? "ok" : "bad");
    if (result.ok) await reload();
  });
  for (const node of root.querySelectorAll("[data-slot]")) {
    node.addEventListener("keydown", (event) => {
      event.preventDefault();
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return;
      draft.shortcuts[node.dataset.slot] = shortcut;
      node.textContent = shortcut;
    });
  }
  $("#apiKey").addEventListener("input", () => { keyDirty = true; });
  $("#clear-key").addEventListener("click", () => {
    $("#apiKey").value = "";
    keyDirty = true;
  });
  $("#export").addEventListener("click", async () => {
    const result = await send({ type: "EXPORT", includeSecrets: $("#includeSecrets").checked });
    if (!result?.ok) return note(t(result.error || "error"), "bad");
    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `x-strike-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    note(t("exportDone"), "ok");
  });
  $("#import-file").addEventListener("change", async () => {
    const file = $("#import-file").files?.[0];
    $("#import-file").value = "";
    if (!file) return;
    if (file.size > 15_000_000) return note(t("too-large"), "bad");
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      return note(t("fileBad"), "bad");
    }
    const result = await send({
      type: "IMPORT",
      payload,
      mode: root.querySelector('input[name="importMode"]:checked')?.value || "merge",
      settings: $("#includeSettings").checked,
      includeSecrets: $("#includeSecrets").checked,
    });
    if (!result?.ok) return note(t(result.error || "fileBad"), "bad");
    note(t("imported", { count: result.accounts }), "ok");
    await reload();
  });
  $("#reset").addEventListener("click", async () => {
    if ($("#reset-text").value.trim() !== "RESET") return note(t("resetHint"), "bad");
    const result = await send({ type: "RESET_ALL", confirm: "RESET" });
    if (!result?.ok) return note(t(result.error || "error"), "bad");
    $("#reset-text").value = "";
    note(t("saved"), "ok");
    await reload();
  });

  for (const anchor of root.querySelectorAll("nav a[href^='#']")) {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      const id = anchor.getAttribute("href").slice(1);
      root.getElementById(id)?.scrollIntoView({ block: "start" });
    });
  }

  reload();
}
