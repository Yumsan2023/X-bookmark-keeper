/**
 * Single writer for chrome.storage.local.
 * The API key lives in xslSecret, never in the xsl blob the content script reads.
 */

import {
  allowedAiEndpoint,
  allowedCommunityUrl,
  addDistilledRules,
  addKeywordToPack,
  aiSuggestionDismissed,
  applyActions,
  applyFalsePositive,
  applyMark,
  applyUndo,
  applyUnmark,
  addCustomTag,
  beginAction,
  cancelAction,
  clearHitLog,
  clearQueue,
  clearTag,
  deleteAccount,
  describeUndo,
  enqueue,
  exportData,
  finishAction,
  freshState,
  importCommunityList,
  importData,
  interpretAiLabel,
  localDay,
  normalizeForYouRuntime,
  normalizeState,
  peekAction,
  processorHold,
  pruneAiCache,
  publicAccount,
  queueDashboard,
  recordRuleHits,
  removeCommunityList,
  removeCustomTag,
  restorePacks,
  retryAction,
  retryFailed,
  sanitizeForYouQueueItem,
  sanitizeHandle,
  setQueuePaused,
  sanitizeSettings,
  searchLedger,
  seenAccount,
  setHidden,
  setAuthorFlag,
  setCommunityListEnabled,
  setWhitelist,
  snippet,
  statsOf,
  suggestionHash,
  thresholdFor,
  toPublicSettings,
  undoVeto,
  upsertCommunitySubscription,
} from "./pure.js";

import { scoreCandidate, scoreVector } from "../../foryou/score.ts";
import { defaultForYouSettings } from "../../foryou/types.ts";
import { db } from "../../db/db.ts";
import { listTagNames } from "../../db/posts.ts";
import { embedBatch, embedConfigured } from "../../ai/embeddings.ts";
import { recordForYouDecisions, pruneStaleForYouVectorCache } from "../../foryou/decisions.ts";
import {
  pruneExpiredVetoes,
  topFeedbackTokens,
  updateCentroidWithFeedback,
  upsertAuthorVeto,
  upsertKeywordVetoes,
} from "../../foryou/feedback.ts";

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

