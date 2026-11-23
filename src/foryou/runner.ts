/**
 * For You 向量版 — 画像构建 Job（M3，设计 §3.3/§7.3）。
 * 后台 Job：采样 → embedding → 质心 → 写 Dexie foryouProfile，
 * 进度写 chrome.storage.local 的 bk_foryou_progress，支持取消。
 *
 * 可注入依赖（sampleFn / embedFn / saveFn / progressFn）以便单测：
 * 默认走真实的 sampleBookmarks / embedBatch / Dexie / chrome.storage。
 */
import { db } from "@/db/db";
import { STORAGE_KEYS } from "@/shared/types";
import { embedBatch, type EmbedConfig } from "@/ai/embeddings";
import { computeCentroids, toProfileSamples } from "./profile";
import { sampleBookmarks, type SampledBookmark } from "@/db/posts";
import type { ForYouProfileRow } from "./types";
import { defaultForYouSettings } from "./types";

export interface ForYouProfileProgress {
  job: "profile" | "validate";
  status: "running" | "done" | "error" | "cancelled";
  done: number;
  total: number;
  message: string;
  updated_at: number;
}

export interface BuildProfileResult {
  profile: ForYouProfileRow;
  /** 采样总数（holdout 之前） */
  sampled: number;
  /** holdout 样本数（不参与质心计算，留给 M4 验证） */
  holdout: number;
}

export interface BuildProfileOptions {
  embed: EmbedConfig;
  halfLifeDays?: number;
  /** 采样数上限（默认 3000：最新 1500 + 随机 1500，设计 §3.3） */
  nRecent?: number;
  nRandom?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (p: ForYouProfileProgress) => void;
  /** 单测注入：采样 / embedding / 落库 / 进度写 */
  sampleFn?: () => Promise<SampledBookmark[]>;
  embedFn?: (texts: string[]) => Promise<number[][]>;
  saveFn?: (row: ForYouProfileRow) => Promise<void>;
  progressFn?: (p: ForYouProfileProgress) => Promise<void> | void;
  random?: () => number;
  now?: () => number;
}

function defaultProgressFn(p: ForYouProfileProgress): void {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      void chrome.storage.local.set({ [STORAGE_KEYS.foryouProgress]: p });
    }
  } catch {
    /* 单测 / 非扩展环境没有 chrome.storage，进度只走 onProgress */
  }
}

/** 从 xsl 读 For You 设置（embed 配置与半衰期都在这里）；读不到用默认值。 */
export async function readForYouSettings(): Promise<ReturnType<typeof defaultForYouSettings>> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const got = (await chrome.storage.local.get("xsl")) as { xsl?: { settings?: { foryou?: unknown } } };
      const fy = got?.xsl?.settings?.foryou;
      if (fy && typeof fy === "object") {
        return { ...defaultForYouSettings(), ...(fy as Record<string, unknown>) } as ReturnType<typeof defaultForYouSettings>;
      }
    }
  } catch {
    /* 读不到就用默认值 */
  }
  return defaultForYouSettings();
}

/**
 * 构建画像。holdout：采样中随机留 10% 作 M4 验证正样本，不参与质心
 * 计算，id 记入 profile.holdoutIds（防泄漏）。取消时抛 "embedding 已取消"
 * 或 "画像构建已取消"，已写的进度状态为 cancelled，不写画像行。
 */
