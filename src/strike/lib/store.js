/**
 * Single writer for chrome.storage.local.
 * The API key lives in xslSecret, never in the xsl blob the content script reads.
 */

import {
  allowedAiEndpoint,
  applyActions,
  applyMark,
  applyUndo,
  applyUnmark,
  addCustomTag,
  beginAction,
  cancelAction,
  clearQueue,
  clearTag,
  contentHash,
  deleteAccount,
  describeUndo,
  enqueue,
  exportData,
  finishAction,
  freshState,
  importData,
  interpretAiLabel,
  normalizeState,
  peekAction,
  processorHold,
  pruneAiCache,
  publicAccount,
  queueDashboard,
  removeCustomTag,
  restorePacks,
  retryAction,
  retryFailed,
  sanitizeHandle,
  setQueuePaused,
  sanitizeSettings,
  searchLedger,
  seenAccount,
  setHidden,
  setWhitelist,
  snippet,
  statsOf,
  toPublicSettings,
} from "./pure.js";

const STATE_KEY = "xsl";
const SECRET_KEY = "xslSecret";

let chain = Promise.resolve();

function locked(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

async function readRaw() {
  const got = await chrome.storage.local.get([STATE_KEY, SECRET_KEY]);
  const state = normalizeState(got[STATE_KEY]);
  const apiKey = got[SECRET_KEY]?.apiKey || "";
  state.settings.ai.apiKey = apiKey;
  state.settings.ai.hasApiKey = !!apiKey;
  return state;
}

async function writeRaw(state) {
  const apiKey = state.settings.ai.apiKey || "";
  const copy = structuredClone(state);
  copy.settings.ai.apiKey = "";
  copy.settings.ai.hasApiKey = !!apiKey;
  await chrome.storage.local.set({
    [STATE_KEY]: copy,
    [SECRET_KEY]: { apiKey },
  });
}

function isExtensionPage(sender) {
  if (sender?.internal) return true;
  const url = sender?.url || "";
  try {
    return url.startsWith(chrome.runtime.getURL(""));
  } catch {
    return false;
  }
}

function editorOnly(sender) {
  if (isExtensionPage(sender)) return null;
  return { ok: false, error: "forbidden" };
}

async function suggest(input) {
  const prepared = await locked(async () => {
    const state = await readRaw();
    if (!state.settings.ai.enabled) return { ok: false, error: "ai-off" };
    if (!state.settings.ai.apiKey) return { ok: false, error: "no-key" };
    if (!allowedAiEndpoint(state.settings.ai.endpoint)) return { ok: false, error: "bad-endpoint" };
    const handle = sanitizeHandle(input.handle);
    const text = snippet(input.text, 500);
    const bio = snippet(input.bio, 280);
    const hash = contentHash([handle, bio, text]);
    const cached = state.aiCache[hash];
    if (cached) {
      return { ok: true, cached: true, label: cached.label || null, reason: cached.reason || "", verdict: cached.verdict || "none" };
    }
    return {
      ok: true,
      pending: true,
      hash,
      handle,
      text,
      bio,
      endpoint: state.settings.ai.endpoint,
      model: state.settings.ai.model,
      apiKey: state.settings.ai.apiKey,
    };
  });
  if (!prepared.pending) return prepared;

  let response;
  try {
    response = await fetch(prepared.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${prepared.apiKey}`,
      },
      body: JSON.stringify({
        model: prepared.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "Classify one X post for a personal ledger. Reply with JSON only: {\"label\":\"spam\"|\"marketing\"|\"none\",\"reason\":\"short\"}. spam = scams, phishing, engagement bait, crypto theft, porn spam. marketing = promotions, lead-gen, sales, affiliate bait. none = everything else. Do not tell the user to block or mute anyone.",
          },
          {
            role: "user",
            content: `handle: @${prepared.handle}\nbio: ${prepared.bio}\ntext: ${prepared.text}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, error: "ai-network" };
  }
  if (!response.ok) return { ok: false, error: "ai-http", status: response.status };
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return { ok: false, error: "ai-network" };
  }
  let content = raw.slice(0, 4000);
  try {
    const data = JSON.parse(raw);
    content = data?.choices?.[0]?.message?.content || content;
  } catch {
    /* some proxies return the message text directly */
  }
  const parsed = interpretAiLabel(content);
  if (parsed.verdict === "invalid") return { ok: false, error: "bad-ai-response" };
  await locked(async () => {
    const state = await readRaw();
    state.aiCache[prepared.hash] = { label: parsed.label, reason: parsed.reason, verdict: parsed.verdict, at: Date.now() };
    state.aiCache = pruneAiCache(state.aiCache);
    await writeRaw(state);
  });
  return { ok: true, cached: false, label: parsed.label, reason: parsed.reason, verdict: parsed.verdict };
}