async function loadCommunityDocument(url) {
  const allowed = allowedCommunityUrl(url);
  if (!allowed) return { ok: false, error: "bad-url" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(allowed, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (!allowedCommunityUrl(res.url || allowed)) return { ok: false, error: "bad-url" };
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    const announced = Number(res.headers.get("content-length") || 0);
    if (announced > 512_000) return { ok: false, error: "too-large" };
    const text = await res.text();
    if (text.length > 512_000) return { ok: false, error: "too-large" };
    return { ok: true, body: text };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally {
    clearTimeout(timer);
  }
}

function editorOnly(sender) {
  if (isExtensionPage(sender)) return null;
  return { ok: false, error: "forbidden" };
}

function timelineOrEditor(sender) {
  if (isExtensionPage(sender)) return null;
  try {
    const host = new URL(sender?.url || "").hostname;
    if (host === "x.com" || host === "twitter.com" || host === "mobile.x.com" || host === "mobile.twitter.com") return null;
  } catch {
    /* not a timeline page */
  }
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
    const hash = suggestionHash({ handle, text, bio });
    if (aiSuggestionDismissed(state.vetoes, hash, Date.now())) {
      return {
        ok: true,
        cached: true,
        dismissed: true,
        label: null,
        reason: "",
        verdict: "none",
        keywords: [],
      };
    }
    const cached = state.aiCache[hash];
    if (cached) {
      const keywords = Array.isArray(cached.keywords)
        ? cached.keywords.filter((item) => typeof item === "string").map((item) => item.slice(0, 40)).slice(0, 6)
        : [];
      return { ok: true, cached: true, label: cached.label || null, reason: cached.reason || "", verdict: cached.verdict || "none", keywords };
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
            content: "Classify one X post for a personal ledger. Reply with JSON only: {\"label\":\"spam\"|\"marketing\"|\"none\",\"reason\":\"short\",\"keywords\":[\"verbatim phrase\"]}. spam = scams, phishing, engagement bait, crypto theft, porn spam. marketing = promotions, lead-gen, sales, affiliate bait. none = everything else. keywords: up to 5 short phrases copied verbatim from the post (2–40 characters). Use [] when the label is none or nothing short is worth keeping. Do not invent phrases. Do not tell the user to block or mute anyone.",
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
    state.aiCache[prepared.hash] = {
      label: parsed.label,
      reason: parsed.reason,
      verdict: parsed.verdict,
      keywords: parsed.keywords || [],
      at: Date.now(),
    };
    state.aiCache = pruneAiCache(state.aiCache);
    await writeRaw(state);
  });
  return { ok: true, cached: false, label: parsed.label, reason: parsed.reason, verdict: parsed.verdict, keywords: parsed.keywords || [] };
}

/**
 * For You 批量打分（M3：规则 + 向量混合）。
 * 调用方（内容脚本）每批最多传 20 条；这里再钳一次。
 * 上下文由后台组装：话题来自设置，whitelist / Strike veto 来自账本，
 * topAuthors / medianLikes 来自 Dexie 画像（M3 建好才有）。
 * Strike veto：作者 Spam / Marketing / Vagueposting 任一达到
 * libraryChipThreshold（默认 3）→ 强制 hide，永不自动收藏。
 * 向量路径：mode 不是 rule 且画像已建时，对整批候选调一次
 * embedBatch（本地 LM Studio，本机地址）；embedding 失败、端点未
 * 配置、或画像未建时，本批全部退化为规则版（不丢打分、不抛错，
 * vectorError / vectorAvailable 告诉调用方原因）。
 */
async function scoreForYouBatch(state, items) {
  const fy = state.settings?.foryou || defaultForYouSettings();
  const rawList = Array.isArray(items) ? items.slice(0, 20) : [];
  const candidates = [];
  for (const item of rawList) {
    const tweetId = String(item?.tweetId || "").trim().slice(0, 40);
    const handle = sanitizeHandle(item?.handle);
    if (!tweetId || !handle) continue;
    const account = state.ledger?.[`h:${handle.toLowerCase()}`];
    const whitelist = !!account?.whitelist;
    let strikeVeto = false;
    if (account && !whitelist) {
      for (const tag of ["Spam", "Marketing", "Vagueposting"]) {
        const count = account.tags?.find((entry) => entry.name === tag)?.count || 0;
        if (count >= thresholdFor(state.settings, tag)) {
          strikeVeto = true;
          break;
        }
      }
    }
    candidates.push({
      tweetId,
      handle,
      text: String(item?.text || ""),
      quotedText: String(item?.quotedText || ""),
      followed: item?.followed === true ? true : item?.followed === false ? false : null,
      likes: Number.isFinite(Number(item?.likes)) ? Number(item.likes) : null,
      whitelist,
      strikeVeto,
    });
  }

  // 画像（Dexie foryouProfile，M3 构建；读不到就是没建好）。
  let profile = null;
  try {
    profile = (await db.foryouProfile.get("profile")) ?? null;
  } catch {
    profile = null;
  }
  const topAuthors =
    profile && Array.isArray(profile.topAuthors) && profile.topAuthors.length
      ? new Set(profile.topAuthors.map((h) => String(h).toLowerCase()))
      : null;
  const medianLikes = profile?.medianLikes ?? null;

  // 向量：只在 hybrid / vector 且画像已建时算；整批一次请求。
  let embeddings = null;
  let vectorError = null;
  if (fy.mode !== "rule" && profile?.globalCentroid?.length) {
    if (!embedConfigured(fy.embed)) {
      vectorError = "embed-not-configured";
    } else {
      try {
        embeddings = await embedBatch(
          fy.embed,
          candidates.map((c) => [c.text, c.quotedText].filter(Boolean).join("\n").slice(0, 500)),
        );
      } catch (e) {
        vectorError = String((e && e.message) || e).slice(0, 120);
        embeddings = null;
      }
    }
  }

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const vector =
      embeddings && embeddings[i]
        ? (scoreVector(embeddings[i], profile)?.score ?? null)
        : null;
    const scored = scoreCandidate(
      {
        tweetId: c.tweetId,
        handle: c.handle,
        text: c.text,
        quotedText: c.quotedText,
        followed: c.followed,
        likes: c.likes,
      },
      {
        topics: fy.topics || [],
        topAuthors,
        medianLikes,
        whitelist: c.whitelist,
        // M4：反馈 veto（作者/关键词）进打分上下文，冷却期内规则分和
        // 向量分各扣 0.3（scoreCandidate 里做，设计 §3.5）。
        authorVetoes: fy.authorVetoes,
        keywordVetoes: fy.keywordVetoes,
        now: Date.now(),
      },
      { mode: fy.mode, bookmarkThreshold: fy.bookmarkThreshold, hideThreshold: fy.hideThreshold, strikeVeto: c.strikeVeto },
      vector,
    );
    results.push({ tweetId: c.tweetId, handle: c.handle, ...scored });
  }
  // M4：打分结果写进 Dexie 决策日志（面板展示 + 反馈用的 vectorCache）。
  // 只记本批新打分的行；已有的执行态（status/bookmarked/failed）与反馈
  // 不覆盖——M2 执行时会用自己的 status 覆盖整行。
  try {
    const prevRows = await db.foryouDecisions.bulkGet(results.map((r) => r.tweetId));
    const prevById = new Map(prevRows.filter(Boolean).map((row) => [row.tweet_id, row]));
    await recordForYouDecisions(
      results.map((r, i) => {
        const prev = prevById.get(r.tweetId);
        return {
          tweet_id: r.tweetId,
          at: Date.now(),
          rule: r.rule ?? null,
          vector: r.vector ?? null,
          final: r.final,
          decision: r.decision,
          reasons: r.reasons || [],
          destination: fy.destination?.kind === "folder" ? fy.destination.folder : "",
          feedback: prev?.feedback ?? null,
          status: prev?.status,
          error: prev?.error,
          vectorCache: embeddings?.[i] ? [...embeddings[i]] : prev?.vectorCache,
          handle: r.handle,
          textSnippet: (candidates[i]?.text || "").slice(0, 200),
        };
      }),
    );
  } catch {
    /* 决策日志写失败不影响打分返回（面板少一行而已） */
  }
  return {
    ok: true,
    results,
    profileBuilt: !!profile,
    vectorAvailable: embeddings != null,
    vectorError,
  };
}

