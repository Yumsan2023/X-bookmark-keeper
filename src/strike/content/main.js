import { send } from "../lib/client.js";
import { parseArticle } from "../lib/domparse.js";
import { loadDict, translate } from "../lib/i18n.js";
import {
  canonicalTag,
  contentHash,
  distillSuggestion,
  eventMatchesShortcut,
  isRateLimitSignal,
  isTypingTarget,
  matchRules,
  resolveLang,
  suggestPackId,
  tagLabel,
  timelineChrome,
} from "../lib/pure.js";
import { performPlatformAction } from "./act.js";
import { createOverlay, mountBar, mountInline, openAiSuggest, openChoice, openPicker, toast } from "./view.js";

const expanded = new Set();
const aiAsked = new Set();
const aiResults = new Map();
const seenSent = new Set();
const reportedHits = new Set();
let dict = {};
let snapshot = null;
let lang = "en";
let hovered = null;
let overlay = null;
let overlayBusy = false;
let pumping = false;
let capNotified = "";
let backoffNotified = 0;
let aiInflight = 0;
let scanTimer = 0;

function t(key, vars) {
  return translate(dict, lang, key, vars);
}

function pageContext() {
  const bio = document.querySelector('[data-testid="UserDescription"]');
  const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
  const unfollow = primary.querySelector('[data-testid$="-unfollow"], [data-testid="unfollow"]');
  const follow = [...primary.querySelectorAll('[data-testid$="-follow"], [data-testid="follow"]')]
    .find((node) => !(node.getAttribute("data-testid") || "").endsWith("-unfollow"));
  return {
    pathname: location.pathname,
    profileBio: bio ? (bio.innerText || "") : "",
    profileFollowed: unfollow ? true : follow ? false : null,
  };
}

function describe(article) {
  const parsed = parseArticle(article, pageContext());
  if (!parsed) return null;
  if (!parsed.tweetId) {
    parsed.tweetId = `t${contentHash([parsed.handle, parsed.text]).slice(0, 18)}`;
    parsed.synthetic = true;
  }
  parsed.key = parsed.tweetId;
  return parsed;
}

function applySnapshot(next) {
  const prevHits = snapshot?.hitLog?.length || 0;
  snapshot = next || null;
  if ((snapshot?.hitLog?.length || 0) < prevHits) reportedHits.clear();
  lang = resolveLang(snapshot?.settings?.language, navigator.language);
  scan();
}

async function loadSnapshot() {
  const got = await chrome.storage.local.get("xsl");
  if (!got.xsl) {
    await send({ type: "ENSURE" });
    const again = await chrome.storage.local.get("xsl");
    applySnapshot(again.xsl);
    return;
  }
  applySnapshot(got.xsl);
}

function indexOf(userId) {
  return snapshot?.index?.[userId] || null;
}

function tweetTags(tweetId) {
  return snapshot?.tweetTags?.[tweetId]?.tags || [];
}

function stop(event) {
  event.preventDefault();
  event.stopPropagation();
}

function chromeFor(meta, record) {
  const chrome = timelineChrome(
    {
      whitelist: !!record?.whitelist,
      followed: record?.followed,
      counts: record?.counts || {},
    },
    { lang, followed: meta?.followed },
  );
  const protect = chrome.protect ? { ...chrome.protect, title: t(chrome.protect.titleKey) } : null;
  const chips = chrome.chips.map((chip) => ({
    ...chip,
    title: chip.more ? t("chipMore", { count: chip.count }) : t("chipOpen"),
  }));
  return {
    signature: {
      protect: protect ? `${protect.reason}:${protect.text}` : "",
      chips: chips.map((chip) => `${chip.text}:${chip.name}`).join(","),
      lang,
    },
    protect,
    chips,
  };
}

function outsideQuote(article, node) {
  const quote = article.querySelector('[data-testid="quoteTweet"]');
  return !quote || !quote.contains(node);
}

