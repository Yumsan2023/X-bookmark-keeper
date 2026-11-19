/**
 * For You 自动筛选 — 内容脚本侧（M1：规则版）。
 * 只做渲染与采集：判断当前是不是 For You 首页、采集未打分的推文、
 * 调后台 FORYOU_SCORE 批量打分、把结果交给 main.js 渲染（折叠/徽章），
 * 以及按设计 §7.2 的条件自动滚动。
 * 打分逻辑在后台 TS（src/foryou/score.ts），这里不算分。
 * M1 不执行自动收藏（那是 M2 的 runTask('foryou-bookmark')）。
 */
import { isNestedTweetArticle, parseArticle, TWEET_ARTICLE_SELECTOR } from "../lib/domparse.js";
import { send } from "../lib/client.js";

export const FORYOU_BATCH_SIZE = 20;
/** 连续滚动多少次都采不到新推文就停（设计 §7.2）。 */
const EMPTY_SCROLL_LIMIT = 3;
/** 用户多久没操作才允许自动滚动（设计 §7.2）。 */
const IDLE_MS = 30_000;
/** 打分请求失败后多久不再重试（避免每 2.5s 刷一次失败请求）。 */
const SCORE_COOLDOWN_MS = 30_000;

const seenIds = new Set();
let scoring = false;
let scoreCooldownUntil = 0;
let lastUserActivity = 0;
let emptyScrolls = 0;
let activityListenersAttached = false;

/** 供 main.js 在设置开关变化时调用：让已看过的推文重新参与打分。 */
export function resetForYouSeen() {
  seenIds.clear();
  emptyScrolls = 0;
}

function attachActivityListeners() {
  if (activityListenersAttached) return;
  activityListenersAttached = true;
  // 只监听用户主动操作：程序滚动（scrollBy）不会触发 wheel/keydown/pointerdown，
  // 所以自动滚动不会把自己"吵醒"后立刻禁掉。
  for (const event of ["wheel", "keydown", "pointerdown", "touchstart"]) {
    window.addEventListener(event, () => {
      lastUserActivity = Date.now();
    }, { passive: true });
  }
}

/**
 * 是不是 For You 首页：路径 /home 且当前选中的 tab 是 For You / 为你推荐。
 * 没有 tablist（窄布局/未加载完成）时只按路径判断。
 */
export function isForYouHome() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/home") return false;
  const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
  if (!tabs.length) return true;
  const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
  if (!selected) return true;
  return /for you|为你推荐/i.test(selected.textContent || "");
}

function isAd(article) {
  if (article.querySelector('[data-testid="promotedIndicator"]')) return true;
  // X 的推广标识是一段单独的 "Ad" / "推广" 文本节点。
  for (const node of article.querySelectorAll("span")) {
    const text = (node.textContent || "").trim();
    if (text === "Ad" || text === "推广") return true;
  }
  return false;
}

/**
 * 采集本屏未打分过的候选推文（最多 20 条一批）。
 * 跳过：嵌套引用、合成 tweetId、已打分过的、广告、自己的推文。
 * 返回 { items, articles }：articles 按 tweetId 映射，供 onDecisions 定位 DOM。
 * 注意：seenIds 在打分成功后才由 foryouTick 标记；失败不标记，下次重试。
 */
export function collectCandidates(selfHandle) {
  const items = [];
  const articles = new Map();
  for (const article of document.querySelectorAll(TWEET_ARTICLE_SELECTOR)) {
    if (items.length >= FORYOU_BATCH_SIZE) break;
    if (isNestedTweetArticle(article)) continue;
    const parsed = parseArticle(article, { pathname: location.pathname });
    if (!parsed || !parsed.tweetId || parsed.synthetic) continue;
    if (seenIds.has(parsed.tweetId)) continue;
    if (selfHandle && parsed.handle.toLowerCase() === selfHandle.toLowerCase()) continue;
    if (isAd(article)) continue;
    items.push({
      tweetId: parsed.tweetId,
      handle: parsed.handle,
      text: parsed.text || "",
      followed: parsed.followed ?? null,
    });
    articles.set(parsed.tweetId, article);
  }
  return { items, articles };
}

function maybeAutoScroll(foryouSettings) {
  if (!foryouSettings.autoScroll) return false;
  if (emptyScrolls >= EMPTY_SCROLL_LIMIT) return false;
  if (document.hidden) return false;
  if (Date.now() - lastUserActivity < IDLE_MS) return false;
  window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
  return true;
}

/**
 * 一次 For You tick（由 main.js 的 2.5s 定时器调用）。
 * hooks: { selfHandle, onDecisions(results, articles) }。
 * 流程：开关关 / 不在 For You / 页面隐藏 → 直接返回；
 * 有新候选 → 后台批量打分 → onDecisions 交给 main.js 渲染；
 * 无新候选 → 计一次空滚动（自动滚动时用）。
 */
export async function foryouTick(snapshot, hooks = {}) {
  attachActivityListeners();
  const fy = snapshot?.settings?.foryou;
  if (!fy?.enabled) return;
  if (!isForYouHome()) return;
  if (document.hidden) return;
  const { items, articles } = collectCandidates(hooks.selfHandle || "");
  if (items.length === 0) {
    // 只有真正滚了一次、下一轮仍无新推文，才计一次空滚动。
    if (maybeAutoScroll(fy)) emptyScrolls += 1;
    return;
  }
  emptyScrolls = 0;
  if (scoring || Date.now() < scoreCooldownUntil) {
    maybeAutoScroll(fy);
    return;
  }
  scoring = true;
  try {
    const res = await send({ type: "FORYOU_SCORE", items });
    if (res?.ok && Array.isArray(res.results)) {
      for (const result of res.results) seenIds.add(result.tweetId);
      hooks.onDecisions?.(res.results, articles);
    } else {
      scoreCooldownUntil = Date.now() + SCORE_COOLDOWN_MS;
    }
  } catch {
    scoreCooldownUntil = Date.now() + SCORE_COOLDOWN_MS;
  } finally {
    scoring = false;
  }
  maybeAutoScroll(fy);
}