/**
 * For You 反馈（M4，设计 §3.5）：FORYOU_FEEDBACK {tweetId, kind, handle?, text?}。
 * - 决策行记 feedback（like/dislike）；dislike 不取消收藏（已确认的默认）。
 * - 有向量时并入画像：like → 全局质心，dislike → 负质心（增量均值）。
 *   向量优先用决策行缓存的 vectorCache；没有时，若画像已建且 embedding
 *   端点已配，就地调一次 embedBatch（文本来自消息或决策行 snippet）。
 * - dislike 再写 veto：作者进 authorVetoes、Top 3 关键词进 keywordVetoes，
 *   冷却天数取设置里的 vetoCooldownDays（默认 14 天），过期项顺手清掉。
 * - 顺手清掉 7 天以上的决策行 vectorCache（控体积，设计 §4.1）。
 * 返回 {ok, kind, profileUpdated, vetoed}；画像未建时只记反馈与 veto。
 */
async function applyForYouFeedback(state, message, now) {
  const fy = state.settings?.foryou || defaultForYouSettings();
  const kind = message?.kind === "like" ? "like" : message?.kind === "dislike" ? "dislike" : null;
  const tweetId = String(message?.tweetId || "").trim().slice(0, 40);
  if (!kind || !tweetId) return { ok: false, error: "bad-feedback" };
  const handle = (message?.handle || "").toLowerCase();
  const text = String(message?.text || "");
  const cooldownMs = Math.max(0, fy.vetoCooldownDays ?? 14) * 86_400_000;
  const until = now + cooldownMs;

  let row = null;
  try {
    row = (await db.foryouDecisions.get(tweetId)) ?? null;
  } catch {
    row = null;
  }
  const effHandle = handle || (row?.handle || "").toLowerCase();
  const effText = text || row?.textSnippet || "";

  let profileUpdated = false;
  let vetoed = false;
  try {
    const profile = (await db.foryouProfile.get("profile")) ?? null;
    let embedding = Array.isArray(row?.vectorCache) && row.vectorCache.length ? [...row.vectorCache] : null;
    if (!embedding && profile?.globalCentroid?.length && embedConfigured(fy.embed) && effText) {
      try {
        const got = await embedBatch(fy.embed, [effText.slice(0, 500)]);
        if (got?.[0]?.length === profile.globalCentroid.length) embedding = [...got[0]];
      } catch {
        embedding = null;
      }
    }
    if (profile && embedding) {
      await db.foryouProfile.put(updateCentroidWithFeedback(profile, embedding, kind));
      profileUpdated = true;
    }
  } catch {
    profileUpdated = false;
  }

  if (kind === "dislike") {
    vetoed = true;
    fy.authorVetoes = upsertAuthorVeto(pruneExpiredVetoes(fy.authorVetoes, now), effHandle, until);
    fy.keywordVetoes = upsertKeywordVetoes(
      pruneExpiredVetoes(fy.keywordVetoes, now),
      // 话题关键词优先（多字原词，不用分词器的 2 字碎片做 veto）。
      topFeedbackTokens(effText, 3, (fy.topics || []).flatMap((t) => t.keywords || [])),
      until,
    );
    state.settings.foryou = fy;
  }
  try {
    if (row) {
      await db.foryouDecisions.put({ ...row, feedback: kind });
    } else {
      await recordForYouDecisions([
        {
          tweet_id: tweetId,
          at: now,
          rule: null,
          vector: null,
          final: 0,
          decision: "leave",
          reasons: [],
          destination: "",
          feedback: kind,
          handle: effHandle,
          textSnippet: effText.slice(0, 200),
        },
      ]);
    }
  } catch {
    /* 决策行写失败不影响 veto / 画像更新 */
  }
  try {
    await pruneStaleForYouVectorCache(now);
  } catch {
    /* 清理失败忽略 */
  }
  return { ok: true, kind, profileUpdated, vetoed };
}