export async function buildProfileJob(opts: BuildProfileOptions): Promise<BuildProfileResult> {
  const startedAt = Date.now();
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const halfLifeDays = opts.halfLifeDays ?? 90;
  const progressFn = opts.progressFn ?? defaultProgressFn;
  const emit = (status: ForYouProfileProgress["status"], done: number, total: number, message: string) => {
    const p: ForYouProfileProgress = { job: "profile", status, done, total, message, updated_at: Date.now() };
    opts.onProgress?.(p);
    void progressFn(p);
  };

  const checkCancelled = () => {
    if (opts.signal?.aborted) throw new Error("画像构建已取消");
  };

  emit("running", 0, 0, "采样书签…");
  const sampled = opts.sampleFn
    ? await opts.sampleFn()
    : await sampleBookmarks({ nRecent: opts.nRecent ?? 1500, nRandom: opts.nRandom ?? 1500, random });
  checkCancelled();
  if (!sampled.length) throw new Error("没有可建画像的书签：先同步书签再重建画像");
  const total = sampled.length;

  // Holdout：随机留 10%（至少 1 条，样本太少时不留），不进质心。
  const holdoutCount = sampled.length >= 10 ? Math.max(1, Math.round(sampled.length * 0.1)) : 0;
  const shuffled = [...sampled];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const holdout = new Set(shuffled.slice(0, holdoutCount).map((p) => p.tweet_id));
  const train = sampled.filter((p) => !holdout.has(p.tweet_id));

  emit("running", 0, total, `采样 ${total} 条，embedding 中…`);
  const embedFn =
    opts.embedFn ??
    ((texts: string[]) =>
      embedBatch(opts.embed, texts, opts.fetchImpl, opts.signal, (done, totalEmb) => {
        emit("running", done, totalEmb, `embedding ${done}/${totalEmb}…`);
      }));
  const embeddings = await embedFn(train.map((p) => p.text));
  checkCancelled();

  emit("running", total, total, "计算画像质心…");
  const samples = toProfileSamples(train, embeddings);
  const centroids = computeCentroids(samples, { halfLifeDays, now: now() });
  const dim = centroids.globalCentroid.length;
  if (!dim) throw new Error("embedding 维度为 0：模型返回的向量为空");

  const profile: ForYouProfileRow = {
    key: "profile",
    dim,
    model: opts.embed.model,
    endpoint: opts.embed.endpoint,
    globalCentroid: centroids.globalCentroid,
    tagCentroids: centroids.tagCentroids,
    negCentroid: null,
    negCount: 0,
    topAuthors: centroids.topAuthors,
    medianLikes: centroids.medianLikes,
    medianViews: centroids.medianViews,
    sampleSize: train.length,
    holdoutIds: [...holdout],
    builtAt: Date.now(),
    msTaken: Date.now() - startedAt,
  };
  if (opts.saveFn) await opts.saveFn(profile);
  else await db.foryouProfile.put(profile);
  emit("done", total, total, `画像已建：${train.length} 条样本，${holdoutCount} 条 holdout，${dim} 维`);
  return { profile, sampled: total, holdout: holdoutCount };
}

export async function readForYouProfile(): Promise<ForYouProfileRow | undefined> {
  return db.foryouProfile.get("profile");
}

// ---------------- M4：离线验证 Job（设计 §3.4/§7.3） ----------------

import { embedConfigured } from "@/ai/embeddings";
import { scoreCandidate, scoreVector } from "./score";
import {
  computeThresholdRows,
  loadHoldoutPosts,
  median,
  percentile,
  sampleTimelineNegatives,
  suggestThresholds,
  FORYOU_VALIDATE_MIN_NEGATIVES,
  FORYOU_VALIDATE_SAMPLE_SIZE,
} from "./validate";
import { sampleTextOf } from "@/db/posts";
import type { ForYouMode, ForYouValidationRow } from "./types";

export interface ValidateJobResult {
  validation: ForYouValidationRow;
  /** 负样本不足时为 true：只给正样本分布，不建议阈值。 */
  degraded: boolean;
}