function syncNameHost(article, model) {
  const block = [...article.querySelectorAll('[data-testid="User-Name"]')].find((node) => outsideQuote(article, node));
  const existing = [...article.querySelectorAll("[data-xsl-name]")];
  let host = existing.find((node) => outsideQuote(article, node)) || null;
  for (const extra of existing) {
    if (extra !== host) extra.remove();
  }
  const visible = !!(model.protect || model.chips.length);
  if (!visible || !block?.parentElement) {
    host?.remove();
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.dataset.xslName = "1";
  }
  if (host.parentElement !== block.parentElement || host.previousElementSibling !== block) {
    block.insertAdjacentElement("afterend", host);
  }
  mountInline(host, model, { onChip: () => openTags(article) });
}

function placeholder(article, meta, record) {
  let node = article.querySelector(":scope > [data-xsl-placeholder]");
  if (!node) {
    node = document.createElement("div");
    node.dataset.xslPlaceholder = "1";
    node.dataset.xslKeep = "1";
    article.prepend(node);
  }
  const chrome = chromeFor(meta, record);
  const bits = chrome.chips.map((chip) => chip.text);
  const signature = `${lang}|${meta.handle}|${chrome.protect?.text || ""}|${bits.join(",")}`;
  if (node.dataset.sig === signature) return;
  node.dataset.sig = signature;
  node.replaceChildren();
  const title = document.createElement("div");
  title.className = "xsl-ph-title";
  title.textContent = t("collapsed", { handle: meta.handle });
  if (chrome.protect) {
    const badge = document.createElement("span");
    badge.className = "xsl-protect";
    badge.textContent = chrome.protect.text;
    badge.title = chrome.protect.title;
    title.append(document.createTextNode(" "), badge);
  }
  const detail = document.createElement("div");
  detail.className = "xsl-ph-meta";
  detail.textContent = bits.join(" · ") || t("hiddenOn");
  const show = document.createElement("button");
  show.type = "button";
  show.textContent = t("showOnce");
  show.addEventListener("click", (event) => {
    stop(event);
    expanded.add(meta.key);
    delete article.dataset.xslCollapsed;
    node.remove();
  });
  const unhide = document.createElement("button");
  unhide.type = "button";
  unhide.textContent = t("unhide");
  unhide.addEventListener("click", async (event) => {
    stop(event);
    await send({ type: "SET_HIDDEN", userId: meta.userId, handle: meta.handle, hidden: false });
    toast(overlay, t("hiddenSaved"));
  });
  for (const button of [show, unhide]) {
    button.addEventListener("pointerdown", stop);
  }
  node.append(title, detail, show, unhide);
}

function syncHidden(article, meta) {
  const record = indexOf(meta.userId);
  const hide = !!(record && record.hidden) && !expanded.has(meta.key);
  if (hide) {
    article.dataset.xslCollapsed = "1";
    placeholder(article, meta, record);
  } else if (article.dataset.xslCollapsed) {
    delete article.dataset.xslCollapsed;
    article.querySelector(":scope > [data-xsl-placeholder]")?.remove();
  }
}

function suspectFor(meta) {
  const settings = snapshot?.settings;
  if (!settings?.rulesEnabled) return null;
  const matched = matchRules(settings.keywordPacks, { text: meta.text, handle: meta.handle, bio: meta.bio });
  if (!matched.suspect) return null;
  return matched;
}

function selectedIn(article) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const node = sel.anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el || !article.contains(el)) return "";
  return sel.toString();
}

function maybeRecordHits(meta, matched) {
  if (!snapshot?.settings?.hitHistory || !matched?.reasons?.length) return;
  const known = new Set((snapshot.hitLog || []).map((item) => `${item.tweetId}|${item.packId}|${item.pattern}`));
  const fresh = [];
  for (const reason of matched.reasons) {
    const key = `${meta.tweetId}|${reason.packId}|${reason.pattern}`;
    if (known.has(key) || reportedHits.has(key)) continue;
    reportedHits.add(key);
    fresh.push({
      packId: reason.packId,
      packName: reason.packName,
      pattern: reason.pattern,
      target: reason.target,
      handle: meta.handle,
      tweetId: meta.tweetId,
      snippet: meta.text,
    });
  }
  if (!fresh.length) return;
  void send({ type: "RECORD_HITS", hits: fresh }).then((result) => {
    if (result?.ok) return;
    for (const reason of fresh) reportedHits.delete(`${meta.tweetId}|${reason.packId}|${reason.pattern}`);
  });
}