/**
 * 应用验证建议的阈值（M4，设计 §3.4）：FORYOU_APPLY_VALIDATION {id}。
 * 只读 Dexie foryouValidations；suggested 为 null（降级或无满足组合）
 * 时拒绝。经 sanitizeSettings 走一遍钳制（hide 必须 < bookmark）。
 */
async function applyForYouValidation(state, message) {
  const id = String(message?.id || "").trim();
  if (!id) return { ok: false, error: "bad-id" };
  let row = null;
  try {
    row = (await db.foryouValidations.get(id)) ?? null;
  } catch {
    row = null;
  }
  if (!row) return { ok: false, error: "not-found" };
  if (!row.suggested) return { ok: false, error: "no-suggestion" };
  const sanitized = sanitizeSettings(state.settings, {
    foryou: {
      bookmarkThreshold: row.suggested.bookmark,
      hideThreshold: row.suggested.hide,
    },
  });
  state.settings = sanitized.settings;
  return {
    ok: true,
    bookmarkThreshold: state.settings.foryou.bookmarkThreshold,
    hideThreshold: state.settings.foryou.hideThreshold,
    warnings: sanitized.warnings,
  };
}

/**
 * For You 自动收藏的执行器（M2）：后台 TS 侧（messaging.ts）通过
 * setForYouBookmarkRunner 注册；store.js 只负责入队 / 计数 / 退避，
 * 不直接调 X API（保持单写者：xsl 的写只走 locked()）。
 * runner 为空时（单测 / 未接线）只入队不执行，队列持久化在 xsl，
 * 下次 FORYOU_BOOKMARK 触发时再跑。
 */
let foryouBookmarkRunner = null;
export function setForYouBookmarkRunner(fn) {
  foryouBookmarkRunner = typeof fn === "function" ? fn : null;
}

/** 跨天时当日计数 / 队列 / 退避清零（队列不跨天续跑）。 */
function rollForYouDay(state, now) {
  state.foryou = normalizeForYouRuntime(state.foryou, now);
}

function nextLocalMidnight(now) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * FORYOU_BOOKMARK 入队（M2，设计 §7.1）：只做校验和入队，不执行。
 * 执行由 dispatch() 在锁外触发 runner，避免长耗时 runTask
 *（每条 5 秒以上）占着 locked() 堵住 MARK / PEEK_ACTION 等消息。
 * 上限在入队时钳：剩余名额 = dailyCap − 当日已收藏 − 已排队。
 */