export interface ValidateJobOptions {
  /** 不传时读 xsl 设置（mode / topics / embed / vetoCooldownDays）。 */
  mode?: ForYouMode;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onProgress?: (p: ForYouProfileProgress) => void;
  /** 单测注入：正/负样本、embedding、落库、进度写、设置。 */
  loadPositivesFn?: () => Promise<{ tweet_id: string; text: string; screen_name: string; followed?: boolean | null }[]>;
  loadNegativesFn?: () => Promise<{ tweet_id: string; text: string; screen_name: string; followed?: boolean | null }[]>;
  embedFn?: (texts: string[]) => Promise<number[][]>;
  saveFn?: (row: ForYouValidationRow) => Promise<void>;
  progressFn?: (p: ForYouProfileProgress) => Promise<void> | void;
  settingsFn?: () => Promise<ReturnType<typeof defaultForYouSettings>>;
  profileFn?: () => Promise<ForYouProfileRow | undefined>;
  random?: () => number;
  now?: () => number;
}

type ValidateSample = { tweet_id: string; text: string; screen_name: string; followed?: boolean | null };

/**
 * 离线验证（设计 §3.4）：holdout 正样本 vs timeline 负样本。
 * - hybrid/vector 需要画像 + holdout（≥10 条），否则抛错（请先重建画像）；
 *   画像缺失时自动退回 rule 模式（正样本改用最新书签抽样，并写进 notes）。
 * - 负样本 <100 条时降级：只给正样本分数的中位数/p10，不建议阈值
 *  （suggested 为 null，degraded 为 true），报告照常持久化。
 * - 每个样本用 scoreCandidate 打 final 分（规则分 + 向量分，跟线上同一套
 *   逻辑；反馈 veto 同样扣分，因为线上打分也扣）。
 */
