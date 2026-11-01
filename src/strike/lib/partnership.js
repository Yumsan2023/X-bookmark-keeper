/**
 * Hover-card partnership ratio.
 *
 * Read-only. The only network operations are UserByScreenName and UserTweets
 * (GET). This module does not mute, block, enqueue, or write the strike ledger.
 * A missing disclosure field becomes "unavailable", never a fabricated 0%.
 */

import { libraryMarksForAccount } from "./author-flags.js";
import { isReservedHandle } from "./domparse.js";
import { canonicalTag, sanitizeHandle, sanitizeName, tagLabel } from "./pure.js";

export const PARTNERSHIP_WINDOW_DAYS = 30;
export const PARTNERSHIP_WINDOW_MS = PARTNERSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const PARTNERSHIP_PAGE_CAP = 3;
export const PARTNERSHIP_PAGE_SIZE = 40;
export const PARTNERSHIP_PAGE_GAP_MS = 350;
export const PARTNERSHIP_HOURLY_CAP = 8;
export const PARTNERSHIP_MIN_GAP_MS = 3000;
export const PARTNERSHIP_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const PARTNERSHIP_CACHE_KEY = "xslHoverCache";
/** Documented allow-list. Hover stats must not grow past these read operations. */
export const PARTNERSHIP_READ_OPS = Object.freeze(["UserByScreenName", "UserTweets"]);

const TWITTER_EPOCH = 1288834974657n;
const CACHE_ENTRY_CAP = 40;
const CACHE_ID_CAP = 80;

export function emptyPartnershipCache() {
  return { v: 1, entries: {}, ids: {}, budget: { hourStart: 0, count: 0, nextAllowed: 0 } };
}

export function normalizePartnershipCache(raw) {
  if (!raw || raw.v !== 1 || typeof raw !== "object") return emptyPartnershipCache();
  const entries = raw.entries && typeof raw.entries === "object" && !Array.isArray(raw.entries) ? { ...raw.entries } : {};
  const ids = {};
  if (raw.ids && typeof raw.ids === "object" && !Array.isArray(raw.ids)) {
    for (const [key, value] of Object.entries(raw.ids)) {
      const handle = sanitizeHandle(key);
      if (!handle || !/^\d+$/.test(String(value || ""))) continue;
      ids[handle.toLowerCase()] = String(value);
    }
  }
  return {
    v: 1,
    entries,
    ids,
    budget: {
      hourStart: Number(raw.budget?.hourStart) || 0,
      count: Math.max(0, Math.floor(Number(raw.budget?.count) || 0)),
      nextAllowed: Number(raw.budget?.nextAllowed) || 0,
    },
  };
}

export function partnershipWindowStart(now) {
  return now - PARTNERSHIP_WINDOW_MS;
}