function rememberFollow(meta) {
  const record = indexOf(meta.userId);
  if (!record || meta.followed == null || record.followed === meta.followed) return;
  const key = `${meta.userId}:${meta.followed}`;
  if (seenSent.has(key)) return;
  seenSent.add(key);
  send({
    type: "SEEN",
    userId: meta.userId,
    handle: meta.handle,
    displayName: meta.displayName,
    followed: meta.followed,
  });
}

async function withOverlay(task) {
  overlayBusy = true;
  try {
    return await task();
  } finally {
    overlayBusy = false;
  }
}

async function afterThreshold(result, meta) {
  const threshold = result.threshold;
  if (!threshold?.crossed) return;
  const tag = tagLabel(threshold.tag, lang);
  if (threshold.skipped === "whitelist") {
    toast(overlay, t("skipWhitelist", { handle: meta.handle }));
    return;
  }
  if (threshold.mode === "prompt-only") {
    toast(overlay, t("promptOnly", { handle: meta.handle, tag, count: threshold.count, n: threshold.n }));
    return;
  }
  if (threshold.mode === "auto") {
    const applied = await send({
      type: "APPLY_ACTIONS",
      userId: meta.userId,
      handle: meta.handle,
      hide: threshold.suggest.hide,
      mute: threshold.suggest.mute,
      block: threshold.suggest.block,
      reason: "threshold-auto",
    });
    const actions = (applied.done || []).map((name) => {
      if (name === "hide") return t("hideAction");
      if (name === "mute") return t("muteQueued");
      if (name === "block") return t("blockQueued");
      return t(name);
    }).join(lang === "zh" ? "、" : ", ");
    toast(overlay, t("autoDone", { handle: meta.handle, actions: actions || t("justRecord") }));
    if ((applied.done || []).some((name) => name === "mute" || name === "block")) pump();
    return;
  }
  const settings = snapshot?.settings || {};
  const choice = await withOverlay(() => openChoice(overlay, {
    title: t("thresholdTitle", { tag }),
    body: t("thresholdBody", { handle: meta.handle, tag, count: threshold.count, n: threshold.n }),
    warning: threshold.followed === true
      ? t("thresholdWarnFollow")
      : threshold.followed == null
        ? t("thresholdWarnUnknown")
        : "",
    checks: [
      { id: "hide", label: t("hideLocal"), checked: !!threshold.suggest.hide, hint: "" },
      {
        id: "mute",
        label: t("mute"),
        checked: !!threshold.suggest.mute,
        disabled: !settings.enablePlatformActions,
        hint: t("muteHint"),
      },
      {
        id: "block",
        label: t("block"),
        checked: !!threshold.suggest.block,
        disabled: !settings.enablePlatformActions,
        hint: t("blockHint"),
      },
    ],
    confirm: t("actConfirm"),
    neutral: t("justRecord"),
    cancel: t("cancel"),
  }));
  if (!choice?.confirm) return;
  const applied = await send({
    type: "APPLY_ACTIONS",
    userId: meta.userId,
    handle: meta.handle,
    hide: !!choice.checks.hide,
    mute: !!choice.checks.mute,
    block: !!choice.checks.block,
    reason: "threshold-confirm",
  });
  if (!applied.ok && applied.error === "platform-off") toast(overlay, t("platformOff"));
  else if (choice.checks.mute || choice.checks.block) toast(overlay, t("queuedConfirm", { handle: meta.handle }));
  else toast(overlay, t("confirmed", { handle: meta.handle }));
  if (choice.checks.mute || choice.checks.block) pump();
}