function enqueueForYouBookmarks(state, message, now) {
  const fy = state.settings?.foryou || defaultForYouSettings();
  if (!fy.enabled) return { ok: false, error: "foryou-off" };
  rollForYouDay(state, now);
  if (now < (state.foryou.backoffUntil || 0)) {
    return { ok: false, error: "backoff", backoffUntil: state.foryou.backoffUntil };
  }
  const list = Array.isArray(message.items) ? message.items : [];
  const queuedIds = new Set(state.foryou.queue.map((item) => item.tweetId));
  const remaining = Math.max(0, fy.dailyCap - state.foryou.bookmarkedToday - state.foryou.queue.length);
  let enqueued = 0;
  let skippedCap = 0;
  let skippedDup = 0;
  for (const raw of list) {
    const item = sanitizeForYouQueueItem(raw);
    if (!item) continue;
    if (queuedIds.has(item.tweetId)) {
      skippedDup++;
      continue;
    }
    if (enqueued >= remaining) {
      skippedCap++;
      continue;
    }
    state.foryou.queue.push(item);
    queuedIds.add(item.tweetId);
    enqueued++;
  }
  return {
    ok: true,
    enqueued,
    skippedCap,
    skippedDup,
    queued: state.foryou.queue.length,
    remaining: Math.max(0, remaining - enqueued),
    bookmarkedToday: state.foryou.bookmarkedToday,
    dailyCap: fy.dailyCap,
  };
}

/**
 * runner 读一批待执行项（M2）：返回当前队列快照 + 执行用的设置。
 * 读不到 / 开关关 / 退避中 / 队空时返回 null。跨天时先清零再写回。
 */
export async function getForYouRunBatch() {
  return locked(async () => {
    const now = Date.now();
    const state = await readRaw();
    rollForYouDay(state, now);
    const fy = state.settings?.foryou || defaultForYouSettings();
    if (!fy.enabled) return null;
    if (now < (state.foryou.backoffUntil || 0)) return null;
    if (!state.foryou.queue.length) return null;
    await writeRaw(state);
    return {
      items: state.foryou.queue.map((item) => ({ ...item })),
      destination: { ...fy.destination },
      minGapMs: fy.minGapMs,
    };
  });
}

/**
 * 单条执行完后记账（M2）：从队列移除；成功计入当日数并清 429 连击，
 * 失败只移除（失败原因已写进 Dexie 决策日志，不在这里存）。
 */
export async function noteForYouBookmarkResult(tweetId, ok) {
  const id = String(tweetId || "");
  if (!id) return;
  await locked(async () => {
    const state = await readRaw();
    state.foryou.queue = (state.foryou.queue || []).filter((item) => item.tweetId !== id);
    if (ok) {
      state.foryou.bookmarkedToday = (state.foryou.bookmarkedToday || 0) + 1;
      state.foryou.rateStrikes = 0;
    }
    await writeRaw(state);
  });
}

/**
 * 429 连击记账（M2）：第 1 次只记连击数（runTask 自己会等 resetAt 再
 * 重试该条，不在这里设 backoff——否则退避窗口内新到的打分批次会被
 * 入队拒绝而丢弃）；连续 2 次则 backoffUntil 设到当天结束，当天不再
 * 自动收藏（设计 §5.1）。成功一条后连击数由 noteForYouBookmarkResult 清零。
 */
export async function noteForYouRateLimited(strikes) {
  const n = Math.max(0, Math.floor(Number(strikes) || 0));
  await locked(async () => {
    const now = Date.now();
    const state = await readRaw();
    state.foryou.rateStrikes = n;
    if (n >= 2) state.foryou.backoffUntil = nextLocalMidnight(now);
    await writeRaw(state);
  });
}