export function partnershipCacheKey(handle, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${String(handle || "").toLowerCase()}@${day}`;
}

export function isPaidPartnershipLabel(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || s.length > 40) return false;
  return /^(paid partnership|paid partner|付费合作|付費合作)$/i.test(s);
}

export function heuristicPaidText(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return false;
  const first = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  if (!first || first.length > 40) return false;
  if (isPaidPartnershipLabel(first)) return true;
  if (/^(#ad|＃ad)\b/i.test(first)) return true;
  if (/^(赞助合作|贊助合作|广告合作|廣告合作)$/.test(first)) return true;
  return false;
}

function snowflakeToMs(id) {
  try {
    if (!/^\d+$/.test(String(id || ""))) return 0;
    return Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
  } catch {
    return 0;
  }
}

function createdAtMs(tweet) {
  const s = tweet?.legacy?.created_at;
  if (s) {
    const t = Date.parse(s);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return snowflakeToMs(tweet?.rest_id || tweet?.legacy?.id_str);
}

function tweetUserId(tweet) {
  const user = tweet?.core?.user_results?.result ?? {};
  return String(user.rest_id || user.legacy?.id_str || tweet?.legacy?.user_id_str || "");
}

function tweetText(tweet) {
  const note = tweet?.note_tweet?.note_tweet_results?.result?.text;
  return String(note || tweet?.legacy?.full_text || tweet?.legacy?.text || "");
}

function isRetweetNode(tweet) {
  const legacy = tweet?.legacy || {};
  return !!(legacy.retweeted_status_result || legacy.retweeted_status || tweet?.retweeted_status_result);
}

function isReplyNode(tweet) {
  const legacy = tweet?.legacy || {};
  return !!(legacy.in_reply_to_status_id_str || legacy.in_reply_to_tweet_id);
}

function interpretDisclosure(value) {
  if (value == null) return { paid: false, explicitEmpty: true };
  if (typeof value === "boolean") return { paid: value, explicitEmpty: !value };
  if (typeof value === "object") {
    const type = value.disclosure_type ?? value.disclosureType ?? value.type ?? value.kind;
    const label = value.label ?? value.text;
    let fromType = null;
    if (type !== undefined) fromType = interpretDisclosure(type);
    const labelPaid = isPaidPartnershipLabel(label);
    return {
      paid: !!(fromType?.paid || labelPaid),
      explicitEmpty: !!(fromType && fromType.explicitEmpty) && !labelPaid,
    };
  }
  const raw = String(value).trim();
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (!raw || ["null", "none", "nodisclosure", "earned", "political", "issue", "undefined", "false"].includes(key)) {
    return { paid: false, explicitEmpty: true };
  }
  if (key === "paidpartnership" || key === "paidpartner" || isPaidPartnershipLabel(raw)) {
    return { paid: true, explicitEmpty: false };
  }
  return { paid: false, explicitEmpty: true };
}

function readDisclosure(tweet) {
  const hits = [];
  const push = (present, value) => {
    if (!present) return;
    hits.push(interpretDisclosure(value));
  };
  if (!tweet || typeof tweet !== "object") return hits;
  push("disclosure_type" in tweet, tweet.disclosure_type);
  push("disclosureType" in tweet, tweet.disclosureType);
  push("disclosure" in tweet, tweet.disclosure);
  push("paid_partnership" in tweet, tweet.paid_partnership);
  push("is_paid_partnership" in tweet, tweet.is_paid_partnership);
  const legacy = tweet.legacy;
  if (legacy && typeof legacy === "object") {
    push("disclosure_type" in legacy, legacy.disclosure_type);
    push("disclosure" in legacy, legacy.disclosure);
    push("paid_partnership" in legacy, legacy.paid_partnership);
    push("is_paid_partnership" in legacy, legacy.is_paid_partnership);
  }
  const ext = tweet.ext?.disclosureType;
  if (ext && typeof ext === "object") {
    const ok = ext.r?.ok ?? ext;
    if (ok && typeof ok === "object" && ("disclosureType" in ok || "disclosure_type" in ok)) {
      push(true, ok.disclosureType ?? ok.disclosure_type);
    } else if (typeof ok === "string") {
      push(true, ok);
    }
  } else if (typeof ext === "string") {
    push(true, ext);
  }
  return hits;
}

function payloadLabelPaid(tweet) {
  const texts = [];
  const collect = (value) => {
    if (!value) return;
    if (typeof value === "string") texts.push(value);
    else if (typeof value === "object") {
      if (value.text) texts.push(String(value.text));
      if (value.description) texts.push(String(value.description));
      if (value.contextType) texts.push(String(value.contextType));
      if (value.type) texts.push(String(value.type));
    }
  };
  collect(tweet?.socialContext);
  collect(tweet?.social_context);
  collect(tweet?.label);
  collect(tweet?.legacy?.label);
  return texts.some((text) => isPaidPartnershipLabel(text));
}

function unwrapTweet(result) {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return unwrapTweet(result.tweet);
  if (result.tweet && !result.legacy && !result.rest_id) return unwrapTweet(result.tweet);
  if (result.__typename === "TweetTombstone" || result.__typename === "TweetUnavailable") return null;
  if (!result.legacy && !result.rest_id) return null;
  return result;
}

function findInstructions(json) {
  const data = json?.data;
  const known = [
    data?.user?.result?.timeline_v2?.timeline?.instructions,
    data?.user?.result?.timeline?.timeline?.instructions,
    data?.user?.result?.timeline?.instructions,
  ];
  for (const list of known) if (Array.isArray(list)) return list;
  const queue = [{ node: data, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < 500) {
    const current = queue.shift();
    seen += 1;
    const node = current?.node;
    const depth = current?.depth || 0;
    if (!node || typeof node !== "object" || depth > 7) continue;
    if (Array.isArray(node.instructions) && node.instructions.some((item) => item && (item.type || item.entries || item.entry))) {
      return node.instructions;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") queue.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
}

function tweetFromEntry(entry) {
  const content = entry?.content ?? entry;
  const item = content?.itemContent ?? content?.content ?? content?.item?.itemContent;
  const result = item?.tweet_results?.result ?? content?.tweet_results?.result;
  return unwrapTweet(result);
}

function cursorOf(entry) {
  const content = entry?.content ?? entry;
  const type = content?.entryType || content?.__typename || "";
  if ((type === "TimelineTimelineCursor" || content?.cursorType) && content?.cursorType === "Bottom" && content?.value) {
    return String(content.value);
  }
  return "";
}

function isPromotedEntry(entry, tweet) {
  const id = String(entry?.entryId || "");
  if (id.startsWith("promoted")) return true;
  if (entry?.content?.itemContent?.promotedMetadata) return true;
  if (tweet?.promotedMetadata) return true;
  return false;
}

export function collectUserTweetPage(json) {
  const instructions = findInstructions(json);
  if (!instructions) return { recognized: false, cursor: "", items: [] };
  const items = [];
  let cursor = "";
  for (const instruction of instructions) {
    if (!instruction || typeof instruction !== "object") continue;
    if (instruction.type === "TimelinePinEntry" && instruction.entry) {
      const tweet = tweetFromEntry(instruction.entry);
      if (tweet) items.push({ tweet, pinned: true, promoted: isPromotedEntry(instruction.entry, tweet) });
      continue;
    }
    const entries = Array.isArray(instruction.entries) ? instruction.entries : null;
    if (!entries) continue;
    for (const entry of entries) {
      const found = cursorOf(entry);
      if (found) {
        cursor = found;
        continue;
      }
      const tweet = tweetFromEntry(entry);
      if (!tweet) continue;
      items.push({ tweet, pinned: false, promoted: isPromotedEntry(entry, tweet) });
    }
  }
  return { recognized: true, cursor, items };
}

export function pageReachedWindowEnd(items, windowStart) {
  for (const item of items || []) {
    if (!item || item.pinned || item.promoted) continue;
    const created = createdAtMs(item.tweet || item);
    if (created && created < windowStart) return true;
  }
  return false;
}

function blankSummary(handle, status, reason, extra = {}) {
  return {
    status,
    reason,
    source: "none",
    uncertain: false,
    originalCount: 0,
    paidCount: 0,
    ratio: null,
    truncated: false,
    windowDays: PARTNERSHIP_WINDOW_DAYS,
    handle: handle || "",
    userId: "",
    fetchedAt: extra.fetchedAt || 0,
    wait: extra.wait || 0,
  };
}

export function summarizePartnershipSample(items, options = {}) {
  const now = options.now || Date.now();
  const windowStart = Number.isFinite(options.windowStart) ? options.windowStart : partnershipWindowStart(now);
  const userId = String(options.userId || "");
  let originalCount = 0;
  let disclosurePaid = 0;
  let labelPaid = 0;
  let heuristicPaid = 0;
  let fieldSeen = false;

  for (const item of items || []) {
    if (!item || item.promoted) continue;
    const tweet = item.tweet || item;
    if (!tweet || typeof tweet !== "object") continue;
    const owner = tweetUserId(tweet);
    if (userId && owner && owner !== userId) continue;
    const probe = readDisclosure(tweet);
    if (probe.length) fieldSeen = true;
    if (isRetweetNode(tweet) || isReplyNode(tweet)) continue;
    const created = createdAtMs(tweet);
    if (!created || created < windowStart || created > now + 5 * 60 * 1000) continue;
    originalCount += 1;
    if (probe.some((hit) => hit.paid)) disclosurePaid += 1;
    else if (!probe.length && payloadLabelPaid(tweet)) labelPaid += 1;
    else if (!probe.length && heuristicPaidText(tweetText(tweet))) heuristicPaid += 1;
  }

  const base = blankSummary(options.handle || "", "unavailable", "field-missing", { fetchedAt: now });
  base.userId = userId;
  base.truncated = !!options.truncated;
  base.originalCount = originalCount;
  if (!originalCount) {
    return { ...base, status: "empty", reason: "no-originals", source: "none", ratio: null, paidCount: 0, uncertain: false };
  }
  if (fieldSeen) {
    const paidCount = disclosurePaid + labelPaid;
    return {
      ...base,
      status: "ok",
      reason: "disclosure",
      source: "disclosure",
      paidCount,
      ratio: paidCount / originalCount,
      uncertain: false,
    };
  }
  if (labelPaid > 0) {
    return {
      ...base,
      status: "ok",
      reason: "label",
      source: "label",
      paidCount: labelPaid,
      ratio: labelPaid / originalCount,
      uncertain: true,
    };
  }
  if (heuristicPaid > 0) {
    return {
      ...base,
      status: "ok",
      reason: "heuristic",
      source: "heuristic",
      paidCount: heuristicPaid,
      ratio: heuristicPaid / originalCount,
      uncertain: true,
    };
  }
  return base;
}

export function parseScreenNamePayload(json) {
  const user = json?.data?.user?.result ?? json?.data?.user_result?.result ?? json?.data?.user_results?.result;
  if (!user || typeof user !== "object") return null;
  const userId = String(user.rest_id ?? user.id ?? "");
  const screenName = String(user.core?.screen_name ?? user.legacy?.screen_name ?? "").replace(/^@/, "");
  if (!/^\d+$/.test(userId)) return null;
  return { userId, screenName };
}

async function resolveUserId(api, handle) {
  const json = await api.getUserByScreenName(handle);
  const parsed = parseScreenNamePayload(json);
  if (!parsed?.userId) return "";
  if (parsed.screenName && parsed.screenName.toLowerCase() !== handle.toLowerCase()) return "";
  return parsed.userId;
}

async function loadPages(api, userId, options) {
  const now = options.now;
  const windowStart = partnershipWindowStart(now);
  const pageCap = options.pageCap ?? PARTNERSHIP_PAGE_CAP;
  const pageSize = options.pageSize ?? PARTNERSHIP_PAGE_SIZE;
  const items = [];
  let cursor = "";
  let truncated = false;
  for (let page = 0; page < pageCap; page += 1) {
    const json = await api.getUserTweets(userId, cursor || undefined, pageSize);
    const parsed = collectUserTweetPage(json);
    if (!parsed.recognized) {
      if (!items.length) {
        const missing = blankSummary(options.handle, "unavailable", "unrecognized", { fetchedAt: now });
        missing.userId = userId;
        return missing;
      }
      truncated = true;
      break;
    }
    items.push(...parsed.items);
    if (!parsed.cursor || pageReachedWindowEnd(parsed.items, windowStart)) {
      const summary = summarizePartnershipSample(items, {
        now,
        windowStart,
        userId,
        handle: options.handle,
        truncated: false,
      });
      summary.userId = userId;
      return summary;
    }
    cursor = parsed.cursor;
    if (page === pageCap - 1) {
      truncated = true;
      break;
    }
    if (options.sleep) await options.sleep(options.pageGapMs ?? PARTNERSHIP_PAGE_GAP_MS);
  }
  const summary = summarizePartnershipSample(items, {
    now,
    windowStart,
    userId,
    handle: options.handle,
    truncated,
  });
  summary.userId = userId;
  return summary;
}

export async function collectPartnershipSample(api, options) {
  const handle = sanitizeHandle(options.handle);
  const now = options.now || Date.now();
  if (!handle) return blankSummary("", "unavailable", "user-id", { fetchedAt: now });
  let userId = /^\d+$/.test(String(options.knownUserId || "")) ? String(options.knownUserId) : "";
  const usedKnown = !!userId;
  if (!userId) {
    userId = await resolveUserId(api, handle);
    if (!userId) return { ...blankSummary(handle, "unavailable", "user-id", { fetchedAt: now }), fetchedAt: now };
  }
  try {
    const summary = await loadPages(api, userId, { ...options, handle, now });
    summary.handle = handle;
    summary.fetchedAt = now;
    return summary;
  } catch (error) {
    if (usedKnown && (error?.code === "data" || error?.status === 404)) {
      const fresh = await resolveUserId(api, handle);
      if (fresh && fresh !== userId) {
        const summary = await loadPages(api, fresh, { ...options, handle, now });
        summary.handle = handle;
        summary.fetchedAt = now;
        return summary;
      }
    }
    throw error;
  }
}

function ttlFor(summary) {
  if (summary.status === "ok") return PARTNERSHIP_CACHE_TTL_MS;
  if (summary.status === "empty") return 6 * 60 * 60 * 1000;
  switch (summary.reason) {
    case "auth":
      return 10 * 60 * 1000;
    case "user-id":
      return 30 * 60 * 1000;
    case "query":
    case "unrecognized":
      return 6 * 60 * 60 * 1000;
    case "field-missing":
      return PARTNERSHIP_CACHE_TTL_MS;
    default:
      return 30 * 60 * 1000;
  }
}

export function shouldRememberPartnership(summary) {
  if (!summary?.handle) return false;
  if (summary.status === "ok" || summary.status === "empty") return true;
  if (summary.status === "unavailable" && summary.reason !== "network") return true;
  return false;
}

function pruneEntries(entries, now) {
  const rows = Object.entries(entries).filter(([, entry]) => entry && entry.expiresAt > now);
  rows.sort((a, b) => (a[1].expiresAt || 0) - (b[1].expiresAt || 0));
  const kept = rows.slice(Math.max(0, rows.length - CACHE_ENTRY_CAP));
  return Object.fromEntries(kept);
}

export function rememberPartnership(cache, summary, now) {
  const next = normalizePartnershipCache(cache);
  if (!shouldRememberPartnership(summary)) return next;
  const handle = sanitizeHandle(summary.handle);
  if (!handle) return next;
  const key = partnershipCacheKey(handle, now);
  next.entries[key] = {
    expiresAt: now + ttlFor(summary),
    summary: { ...summary, handle, fetchedAt: summary.fetchedAt || now },
  };
  next.entries = pruneEntries(next.entries, now);
  if (/^\d+$/.test(String(summary.userId || ""))) {
    next.ids[handle.toLowerCase()] = String(summary.userId);
    const idRows = Object.entries(next.ids);
    if (idRows.length > CACHE_ID_CAP) {
      next.ids = Object.fromEntries(idRows.slice(idRows.length - CACHE_ID_CAP));
    }
  }
  return next;
}

export function lookupPartnershipCache(cache, handle, now) {
  const normalized = normalizePartnershipCache(cache);
  const key = partnershipCacheKey(handle, now);
  const entry = normalized.entries[key];
  if (!entry || !(entry.expiresAt > now) || !entry.summary) return null;
  return entry.summary;
}

export function reservePartnershipSlot(budget, now) {
  const hour = 60 * 60 * 1000;
  let next = {
    hourStart: Number(budget?.hourStart) || 0,
    count: Math.max(0, Math.floor(Number(budget?.count) || 0)),
    nextAllowed: Number(budget?.nextAllowed) || 0,
  };
  if (!next.hourStart || now - next.hourStart >= hour) {
    next = { hourStart: now, count: 0, nextAllowed: next.nextAllowed || 0 };
  }
  if (now < next.nextAllowed) {
    return { ok: false, reason: "gap", wait: next.nextAllowed - now, budget: next };
  }
  if (next.count >= PARTNERSHIP_HOURLY_CAP) {
    return { ok: false, reason: "hourly", wait: 0, budget: next };
  }
  next = { ...next, count: next.count + 1, nextAllowed: now + PARTNERSHIP_MIN_GAP_MS };
  return { ok: true, reason: "", wait: 0, budget: next };
}

export function partnershipFromError(error, handle) {
  const code = error?.code || "";
  let status = "unavailable";
  let reason = "network";
  if (code === "auth") reason = "auth";
  else if (code === "rate_limit") {
    status = "rate";
    reason = "rate";
  } else if (code === "query_id") reason = "query";
  return blankSummary(handle, status, reason, { fetchedAt: 0, wait: Number(error?.resetAt) || 0 });
}

export async function runPartnershipStats(input) {
  const handle = sanitizeHandle(input?.handle);
  const settings = input?.settings || {};
  const now = input?.now || Date.now();
  const cache = normalizePartnershipCache(input?.cache);
  if (!handle || isReservedHandle(handle)) {
    return { ok: false, error: "no-handle", cache, cacheChanged: false, fetched: false };
  }
  if (settings.hoverCardEnabled === false || settings.partnershipRatioEnabled !== true) {
    const reason = settings.hoverCardEnabled === false ? "card" : "ratio";
    return {
      ok: true,
      partnership: blankSummary(handle, "off", reason),
      cache,
      cacheChanged: false,
      fetched: false,
    };
  }
  const cached = lookupPartnershipCache(cache, handle, now);
  if (cached) {
    return { ok: true, partnership: cached, cache, cacheChanged: false, fetched: false, cached: true };
  }
  const slot = reservePartnershipSlot(cache.budget, now);
  if (!slot.ok) {
    return {
      ok: true,
      partnership: blankSummary(handle, "rate", slot.reason, { wait: slot.wait || 0 }),
      cache: { ...cache, budget: slot.budget },
      cacheChanged: true,
      fetched: false,
    };
  }
  let working = { ...cache, entries: { ...cache.entries }, ids: { ...cache.ids }, budget: slot.budget };
  if (!input?.api?.getUserTweets || !input?.api?.getUserByScreenName) {
    return {
      ok: true,
      partnership: blankSummary(handle, "unavailable", "network"),
      cache: working,
      cacheChanged: true,
      fetched: false,
    };
  }
  try {
    const summary = await collectPartnershipSample(input.api, {
      handle,
      knownUserId: working.ids[handle.toLowerCase()] || "",
      now,
      pageCap: input.pageCap,
      pageSize: input.pageSize,
      pageGapMs: input.pageGapMs ?? PARTNERSHIP_PAGE_GAP_MS,
      sleep: input.sleep,
    });
    const stored = rememberPartnership(working, summary, now);
    stored.budget = working.budget;
    return { ok: true, partnership: summary, cache: stored, cacheChanged: true, fetched: true };
  } catch (error) {
    const partnership = partnershipFromError(error, handle);
    partnership.fetchedAt = now;
    const stored = rememberPartnership(working, partnership, now);
    stored.budget = working.budget;
    return { ok: true, partnership, cache: stored, cacheChanged: true, fetched: true };
  }
}

function percent(ratio) {
  if (!Number.isFinite(ratio)) return "";
  return String(Math.round(Math.min(1, Math.max(0, ratio)) * 100));
}

export function formatPartnershipLine(input, lang) {
  const zh = lang === "zh";
  if (input?.loading && !input.partnership) {
    return { tone: "quiet", text: zh ? "付费合作占比：正在读取…" : "Paid partnership ratio: loading…" };
  }
  const partnership = input?.partnership;
  if (!input?.ratioEnabled && (!partnership || partnership.status === "off")) {
    return { tone: "quiet", text: zh ? "付费合作占比：未开启" : "Paid partnership ratio: off" };
  }
  if (!partnership || partnership.status === "off") {
    return { tone: "quiet", text: zh ? "付费合作占比：未开启" : "Paid partnership ratio: off" };
  }
  if (partnership.status === "rate") {
    return { tone: "quiet", text: zh ? "付费合作占比：读取被限速，稍后再看" : "Paid partnership ratio: rate limited, try again shortly" };
  }
  if (partnership.status === "empty" || partnership.reason === "no-originals") {
    return { tone: "quiet", text: zh ? "付费合作占比：近约 30 天没有抽到原创帖" : "Paid partnership ratio: no original posts in about 30 days" };
  }
  if (partnership.status === "ok" && Number.isFinite(partnership.ratio)) {
    const pct = percent(partnership.ratio);
    const paid = partnership.paidCount || 0;
    const total = partnership.originalCount || 0;
    const tail = partnership.truncated ? (zh ? "，未翻完" : ", sample stopped early") : "";
    if (partnership.source === "heuristic" || partnership.uncertain && partnership.source !== "disclosure") {
      if (partnership.source === "heuristic") {
        return {
          tone: "warn",
          text: zh
            ? `付费合作占比：约 ${pct}%（${paid}/${total}，正文启发式，不确定${tail}）`
            : `Paid partnership ratio: about ${pct}% (${paid}/${total}, text heuristic, uncertain${tail})`,
        };
      }
      return {
        tone: "warn",
        text: zh
          ? `付费合作占比：${pct}%（${paid}/${total}，载荷里的付费合作标记，可能不完整${tail}）`
          : `Paid partnership ratio: ${pct}% (${paid}/${total}, payload label, may be incomplete${tail})`,
      };
    }
    return {
      tone: "",
      text: zh
        ? `付费合作占比：${pct}%（${paid}/${total}，近约 30 天原创${tail}）`
        : `Paid partnership ratio: ${pct}% (${paid}/${total}, original posts, about 30 days${tail})`,
    };
  }
  const reason = partnership.reason || "field-missing";
  const text = {
    auth: zh ? "付费合作占比：暂无法统计（没有登录凭证）" : "Paid partnership ratio: unavailable (no signed-in session)",
    query: zh ? "付费合作占比：暂无法统计（UserTweets 的 queryId 不可用）" : "Paid partnership ratio: unavailable (UserTweets queryId)",
    unrecognized: zh ? "付费合作占比：暂无法统计（认不出时间线结构）" : "Paid partnership ratio: unavailable (timeline shape not recognized)",
    "user-id": zh ? "付费合作占比：暂无法统计（没有解析到用户 id）" : "Paid partnership ratio: unavailable (no user id)",
    network: zh ? "付费合作占比：读取失败，暂无法统计" : "Paid partnership ratio: request failed",
    "field-missing": zh ? "付费合作占比：暂无法统计（响应里没有付费合作字段）" : "Paid partnership ratio: unavailable (no partnership field in the response)",
  }[reason] || (zh ? "付费合作占比：暂无法统计" : "Paid partnership ratio: unavailable");
  return { tone: "warn", text };
}

function ledgerLine(record, lang) {
  const zh = lang === "zh";
  const counts = record?.counts && typeof record.counts === "object" ? record.counts : {};
  const merged = new Map();
  for (const [rawName, rawCount] of Object.entries(counts)) {
    const name = canonicalTag(rawName);
    const count = Math.floor(Number(rawCount));
    if (!name || !Number.isFinite(count) || count < 1) continue;
    merged.set(name, (merged.get(name) || 0) + count);
  }
  const rows = [...merged.entries()].map(([name, count]) => ({ name, count }));
  rows.sort((a, b) => {
    const rank = (name) => (name === "Spam" ? 0 : name === "Marketing" ? 1 : 2);
    const byRank = rank(a.name) - rank(b.name);
    if (byRank) return byRank;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });
  if (!rows.length) {
    return { tone: "quiet", text: zh ? "账本：还没有垃圾或营销记录" : "Ledger: no spam or marketing marks" };
  }
  const bits = rows.slice(0, 4).map((row) => `${tagLabel(row.name, lang)}×${row.count}`);
  const extra = rows.length - bits.length;
  if (extra > 0) bits.push(`+${extra}`);
  return { tone: "", text: zh ? `账本：${bits.join(" · ")}` : `Ledger: ${bits.join(" · ")}` };
}

function flagLine(record, settings, handle, lang) {
  if (!record) return null;
  const marks = libraryMarksForAccount({ ...record, handle }, settings);
  const zh = lang === "zh";
  const bits = [];
  if (marks.spam) bits.push(zh ? "常垃圾" : "Spam-prone");
  if (marks.marketing) bits.push(zh ? "常营销" : "Marketing-prone");
  if (!bits.length) return null;
  return { tone: "", text: zh ? `作者标记：${bits.join(" · ")}` : `Author flags: ${bits.join(" · ")}` };
}

function protectLine(followed, whitelist, lang) {
  const zh = lang === "zh";
  const follow = followed === true ? (zh ? "已关注" : "Following") : followed === false ? (zh ? "未关注" : "Not following") : (zh ? "关注状态未知" : "Follow state unknown");
  const list = whitelist === true ? (zh ? "在白名单" : "Whitelisted") : whitelist === false ? (zh ? "不在白名单" : "Not whitelisted") : (zh ? "白名单未知" : "Whitelist unknown");
  const tone = followed === true || whitelist === true ? "ok" : "quiet";
  return { tone, text: `${follow} · ${list}` };
}

/**
 * Read-only hover card. No mute, block, queue, or strike fields.
 */
export function describeHoverCard(input) {
  const handle = sanitizeHandle(input?.handle);
  if (!handle) return null;
  const lang = input?.lang === "zh" ? "zh" : "en";
  const record = input?.record || null;
  const live = input?.liveFollowed;
  const stored = record?.followed;
  const followed = live === true || live === false ? live : stored === true ? true : stored === false ? false : null;
  const whitelist = record ? !!record.whitelist : null;
  const rows = [ledgerLine(record, lang)];
  const flags = flagLine(record, input?.settings, handle, lang);
  if (flags) rows.push(flags);
  rows.push(protectLine(followed, whitelist, lang));
  rows.push(formatPartnershipLine({
    ratioEnabled: input?.ratioEnabled === true,
    loading: input?.loading === true && !input?.partnership,
    partnership: input?.partnership || null,
  }, lang));
  if (input?.visiblePaid) {
    rows.push({
      tone: "warn",
      text: lang === "zh" ? "本条可见「付费合作」标记" : "This post shows a Paid partnership label",
    });
  }
  return {
    readOnly: true,
    handle,
    title: `@${handle}`,
    subtitle: sanitizeName(input?.displayName) || sanitizeName(record?.displayName) || "",
    rows,
    footnote: lang === "zh"
      ? "只读摘要。不会记账，不会静音或屏蔽。"
      : "Read-only. Does not record a strike, mute, or block.",
    followed,
    whitelist,
  };
}