async function markTag(meta, tag, source) {
  const clean = canonicalTag(tag);
  if (!clean) {
    toast(overlay, t("bad-tag"));
    return;
  }
  const result = await send({
    type: "MARK",
    userId: meta.userId,
    handle: meta.handle,
    displayName: meta.displayName,
    tweetId: meta.tweetId,
    url: meta.url,
    textSnippet: meta.text,
    tag: clean,
    followed: meta.followed,
    source,
  });
  if (!result?.ok) {
    toast(overlay, t(result?.error || "error"));
    return;
  }
  if (result.already) {
    toast(overlay, t("already", { tag: tagLabel(clean, lang) }));
    return;
  }
  const count = result.account?.tags?.find((row) => row.name === clean)?.count || result.threshold?.count || 1;
  toast(overlay, t("marked", { handle: meta.handle, tag: tagLabel(clean, lang), count }));
  await afterThreshold(result, meta);
}

async function toggleTag(meta, tag) {
  const clean = canonicalTag(tag);
  if (tweetTags(meta.tweetId).includes(clean)) {
    const result = await send({ type: "UNMARK", tweetId: meta.tweetId, tag: clean });
    if (!result?.ok) toast(overlay, t(result?.error || "error"));
    else toast(overlay, t("undone"));
    return;
  }
  await markTag(meta, clean, "user");
}

async function openTags(article) {
  const meta = describe(article);
  if (!meta) {
    toast(overlay, t("no-handle"));
    return;
  }
  const record = indexOf(meta.userId);
  const settings = snapshot?.settings || {};
  const names = ["Spam", "Marketing", ...(settings.customTags || [])];
  const here = new Set(tweetTags(meta.tweetId));
  const chrome = chromeFor(meta, record);
  const action = await withOverlay(() => openPicker(overlay, {
    title: `@${meta.handle}`,
    subtitle: meta.displayName || "",
    note: chrome.protect?.title || "",
    tags: names.map((name) => ({
      name,
      label: tagLabel(name, lang),
      count: record?.counts?.[name] || 0,
      on: here.has(name),
    })),
    placeholder: t("tagPh"),
    add: t("addTag"),
    whitelist: !!record?.whitelist,
    whitelistLabel: t("whitelistToggle"),
    hidden: !!record?.hidden,
    hideLabel: record?.hidden ? t("unhide") : t("hide"),
    queueMute: settings.enablePlatformActions ? t("queueMute") : "",
    queueBlock: settings.enablePlatformActions ? t("queueBlock") : "",
    cancel: t("cancel"),
    keyword: {
      word: selectedIn(article),
      packs: (settings.keywordPacks || []).map((pack) => ({ id: pack.id, name: pack.name })),
      packId: (settings.keywordPacks || []).find((pack) => pack.enabled !== false)?.id
        || settings.keywordPacks?.[0]?.id
        || "",
      note: t("addKeywordNote"),
      placeholder: t("addKeywordPh"),
      add: t("addKeywordBtn"),
      packLabel: t("addKeywordPack"),
    },
  }));
  if (!action) return;
  if (action.type === "keyword") {
    const saved = await send({
      type: "ADD_KEYWORD",
      packId: action.packId,
      value: action.value,
      target: "text",
    });
    if (!saved?.ok) toast(overlay, t(saved?.error || "error"));
    else if (saved.duplicate) toast(overlay, t("keywordDuplicate", { word: saved.value, pack: saved.packName }));
    else toast(overlay, t("keywordAdded", { word: saved.value, pack: saved.packName }));
    return;
  }
  if (action.type === "queue") {
    const queued = await send({
      type: "APPLY_ACTIONS",
      userId: meta.userId,
      handle: meta.handle,
      mute: action.action === "mute",
      block: action.action === "block",
      reason: "manual",
    });
    if (!queued?.ok) toast(overlay, t(queued?.error || "platform-off"));
    else toast(overlay, t("queued", { action: t(action.action), handle: meta.handle }));
    if (queued?.ok) pump();
    return;
  }
  if (action.type === "toggle") await toggleTag(meta, action.tag);
  if (action.type === "add") {
    const added = await send({ type: "ADD_CUSTOM_TAG", name: action.name });
    if (!added.ok) {
      toast(overlay, t(added.error || "bad-tag"));
      return;
    }
    await markTag(meta, added.tag, "user");
  }
  if (action.type === "whitelist") {
    const saved = await send({
      type: "SET_WHITELIST",
      userId: meta.userId,
      handle: meta.handle,
      displayName: meta.displayName,
      whitelist: action.value,
    });
    toast(overlay, saved.ok ? t("whitelistSaved") : t(saved.error || "error"));
  }
  if (action.type === "hide") {
    const saved = await send({
      type: "SET_HIDDEN",
      userId: meta.userId,
      handle: meta.handle,
      hidden: action.hidden,
    });
    toast(overlay, saved.ok ? t("hiddenSaved") : t(saved.error || "error"));
  }
}