export async function dispatch(message, sender = {}) {
  const type = message?.type;
  if (!type) return Promise.resolve({ ok: false, error: "bad-message" });
  if (type === "SUGGEST") return suggest(message);
  const result = await locked(async () => {
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
          hitLog: state.hitLog.slice(0, 40),
          vetoes: Array.isArray(state.vetoes) ? state.vetoes.slice(0, 40) : [],
          undo: describeUndo(state.undo[0]),
        };
        break;
      }
      case "FORYOU_SCORE": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        result = await scoreForYouBatch(state, message.items);
        break;
      }
      case "FORYOU_TAGS": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = { ok: true, tags: await listTagNames() };
        break;
      }
      case "FORYOU_BOOKMARK": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        // 只入队不执行：执行由 dispatch() 在锁外触发 runner（见文件末尾），
        // 否则 runTask 每条 5 秒以上的等待会占着 locked() 堵住其他消息。
        result = enqueueForYouBookmarks(state, message, now);
        break;
      }
      case "FORYOU_FEEDBACK": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        // M4 反馈闭环（设计 §3.5）：记 feedback、并向量入画像、dislike 写 veto。
        // dislike 不取消收藏（已确认的默认）；误藏在决策日志面板里手动撤销。
        result = await applyForYouFeedback(state, message, now);
        break;
      }
      case "FORYOU_APPLY_VALIDATION": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        // M4：把离线验证建议的阈值写进设置（设计 §3.4）。
        result = await applyForYouValidation(state, message);
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
      case "SET_AUTHOR_FLAG":
        result = setAuthorFlag(state, message, now);
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
      case "ADD_KEYWORD": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        result = addKeywordToPack(state, message);
        if (result?.duplicate) return result;
        break;
      }
      case "ADD_DISTILLED": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        result = addDistilledRules(state, message);
        if (!result?.ok || !result.added?.length) return result;
        break;
      }
      case "APPLY_VETO": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        result = applyFalsePositive(state, message, now);
        if (!result?.ok) return result;
        break;
      }
      case "UNDO_VETO": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = undoVeto(state, message);
        if (!result?.ok) return result;
        break;
      }
      case "RECORD_HITS": {
        const denied = timelineOrEditor(sender);
        if (denied) return denied;
        result = recordRuleHits(state, message, now);
        if (!result?.recorded) return result;
        break;
      }
      case "CLEAR_HIT_LOG": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = clearHitLog(state);
        break;
      }
      case "IMPORT_COMMUNITY": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = importCommunityList(state, { text: message.text, name: message.name }, now);
        if (!result?.ok) return result;
        break;
      }
      case "SUBSCRIBE_COMMUNITY":
      case "REFRESH_COMMUNITY": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        let url = allowedCommunityUrl(message.url);
        if (type === "REFRESH_COMMUNITY") {
          const list = (state.settings.communityLists || []).find((item) => item.id === String(message.id || ""));
          if (!list) return { ok: false, error: "no-list" };
          if (!list.url) return { ok: false, error: "not-url" };
          url = list.url;
        }
        if (!url) return { ok: false, error: "bad-url" };
        const fetched = await loadCommunityDocument(url);
        result = upsertCommunitySubscription(state, { url, fetched }, now);
        if (!result?.ok) return result;
        break;
      }
      case "REMOVE_COMMUNITY": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = removeCommunityList(state, message.id);
        if (!result?.ok) return result;
        break;
      }
      case "SET_COMMUNITY_LIST": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        result = setCommunityListEnabled(state, message);
        if (!result?.ok) return result;
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
      case "REPLACE_STATE": {
        const denied = editorOnly(sender);
        if (denied) return denied;
        const incoming = message.state;
        if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
          return { ok: false, error: "bad-file" };
        }
        const keepKey = message.includeSecrets ? null : (state.settings.ai?.apiKey || "");
        const next = normalizeState(incoming, now);
        if (keepKey !== null) {
          next.settings.ai.apiKey = keepKey;
          next.settings.ai.hasApiKey = !!keepKey;
        }
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, next);
        result = { ok: true, accounts: Object.keys(state.ledger).length, queue: state.queue.length };
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
    const reads = new Set(["ENSURE", "GET_PUBLIC", "GET_EDITOR", "SEARCH", "PEEK_UNDO", "STATS", "FORYOU_SCORE", "FORYOU_TAGS"]);
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
  // FORYOU_BOOKMARK 只在锁内入队；执行放锁外跑，避免 runTask 的
  // 长等待占着 locked()。runner 为空（单测 / 未接线）时只入队，
  // 队列已持久化在 xsl，下次触发时再跑。执行失败不影响本次响应。
  if (type === "FORYOU_BOOKMARK" && result?.ok && result?.enqueued > 0 && foryouBookmarkRunner) {
    void foryouBookmarkRunner().catch(() => {});
  }
  return result;
}

export const __test = { readRaw, writeRaw, publicAccount };
