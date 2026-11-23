/**
 * For You 离线验证 — 指标纯函数 + 样本读取（M4，设计 §3.4）。
 * 指标计算（computeThresholdRows / suggestThresholds / median / percentile）
 * 是纯函数，可直接单测；读库的部分（loadHoldoutPosts / sampleTimelineNegatives）
 * 只在后台 Job（runner.ts 的 validateJob）里调。
 *
 * 定义（bookmark 类，正样本 = 已收藏）：
 * - precision = TP / (TP + FP)，分母为 0 时记 0；
 * - recall = TP / nPos；
 * - F1 = 2·P·R / (P + R)，P + R 为 0 时记 0；
 * - hideKillRate（hide 误杀率）= 正样本里 final <= hideThreshold 的比例。
 * 建议阈值：在 hideKillRate < 5% 的组合里取 F1 最大；并列时 recall 大者优先，
 * 再并列取 bookmark 阈值小、hide 阈值小者。没有任何组合满足时返回 null
 * （面板显示“不建议”，而不是硬给一个会误杀的阈值）。
 */
import { db } from "@/db/db";
import { postSource, type Post } from "@/shared/types";

export const FORYOU_VALIDATE_BOOKMARK_THRESHOLDS = [0.5, 0.6, 0.7, 0.8];
export const FORYOU_VALIDATE_HIDE_THRESHOLDS = [0.15, 0.25, 0.35];
/** hide 误杀率上限（设计 §3.4）：建议阈值必须 <5%。 */
export const FORYOU_VALIDATE_MAX_HIDE_KILL_RATE = 0.05;
/** 负样本不足的界线（设计 §3.4）：timeline 帖 <100 条时降级为仅正样本分布报告。 */
export const FORYOU_VALIDATE_MIN_NEGATIVES = 100;
/** 验证用的正/负样本上限（各 300，设计 §3.4）。 */
export const FORYOU_VALIDATE_SAMPLE_SIZE = 300;

export interface ThresholdRow {
  bookmark: number;
  hide: number;
  precision: number;
  recall: number;
  f1: number;
  hideKillRate: number;
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** p10（第 10 百分位）：正样本里约 90% 的分数高于它，degraded 报告用。 */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * 对 bookmarkThreshold × hideThreshold 的全部组合算指标。
 * posScores / negScores 是 final 分数（已按当前 mode 混合好）。
 */
export function computeThresholdRows(
  posScores: readonly number[],
  negScores: readonly number[],
  bookmarkThresholds: readonly number[] = FORYOU_VALIDATE_BOOKMARK_THRESHOLDS,
  hideThresholds: readonly number[] = FORYOU_VALIDATE_HIDE_THRESHOLDS,
): ThresholdRow[] {
  const nPos = posScores.length;
  const rows: ThresholdRow[] = [];
  for (const bookmark of bookmarkThresholds) {
    const tp = posScores.filter((s) => s >= bookmark).length;
    const fp = negScores.filter((s) => s >= bookmark).length;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = nPos === 0 ? 0 : tp / nPos;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    for (const hide of hideThresholds) {
      const hideKillRate = nPos === 0 ? 0 : posScores.filter((s) => s <= hide).length / nPos;
      rows.push({ bookmark, hide, precision, recall, f1, hideKillRate });
    }
  }
  return rows;
}

export function suggestThresholds(rows: readonly ThresholdRow[]): { bookmark: number; hide: number } | null {
  const eligible = rows.filter((r) => r.hideKillRate < FORYOU_VALIDATE_MAX_HIDE_KILL_RATE);
  if (!eligible.length) return null;
  const best = [...eligible].sort(
    (a, b) => b.f1 - a.f1 || b.recall - a.recall || a.bookmark - b.bookmark || a.hide - b.hide,
  )[0];
  return { bookmark: best.bookmark, hide: best.hide };
}

/** holdout 正样本：按 profile.holdoutIds 取帖，只留 active 书签。 */
export async function loadHoldoutPosts(holdoutIds: readonly string[]): Promise<Post[]> {
  if (!holdoutIds.length) return [];
  const rows = await db.posts.bulkGet([...holdoutIds]);
  return rows.filter((p): p is Post => !!p && p.status === "active" && postSource(p) === "bookmark");
}

/**
 * timeline 负样本：active 的 timeline 帖（用户看过但没收藏的）随机取 n 条。
 * 与 sampleBookmarks 同款做法：读全表过滤后内存抽样（一次性 Job，可接受）。
 */
export async function sampleTimelineNegatives(n: number, random: () => number = Math.random): Promise<Post[]> {
  const all = await db.posts
    .where("status")
    .equals("active")
    .filter((p) => postSource(p) === "timeline")
    .toArray();
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.max(0, n));
}