async function confirmRule(article) {
  const meta = describe(article);
  const matched = meta && suspectFor(meta);
  if (!matched) return;
  const reason = matched.reasons.find((item) => item.suggestTag) || matched.reasons[0];
  if (!reason?.suggestTag) {
    await openTags(article);
    return;
  }
  const tag = reason.suggestTag;
  const choice = await withOverlay(() => openChoice(overlay, {
    title: t("ruleTitle"),
    body: t("ruleBody", { pack: reason.packName, tag: tagLabel(tag, lang) }),
    checks: [],
    confirm: t("ruleMark"),
    cancel: t("cancel"),
  }));
  if (choice?.confirm) await markTag(meta, tag, "rule");
}

async function askAi(meta) {
  // One in-flight cap, one ask per tweet id, and the service worker caches by content hash.
  // Distilling keywords does not call the model again.
  if (aiInflight >= 2) return;
  aiInflight += 1;
  aiAsked.add(meta.tweetId);
  try {
    const result = await send({
      type: "SUGGEST",
      handle: meta.handle,
      text: meta.text,
      bio: meta.bio,
    });
    aiResults.set(meta.tweetId, result);
    scan();
    if (!result?.ok) toast(overlay, t(result?.error || "ai-network", { status: result?.status || "" }));
  } finally {
    aiInflight -= 1;
  }
}

async function confirmAi(article) {
  const meta = describe(article);
  const result = meta && aiResults.get(meta.tweetId);
  if (!result?.label) {
    if (result?.verdict === "none") toast(overlay, t("aiNone"));
    return;
  }
  const settings = snapshot?.settings || {};
  const distilled = distillSuggestion({
    label: result.label,
    reason: result.reason,
    text: meta.text,
    bio: meta.bio,
    handle: meta.handle,
    keywords: result.keywords,
  });
  const packs = (settings.keywordPacks || []).map((pack) => ({ id: pack.id, name: pack.name }));
  const choice = await withOverlay(() => openAiSuggest(overlay, {
    title: t("aiChip", { tag: tagLabel(result.label, lang) }),
    body: result.reason || t("subtitle"),
    note: distilled.rules.length ? t("distillNote") : "",
    rules: distilled.rules.map((rule) => ({
      type: rule.type,
      target: rule.target,
      value: rule.value,
      label: `${t(rule.target)} · ${rule.value}`,
    })),
    packs,
    packId: suggestPackId(settings.keywordPacks, result.label),
    packLabel: t("addKeywordPack"),
    save: t("saveAsRule"),
    confirm: t("ruleMark"),
    cancel: t("cancel"),
  }));
  if (!choice) return;
  if (choice.save) {
    const saved = await send({
      type: "ADD_DISTILLED",
      packId: choice.packId,
      rules: choice.rules,
      label: result.label,
      reason: result.reason,
      text: meta.text,
      bio: meta.bio,
      handle: meta.handle,
      keywords: result.keywords,
    });
    if (!saved?.ok) toast(overlay, t(saved?.error || "empty-keyword"));
    else if (!saved.count && saved.duplicate) toast(overlay, t("distillDuplicate", { pack: saved.packName }));
    else if (saved.duplicates?.length) toast(overlay, t("distillPartial", { count: saved.count, dup: saved.duplicates.length, pack: saved.packName }));
    else toast(overlay, t("distillAdded", { count: saved.count, pack: saved.packName }));
    return;
  }
  if (choice.confirm) await markTag(meta, result.label, "ai");
}