export async function validateJob(opts: ValidateJobOptions = {}): Promise<ValidateJobResult> {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const progressFn = opts.progressFn ?? defaultProgressFn;
  const at = now();
  const emit = (status: ForYouProfileProgress["status"], done: number, total: number, message: string) => {
    const p: ForYouProfileProgress = { job: "validate", status, done, total, message, updated_at: Date.now() };
    opts.onProgress?.(p);
    void progressFn(p);
  };
  const checkCancelled = () => {
    if (opts.signal?.aborted) throw new Error("离线验证已取消");
  };

  emit("running", 0, 0, "读画像与设置…");
  const settings = opts.settingsFn ? await opts.settingsFn() : await readForYouSettings();
  const profile = opts.profileFn ? await opts.profileFn() : await readForYouProfile();
  let mode: ForYouMode = opts.mode ?? settings.mode;
  const notes: string[] = [];
  if (mode !== "rule" && !profile) {
    mode = "rule";
    notes.push("画像未建，退回规则版验证（向量分记 null）。");
  }

  // 正样本：hybrid/vector 用 holdout（不参与质心，防泄漏）；rule 用最新书签抽样。
  emit("running", 0, 0, "取验证正样本…");
  let positives: ValidateSample[];
  if (mode === "rule") {
    positives = opts.loadPositivesFn
      ? await opts.loadPositivesFn()
      : (await sampleBookmarks({ nRecent: 150, nRandom: 150, random })).map((p) => ({
          tweet_id: p.tweet_id,
          text: p.text,
          screen_name: p.screen_name,
        }));
  } else {
    const holdoutIds = profile?.holdoutIds ?? [];
    if (holdoutIds.length < 10) {
      throw new Error("画像没有足够的 holdout 样本（<10 条）：请先重建画像，再做离线验证");
    }
    positives = opts.loadPositivesFn
      ? await opts.loadPositivesFn()
      : (await loadHoldoutPosts(holdoutIds)).map((p) => ({
          tweet_id: p.tweet_id,
          text: sampleTextOf(p),
          screen_name: p.screen_name,
        }));
  }
  positives = positives.slice(0, FORYOU_VALIDATE_SAMPLE_SIZE);
  checkCancelled();
  if (positives.length < 10) throw new Error(`验证正样本不足（${positives.length} 条，至少 10 条）：请先同步书签`);

  emit("running", 0, positives.length, "取验证负样本…");
  const negatives: ValidateSample[] = opts.loadNegativesFn
    ? await opts.loadNegativesFn()
    : (await sampleTimelineNegatives(FORYOU_VALIDATE_SAMPLE_SIZE, random)).map((p) => ({
        tweet_id: p.tweet_id,
        text: sampleTextOf(p),
        screen_name: p.screen_name,
      }));
  checkCancelled();

  const degraded = negatives.length < FORYOU_VALIDATE_MIN_NEGATIVES;
  if (degraded) {
    notes.push(`timeline 负样本只有 ${negatives.length} 条（<${FORYOU_VALIDATE_MIN_NEGATIVES} 条）：只给正样本分布，不建议阈值。请先同步发帖时间线再验证。`);
  }

  // 打分：向量模式整批调一次 embedding（跟 store.js 的 FORYOU_SCORE 同款降级）。
  emit("running", 0, positives.length + negatives.length, "打分中…");
  const all = [...positives, ...negatives];
  const topAuthors =
    profile && Array.isArray(profile.topAuthors) && profile.topAuthors.length
      ? new Set(profile.topAuthors.map((h) => String(h).toLowerCase()))
      : null;
  let embeddings: number[][] | null = null;
  if (mode !== "rule" && profile?.globalCentroid?.length) {
    if (!embedConfigured(settings.embed)) {
      notes.push("embedding 端点未配置（只接受本机地址）：向量分记 null，按规则版打分。");
    } else {
      const embedFn =
        opts.embedFn ?? ((texts: string[]) => embedBatch(settings.embed, texts, opts.fetchImpl, opts.signal));
      try {
        embeddings = await embedFn(all.map((s) => s.text.slice(0, 500)));
      } catch (e) {
        notes.push(`embedding 失败（${String((e as Error)?.message || e).slice(0, 100)}）：向量分记 null，按规则版打分。`);
        embeddings = null;
      }
    }
  }
  checkCancelled();

  const finals: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const vector = embeddings?.[i] ? (scoreVector(embeddings[i], profile)?.score ?? null) : null;
    const scored = scoreCandidate(
      { tweetId: s.tweet_id, handle: s.screen_name, text: s.text, followed: s.followed ?? null },
      {
        topics: settings.topics || [],
        topAuthors,
        medianLikes: profile?.medianLikes ?? null,
        whitelist: false,
        authorVetoes: settings.authorVetoes,
        keywordVetoes: settings.keywordVetoes,
      },
      { mode, bookmarkThreshold: settings.bookmarkThreshold, hideThreshold: settings.hideThreshold, strikeVeto: false },
      vector,
    );
    finals.push(scored.final);
  }
  const posScores = finals.slice(0, positives.length);
  const negScores = finals.slice(positives.length);

  const rows = degraded ? [] : computeThresholdRows(posScores, negScores);
  const suggested = degraded ? null : suggestThresholds(rows);
  if (!degraded && !suggested) notes.push("没有任何阈值组合满足 hide 误杀率 <5%：不建议阈值，请先调话题/画像再验证。");
  const validation: ForYouValidationRow = {
    id: `v-${at}`,
    at,
    mode,
    nPos: positives.length,
    nNeg: negatives.length,
    thresholds: rows,
    suggested,
    degraded,
    posMedian: median(posScores),
    posP10: percentile(posScores, 10),
    notes: notes.join(" "),
  };
  if (opts.saveFn) await opts.saveFn(validation);
  else await db.foryouValidations.put(validation);
  emit(
    "done",
    positives.length + negatives.length,
    positives.length + negatives.length,
    degraded
      ? `验证完成（降级）：正样本 ${positives.length} 条，负样本不足，不建议阈值`
      : suggested
        ? `验证完成：建议收藏 ≥${suggested.bookmark}、折叠 ≤${suggested.hide}`
        : "验证完成：没有满足误杀率要求的阈值组合",
  );
  return { validation, degraded };
}

export async function readLastForYouValidation(): Promise<ForYouValidationRow | undefined> {
  const rows = await db.foryouValidations.orderBy("at").reverse().limit(1).toArray();
  return rows[0];
}
