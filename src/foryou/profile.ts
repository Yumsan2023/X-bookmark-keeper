/**
 * For You 向量版 — 画像计算（M3，设计 §3.3）。
 * 纯函数：computeCentroids 不读库、不发请求，可直接单测。
 * 采样（sampleBookmarks）是唯一读库的部分，放在 src/db/posts.ts。
 */
import type { ForYouProfileRow } from "./types";
import { sampleBookmarks, type SampledBookmark } from "@/db/posts";

export interface ProfileSample {
  id: string;
  /** 文本（已截断 500 字符） */
  text: string;
  tags: string[];
  /** 作者 screen_name（原始大小写） */
  author: string;
  likes: number | null;
  views: number | null;
  /** 入库毫秒时间戳 */
  savedAt: number;
  embedding: number[];
}

export interface CentroidResult {
  globalCentroid: number[];
  tagCentroids: Record<string, number[]>;
  topAuthors: string[];
  medianLikes: number | null;
  medianViews: number | null;
  sampleSize: number;
}

const DAY_MS = 86_400_000;
/** 标签质心：样本里该标签出现 ≥20 次才建（设计 §3.3），取最多的 12 个 */
export const PROFILE_MIN_TAG_COUNT = 20;
export const PROFILE_MAX_TAG_CENTROIDS = 12;
/** 常收藏作者：书签数 ≥10，取 Top 50（设计 §3.3） */
export const PROFILE_MIN_AUTHOR_COUNT = 10;
export const PROFILE_MAX_TOP_AUTHORS = 50;

function weightedMean(vectors: readonly (readonly number[])[], weights: readonly number[]): number[] {
  const dim = vectors[0]?.length ?? 0;
  if (!dim) return [];
  const mean = new Array<number>(dim).fill(0);
  let total = 0;
  for (let i = 0; i < vectors.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    total += w;
    for (let j = 0; j < dim; j++) mean[j] += (vectors[i][j] ?? 0) * w;
  }
  if (total === 0) return mean;
  return mean.map((v) => v / total);
}

export function normalizeVector(vec: readonly number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return [...vec].map(() => 0);
  return [...vec].map((v) => v / norm);
}

function median(values: readonly number[]): number | null {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 时效权重：w = 0.5 ^ ((now - savedAt) / halfLife)，默认半衰期 90 天。 */
export function timeWeight(savedAt: number, halfLifeDays: number, now: number): number {
  const halfLifeMs = Math.max(1, halfLifeDays) * DAY_MS;
  return Math.pow(0.5, Math.max(0, now - savedAt) / halfLifeMs);
}

/**
 * 质心计算（设计 §3.3）：
 * - globalCentroid：全部样本按时效加权平均后 L2 归一化。
 * - tagCentroids：样本里出现 ≥20 次的标签取 Top 12，各自按带该标签的
 *   样本加权平均后归一化。
 * - topAuthors：出现 ≥10 次的作者 Top 50（按次数降序，同次按名字）。
 * - medianLikes / medianViews：样本互动中位数（缺失不计）。
 * 空样本返回全零质心（dim 取 0，调用方按 dim=0 判定画像无效）。
 */
export function computeCentroids(
  samples: readonly ProfileSample[],
  opts: { halfLifeDays?: number; now?: number } = {},
): CentroidResult {
  const now = opts.now ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? 90;
  const weights = samples.map((s) => timeWeight(s.savedAt, halfLifeDays, now));
  const globalCentroid = normalizeVector(weightedMean(samples.map((s) => s.embedding), weights));

  const tagCounts = new Map<string, number>();
  for (const s of samples) {
    for (const tag of new Set(s.tags || [])) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()]
    .filter(([, count]) => count >= PROFILE_MIN_TAG_COUNT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PROFILE_MAX_TAG_CENTROIDS)
    .map(([tag]) => tag);
  const tagCentroids: Record<string, number[]> = {};
  for (const tag of topTags) {
    const idx = samples.map((s, i) => ((s.tags || []).includes(tag) ? i : -1)).filter((i) => i >= 0);
    tagCentroids[tag] = normalizeVector(
      weightedMean(
        idx.map((i) => samples[i].embedding),
        idx.map((i) => weights[i]),
      ),
    );
  }

  const authorCounts = new Map<string, { name: string; count: number }>();
  for (const s of samples) {
    const key = (s.author || "").toLowerCase();
    if (!key) continue;
    const prev = authorCounts.get(key) ?? { name: s.author, count: 0 };
    prev.count += 1;
    authorCounts.set(key, prev);
  }
  const topAuthors = [...authorCounts.values()]
    .filter((a) => a.count >= PROFILE_MIN_AUTHOR_COUNT)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, PROFILE_MAX_TOP_AUTHORS)
    .map((a) => a.name);

  return {
    globalCentroid,
    tagCentroids,
    topAuthors,
    medianLikes: median(samples.map((s) => s.likes).filter((v): v is number => v != null)),
    medianViews: median(samples.map((s) => s.views).filter((v): v is number => v != null)),
    sampleSize: samples.length,
  };
}

/** 画像构建用的样本行：采样帖 + 对应 embedding。 */
export interface BuildProfileSample extends ProfileSample {}

/**
 * 把采样帖转成画像样本（文本已由 sampleBookmarks 截断 500 字符）。
 * embeddings 与 samples 一一对应；长度不一致时抛错（防错位污染画像）。
 */
export function toProfileSamples(sampled: SampledBookmark[], embeddings: number[][]): ProfileSample[] {
  if (sampled.length !== embeddings.length) {
    throw new Error(`embedding 条数不对：采样 ${sampled.length} 条，向量 ${embeddings.length} 条`);
  }
  return sampled.map((p, i) => ({
    id: p.tweet_id,
    text: p.text,
    tags: p.tags ?? [],
    author: p.screen_name,
    likes: p.likes,
    views: p.views,
    savedAt: p.saved_at,
    embedding: embeddings[i],
  }));
}

export type { ForYouProfileRow };