function render(article, meta) {
  let host = article.querySelector(":scope > [data-xsl-host]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.xslHost = "1";
    const anchor = [...article.querySelectorAll('[role="group"]')].find((node) => !node.closest('[data-testid="quoteTweet"]'));
    if (anchor?.parentElement === article) article.insertBefore(host, anchor);
    else article.append(host);
  }
  const record = indexOf(meta.userId);
  const chrome = chromeFor(meta, record);
  const matched = suspectFor(meta);
  if (matched) maybeRecordHits(meta, matched);
  const ai = aiResults.get(meta.tweetId);
  const settings = snapshot?.settings;
  const shortcuts = settings?.shortcuts || {};
  if (matched && settings?.ai?.enabled && settings.ai.autoSuggestSuspects && settings.ai.hasApiKey && !aiAsked.has(meta.tweetId)) {
    askAi(meta);
  }
  const model = {
    ...chrome,
    signature: {
      ...chrome.signature,
      suspect: matched?.reasons?.map((reason) => reason.packId).join(",") || "",
      ai: ai ? `${ai.label || ai.verdict}:${ai.reason || ""}` : "",
      ask: !!settings?.ai?.enabled,
    },
    markLabel: t("mark"),
    shortcutTitle: `${shortcuts.spam || "Alt+S"} · ${shortcuts.marketing || "Alt+M"} · ${shortcuts.picker || "Alt+T"}`,
    suspect: matched ? {
      label: matched.reasons.length > 1 ? t("suspectCount", { count: matched.reasons.length }) : t("suspect"),
      title: matched.reasons.map((reason) => reason.packName).join(" · "),
    } : null,
    ai: ai?.ok ? {
      label: ai.label ? t("aiChip", { tag: tagLabel(ai.label, lang) }) : t("aiNone"),
      title: ai.reason || "",
    } : null,
    askAi: settings?.ai?.enabled && !ai?.ok ? t("aiSuggest") : "",
  };
  mountBar(host, model, {
    onPicker: () => openTags(article),
    onChip: () => openTags(article),
    onSuspect: () => confirmRule(article),
    onAi: () => confirmAi(article),
    onAsk: () => askAi(meta),
  });
  syncNameHost(article, chrome);
  article.dataset.xslHandle = meta.handle.toLowerCase();
  article.dataset.xslUser = meta.userId;
  syncHidden(article, meta);
  rememberFollow(meta);
}

function scan() {
  if (!document.body) return;
  const articles = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
  for (const article of articles) {
    const meta = describe(article);
    if (!meta) continue;
    render(article, meta);
  }
}

function schedule() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 120);
}

function ourMutation(record) {
  const node = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
  return !!node?.closest?.("[data-xsl-host], [data-xsl-name], [data-xsl-overlay], [data-xsl-placeholder]");
}

function activeArticle() {
  const focused = document.activeElement?.closest?.('article[data-testid="tweet"], article[role="article"]');
  if (focused) return focused;
  if (hovered && document.contains(hovered)) return hovered;
  const mid = window.innerHeight / 2;
  let best = null;
  let distance = Infinity;
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    const rect = article.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const delta = Math.abs(rect.top + rect.height / 2 - mid);
    if (delta < distance) {
      distance = delta;
      best = article;
    }
  }
  return best;
}

function typing(event) {
  if (overlayBusy) return true;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  return path.some((node) => isTypingTarget(node));
}

async function onKey(event) {
  const shortcuts = snapshot?.settings?.shortcuts;
  if (!shortcuts || typing(event)) return;
  const article = activeArticle();
  if (!article) return;
  const meta = () => describe(article);
  if (eventMatchesShortcut(event, shortcuts.spam)) {
    stop(event);
    const parsed = meta();
    if (parsed) await markTag(parsed, "Spam", "shortcut");
  } else if (eventMatchesShortcut(event, shortcuts.marketing)) {
    stop(event);
    const parsed = meta();
    if (parsed) await markTag(parsed, "Marketing", "shortcut");
  } else if (eventMatchesShortcut(event, shortcuts.picker)) {
    stop(event);
    await openTags(article);
  }
}

function visibleQueueHandles() {
  const handles = [];
  for (const article of document.querySelectorAll("article[data-xsl-handle]")) {
    const caret = article.querySelector('[data-testid="caret"]')
      || article.querySelector('button[aria-label="More"], button[aria-label="更多"]');
    if (!caret || !article.dataset.xslHandle) continue;
    handles.push(article.dataset.xslHandle);
    if (handles.length >= 80) break;
  }
  return handles;
}