export function dispatch(message, sender = {}) {
  const type = message?.type;
  if (!type) return Promise.resolve({ ok: false, error: "bad-message" });
  if (type === "SUGGEST") return suggest(message);
  return locked(async () => {
    const now = Date.now();
    const state = await readRaw();
    let result;
    switch (type) {
      case "ENSURE":
        result = { ok: true };
        break;
      case "GET_PUBLIC":
        result = {
          ok: true,
          index: state.index,
          tweetTags: state.tweetTags,
          settings: toPublicSettings(state.settings),
          stats: statsOf(state, now),
          undo: describeUndo(state.undo[0]),
        };
        break;
      case "GET_EDITOR": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = {
          ok: true,
          settings: state.settings,
          stats: statsOf(state, now),
          ledger: searchLedger(state, message.query || "", message.limit || 200),
          queue: state.queue,
          dashboard: queueDashboard(state, now),
          log: state.log.slice(0, 30),
          undo: describeUndo(state.undo[0]),
        };
        break;
      }
      case "SEARCH":
        result = { ok: true, ledger: searchLedger(state, message.query || "", message.limit || 40) };
        break;
      case "MARK":
        result = applyMark(state, message, now);
        break;
      case "UNMARK":
        result = applyUnmark(state, message, now);
        break;
      case "SEEN":
        result = seenAccount(state, message, now);
        break;
      case "SET_WHITELIST":
        result = setWhitelist(state, message, now);
        break;
      case "SET_HIDDEN":
        result = setHidden(state, message, now);
        break;
      case "APPLY_ACTIONS":
        result = applyActions(state, message, now);
        break;
      case "UNDO":
        result = applyUndo(state, now);
        break;
      case "PEEK_UNDO":
        result = { ok: true, undo: describeUndo(state.undo[0]) };
        break;
      case "UPDATE_SETTINGS": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        if (message.patch?.ai && message.patch.ai.apiKey === undefined && state.settings.ai.apiKey) {
          message.patch.ai.apiKey = state.settings.ai.apiKey;
        }
        const sanitized = sanitizeSettings(state.settings, message.patch || {});
        state.settings = sanitized.settings;
        result = { ok: true, warnings: sanitized.warnings, settings: state.settings };
        break;
      }
      case "ADD_CUSTOM_TAG":
        result = addCustomTag(state, message.name);
        break;
      case "REMOVE_CUSTOM_TAG": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = removeCustomTag(state, message.name);
        break;
      }
      case "RESTORE_PACKS": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        restorePacks(state);
        result = { ok: true, keywordPacks: state.settings.keywordPacks };
        break;
      }
      case "PEEK_ACTION": {
        const holdInfo = processorHold(state, now);
        const handles = Array.isArray(message.handles) ? message.handles.slice(0, 80) : null;
        const item = holdInfo.hold ? null : peekAction(state, now, handles ? { handles } : {});
        result = {
          ok: true,
          item,
          changed: !!holdInfo.changed,
          hold: holdInfo.hold,
          wait: holdInfo.wait || 0,
        };
        break;
      }
      case "BEGIN_ACTION":
        result = beginAction(state, message.id, now);
        break;
      case "FINISH_ACTION":
        result = finishAction(state, message, now);
        break;
      case "RETRY_ACTION": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = retryAction(state, message.id);
        break;
      }
      case "RETRY_FAILED": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = retryFailed(state);
        break;
      }
      case "SET_QUEUE_PAUSED": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = setQueuePaused(state, !!message.paused, now);
        break;
      }
      case "CLEAR_QUEUE": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        const scope = message.scope === "failed" || message.scope === "all" ? message.scope : "pending";
        result = clearQueue(state, scope);
        break;
      }
      case "CANCEL_ACTION": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = cancelAction(state, message.id);
        break;
      }
      case "EXPORT": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = { ok: true, data: exportData(state, { includeSecrets: !!message.includeSecrets }) };
        break;
      }
      case "IMPORT": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = importData(state, message.payload, message, now);
        break;
      }
      case "DELETE_ACCOUNT": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = deleteAccount(state, message.userId, now);
        break;
      }
      case "CLEAR_TAG": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = clearTag(state, message, now);
        break;
      }
      case "RESET_ALL": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        if (message.confirm !== "RESET") return { ok: false, error: "confirm" };
        const blank = freshState(now);
        await writeRaw(blank);
        return { ok: true, settings: blank.settings, stats: statsOf(blank, now) };
      }
      case "STATS":
        result = { ok: true, stats: statsOf(state, now), undo: describeUndo(state.undo[0]) };
        break;
      default:
        return { ok: false, error: "unknown" };
    }
    const reads = new Set(["ENSURE", "GET_PUBLIC", "GET_EDITOR", "SEARCH", "PEEK_UNDO", "STATS"]);
    const peekChanged = type === "PEEK_ACTION" && result?.changed;
    if (type === "PEEK_ACTION" && !peekChanged) return result;
    const beginWrites = type === "BEGIN_ACTION" && result?.ok === false && (result?.expired || result?.changed);
    if (result?.ok === false && !beginWrites) return result;
    if (reads.has(type)) return result;
    await writeRaw(state);
    if (result && typeof result === "object" && result.settings) {
      const forPage = isExtensionPage(sender);
      result = {
        ...result,
        settings: forPage ? state.settings : toPublicSettings(state.settings),
      };
    }
    if (type === "GET_EDITOR") result.settings = state.settings;
    return result;
  });
}

export const __test = { readRaw, writeRaw, publicAccount };