function findArticle(handle) {
  const want = String(handle || "").toLowerCase();
  const matches = [...document.querySelectorAll("article[data-xsl-handle]")].filter((article) => article.dataset.xslHandle === want);
  const visible = matches.find((article) => article.dataset.xslCollapsed !== "1" && article.querySelector('[data-testid="caret"]'));
  const any = visible || matches.find((article) => article.querySelector('[data-testid="caret"]'));
  if (any && any.dataset.xslCollapsed === "1") {
    delete any.dataset.xslCollapsed;
    any.querySelector(":scope > [data-xsl-placeholder]")?.remove();
  }
  return any || null;
}

async function pump() {
  if (pumping || overlayBusy || document.visibilityState === "hidden") return;
  pumping = true;
  try {
    const peek = await send({ type: "PEEK_ACTION", handles: visibleQueueHandles() });
    if (peek?.hold === "daily-cap") {
      const day = snapshot?.rate?.day || "";
      if (capNotified !== day) {
        capNotified = day || new Date().toDateString();
        toast(overlay, t("daily-cap"));
      }
      return;
    }
    if (peek?.hold === "backoff") {
      const until = snapshot?.rate?.backoffUntil || 0;
      if (until && backoffNotified !== until) {
        backoffNotified = until;
        toast(overlay, t("rateLimited"));
      }
      return;
    }
    if (peek?.hold || !peek?.item) return;
    const article = findArticle(peek.item.handle);
    if (!article) return;
    const begun = await send({ type: "BEGIN_ACTION", id: peek.item.id });
    if (!begun?.ok) {
      if (begun?.error === "daily-cap" && capNotified !== (snapshot?.rate?.day || "")) {
        capNotified = snapshot?.rate?.day || new Date().toDateString();
        toast(overlay, t("daily-cap"));
      }
      if (begun?.error === "backoff") toast(overlay, t("rateLimited"));
      return;
    }
    try {
      await performPlatformAction(article, begun.item);
      await send({ type: "FINISH_ACTION", id: begun.item.id, ok: true });
      toast(overlay, t("actionOk", { action: t(begun.item.type), handle: begun.item.handle }));
    } catch (error) {
      const detail = `${error?.detail || ""} ${error?.message || ""}`;
      const rateLimited = error?.rateLimited === true || isRateLimitSignal(detail);
      const finished = await send({
        type: "FINISH_ACTION",
        id: begun.item.id,
        ok: false,
        error: rateLimited ? (error?.detail || error?.message || "rate-limit") : (error?.message || "no-item"),
        rateLimited,
      });
      if (rateLimited && finished?.backoffUntil) backoffNotified = finished.backoffUntil;
      toast(overlay, rateLimited ? t("rateLimited") : t("actionFail", { error: t(error?.message || "no-item") }));
    }
  } finally {
    pumping = false;
  }
}

function onKeywordResult(message) {
  if (!message?.ok) toast(overlay, t(message?.error || "error"));
  else if (message.duplicate) toast(overlay, t("keywordDuplicate", { word: message.value, pack: message.packName }));
  else toast(overlay, t("keywordAdded", { word: message.value, pack: message.packName }));
}

export async function start() {
  dict = await loadDict();
  overlay = createOverlay();
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "KEYWORD_RESULT") return;
    onKeywordResult(message);
    sendResponse({ ok: true });
  });
  await loadSnapshot();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.xsl) applySnapshot(changes.xsl.newValue);
  });
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !ourMutation(record))) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("mouseover", (event) => {
    const article = event.target?.closest?.('article[data-testid="tweet"], article[role="article"]');
    if (article) hovered = article;
  }, true);
  document.addEventListener("focusin", (event) => {
    const article = event.target?.closest?.('article[data-testid="tweet"], article[role="article"]');
    if (article) hovered = article;
  }, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("popstate", schedule);
  setInterval(() => {
    scan();
    pump();
  }, 2500);
  scan();
}
